"""Nexconn Server API client used to issue per-user chat access tokens.

Nexconn's Platform Chat API authenticates every request with a SHA1 signature
built from ``App Secret + Nonce + Timestamp``. The App Secret must never leave
this process; the browser only receives the short-lived per-user access token
returned by ``GET /nexconn/token``.

Contract confirmed against docs.nexconn.ai (Nov 2026):
POST {base}/v4/auth/access-token/issue
  headers: App-Key, Nonce, Timestamp (ms), Signature, Content-Type
  body:    {"userId": "...", "name": "..."}
  result:  {"code": 0, "result": {"userId": "...", "accessToken": "..."}}
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import secrets
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)

DEFAULT_API_BASE_URL = "https://api.sg-light-api.com"
DEFAULT_API_BACKUP_URL = "https://api-b.sg-light-api.com"
ACCESS_TOKEN_PATH = "/v4/auth/access-token/issue"

# Nexconn user IDs accept letters and digits only, up to 64 bytes. Clerk IDs
# contain underscores, so derive a stable, opaque ID instead of storing a map.
USER_ID_PREFIX = "aeg"
USER_ID_HASH_LENGTH = 40

DEFAULT_TIMEOUT_SECONDS = 6.0
DEFAULT_CACHE_SECONDS = 3600.0


class NexconnError(RuntimeError):
    """A safe, user-facing error from Nexconn."""


def _clean(value: str | None) -> str:
    return (value or "").strip()


def _number_from_env(name: str, default: float, minimum: float) -> float:
    raw = _clean(os.getenv(name))
    if not raw:
        return default
    try:
        return max(minimum, float(raw))
    except ValueError:
        return default


def nexconn_public_app_key() -> str:
    """The App Key is required by the Web SDK and is safe to expose."""

    return _clean(os.getenv("NEXCONN_APP_KEY"))


def nexconn_configured() -> bool:
    """True when both Server API credentials are present."""

    return bool(nexconn_public_app_key() and _clean(os.getenv("NEXCONN_APP_SECRET")))


def nexconn_user_id(clerk_user_id: str) -> str:
    """Map a Clerk user ID to a stable Nexconn-compatible user ID."""

    cleaned = _clean(clerk_user_id)
    if not cleaned:
        raise NexconnError("A signed-in user is required to issue a Nexconn token")
    digest = hashlib.sha256(cleaned.encode("utf-8")).hexdigest()
    return f"{USER_ID_PREFIX}{digest[:USER_ID_HASH_LENGTH]}"


def _signature(app_secret: str, nonce: str, timestamp: str) -> str:
    """Signature = SHA1(App Secret + Nonce + Timestamp)."""

    return hashlib.sha1(f"{app_secret}{nonce}{timestamp}".encode("utf-8")).hexdigest()


def _candidate_base_urls() -> list[str]:
    primary = _clean(os.getenv("NEXCONN_API_BASE_URL")) or DEFAULT_API_BASE_URL
    backup = _clean(os.getenv("NEXCONN_API_BACKUP_URL")) or DEFAULT_API_BACKUP_URL
    return list(dict.fromkeys([primary.rstrip("/"), backup.rstrip("/")]))


def _provider_detail(error: HTTPError) -> str:
    """Read a short, non-secret provider explanation for server logs."""

    try:
        body = error.read().decode("utf-8", errors="replace")
    except Exception:
        return ""
    return " ".join(body.split())[:240]


def _post_access_token_request(user_id: str, name: str) -> str:
    app_key = nexconn_public_app_key()
    app_secret = _clean(os.getenv("NEXCONN_APP_SECRET"))
    if not app_key or not app_secret:
        raise NexconnError("Nexconn is not configured for this app yet")

    timeout = _number_from_env("NEXCONN_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS, 1.0)
    payload = json.dumps({"userId": user_id, "name": name}).encode("utf-8")
    last_error: Exception | None = None

    for base_url in _candidate_base_urls():
        nonce = secrets.token_hex(8)  # 16 characters, within Nexconn's 18 max
        timestamp = str(int(time.time() * 1000))
        request = Request(
            f"{base_url}{ACCESS_TOKEN_PATH}",
            data=payload,
            headers={
                "App-Key": app_key,
                "Nonce": nonce,
                "Timestamp": timestamp,
                "Signature": _signature(app_secret, nonce, timestamp),
                "X-Request-ID": secrets.token_hex(8),
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "Aegis/0.1 (+https://nexconn.ai)",
            },
            method="POST",
        )

        try:
            with urlopen(request, timeout=timeout) as response:
                body = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            logger.warning(
                "Nexconn token request failed at %s (HTTP %s) %s",
                base_url,
                error.code,
                _provider_detail(error),
            )
            if error.code >= 500:
                last_error = error
                continue
            raise NexconnError("Nexconn could not issue a messaging token right now") from error
        except (URLError, TimeoutError, OSError) as error:
            logger.warning("Nexconn token request could not reach %s: %s", base_url, type(error).__name__)
            last_error = error
            continue
        except ValueError as error:
            logger.warning("Nexconn returned a non-JSON token response from %s", base_url)
            last_error = error
            continue

        if not isinstance(body, dict):
            logger.warning("Nexconn returned an unexpected token response shape from %s", base_url)
            last_error = ValueError("unexpected token response shape")
            continue

        code = body.get("code")
        result = body.get("result") or {}
        token = _clean(result.get("accessToken"))
        if code != 0 or not token:
            logger.warning(
                "Nexconn rejected the token request code=%s message=%s",
                code,
                _clean(body.get("errorMessage") or body.get("message"))[:240],
            )
            raise NexconnError("Nexconn could not issue a messaging token right now")

        return token

    raise NexconnError(
        "Aegis could not reach Nexconn. Check the internet connection and try again"
    ) from last_error


_token_cache: dict[str, tuple[str, float]] = {}
_token_cache_lock = threading.Lock()


def clear_token_cache() -> None:
    """Drop cached tokens (used by tests and after a configuration change)."""

    with _token_cache_lock:
        _token_cache.clear()


def issue_access_token(
    clerk_user_id: str,
    display_name: str | None = None,
    *,
    force_refresh: bool = False,
) -> dict[str, object]:
    """Return a Nexconn access token for a Clerk user, minting it if needed.

    Tokens are valid until the app's console-configured expiry, so
    ``expires_at`` stays ``None``. The cache TTL only bounds how often AEGIS
    re-requests a token from Nexconn.
    """

    user_id = nexconn_user_id(clerk_user_id)
    cache_seconds = _number_from_env("NEXCONN_TOKEN_CACHE_SECONDS", DEFAULT_CACHE_SECONDS, 0.0)

    if not force_refresh and cache_seconds > 0:
        with _token_cache_lock:
            cached = _token_cache.get(user_id)
        if cached and cached[1] > time.time():
            return {
                "token": cached[0],
                "user_id": user_id,
                "expires_at": None,
                "cached": True,
            }

    name = (_clean(display_name) or "Aegis member")[:64]
    token = _post_access_token_request(user_id, name)

    if cache_seconds > 0:
        with _token_cache_lock:
            _token_cache[user_id] = (token, time.time() + cache_seconds)

    return {
        "token": token,
        "user_id": user_id,
        "expires_at": None,
        "cached": False,
    }
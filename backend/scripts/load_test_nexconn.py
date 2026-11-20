"""Load-test the Nexconn transport AEGIS now depends on.

Phase 5.4 asks for honest performance evidence, not a claim. This script uses
the Nexconn Platform Chat API directly with the App Key/Secret from
``backend/.env`` so it measures the transport that actually carries messages,
with the AEGIS backend out of the path:

1. mint access tokens for N synthetic users, measuring issuance latency;
2. send direct messages round-robin between user pairs, measuring send latency
   and the time until a sentinel message appears in channel history;
3. optionally ping the AEGIS backend once a second and report how many messages
   were delivered while that backend was unreachable.

Point 3 is the Phase 3 claim made concrete: restarting an AEGIS instance cannot
drop a conversation, because no message travels through it. Run the script,
restart the backend while it runs, and the summary shows delivery continuing
through the outage.

Usage (from ``backend``)::

    ./.venv/Scripts/python.exe scripts/load_test_nexconn.py --users 20 --messages 10
    ./.venv/Scripts/python.exe scripts/load_test_nexconn.py --users 10 --messages 20 \
        --aegis-url http://127.0.0.1:8123/health --report ../docs/load-test.json

The script never prints the App Secret. It exits non-zero when any token,
send, or delivery check fails.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import statistics
import sys
import threading
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from dotenv import load_dotenv

BACKEND_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(BACKEND_ROOT / ".env")

DEFAULT_API_BASE_URL = "https://api.sg-light-api.com"
DEFAULT_API_BACKUP_URL = "https://api-b.sg-light-api.com"
TOKEN_PATH = "/v4/auth/access-token/issue"
SEND_PATH = "/v4/direct-channel/message/send"
HISTORY_PATH = "/v4/direct-channel/history-message/list"
TEXT_MESSAGE_TYPE = "RC:TxtMsg"
REQUEST_TIMEOUT_SECONDS = 8.0


class LoadTestError(RuntimeError):
    """A failure that should end the run with a non-zero exit code."""


class HistoryServiceDisabled(RuntimeError):
    """Nexconn's server-side history service is not enabled for this app.

    The browser SDK still reads channel history (the app paginates it), but the
    Platform Chat API answers ``code 1009`` until the history service is turned
    on, so delivery timing has to come from the client in that case.
    """


def _clean(value: str | None) -> str:
    return (value or "").strip()


def _base_urls() -> list[str]:
    primary = _clean(os.getenv("NEXCONN_API_BASE_URL")) or DEFAULT_API_BASE_URL
    backup = _clean(os.getenv("NEXCONN_API_BACKUP_URL")) or DEFAULT_API_BACKUP_URL
    return list(dict.fromkeys([primary.rstrip("/"), backup.rstrip("/")]))


def _signature(app_secret: str, nonce: str, timestamp: str) -> str:
    return hashlib.sha1(f"{app_secret}{nonce}{timestamp}".encode("utf-8")).hexdigest()


def _post(path: str, payload: dict) -> dict:
    """POST a signed Platform Chat API request, retrying the backup domain."""

    app_key = _clean(os.getenv("NEXCONN_APP_KEY"))
    app_secret = _clean(os.getenv("NEXCONN_APP_SECRET"))
    if not app_key or not app_secret:
        raise LoadTestError("NEXCONN_APP_KEY and NEXCONN_APP_SECRET must be set in backend/.env")

    data = json.dumps(payload).encode("utf-8")
    last_error: Exception | None = None

    for base_url in _base_urls():
        nonce = secrets.token_hex(8)
        timestamp = str(int(time.time() * 1000))
        request = Request(
            f"{base_url}{path}",
            data=data,
            headers={
                "App-Key": app_key,
                "Nonce": nonce,
                "Timestamp": timestamp,
                "Signature": _signature(app_secret, nonce, timestamp),
                "X-Request-ID": secrets.token_hex(8),
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "AegisLoadTest/1.0",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            if error.code >= 500:
                last_error = error
                continue
            # Nexconn reports business failures with a JSON body and a non-2xx
            # status, so return the parsed body and let the caller decide.
            try:
                body = json.loads(error.read().decode("utf-8"))
            except (ValueError, OSError):
                body = {}
            if isinstance(body, dict) and body.get("code") is not None:
                return body
            raise LoadTestError(f"{path} rejected with HTTP {error.code}") from error
        except (URLError, TimeoutError, OSError) as error:
            last_error = error
            continue
        except ValueError as error:
            last_error = error
            continue

    raise LoadTestError(f"{path} could not reach Nexconn: {type(last_error).__name__}")


def issue_token(user_id: str, name: str) -> str:
    body = _post(TOKEN_PATH, {"userId": user_id, "name": name})
    token = _clean((body.get("result") or {}).get("accessToken"))
    if body.get("code") != 0 or not token:
        raise LoadTestError(
            f"token issuance for {user_id} failed code={body.get('code')} "
            f"message={_clean(body.get('errorMessage') or body.get('message'))[:160]}"
        )
    return token


def send_message(from_user: str, to_user: str, text: str) -> float:
    started = time.perf_counter()
    body = _post(
        SEND_PATH,
        {
            "fromUserId": from_user,
            "toUserIds": [to_user],
            "messageType": TEXT_MESSAGE_TYPE,
            "content": json.dumps({"text": text}),
            "isEchoToSender": 0,
        },
    )
    elapsed = time.perf_counter() - started
    if body.get("code") != 0:
        raise LoadTestError(
            f"send failed code={body.get('code')} "
            f"message={_clean(body.get('errorMessage') or body.get('message'))[:160]}"
        )
    return elapsed


def history_contains(user_id: str, text: str, window_seconds: int = 300) -> bool:
    """True when a sent message is readable from Nexconn history."""

    now_ms = int(time.time() * 1000)
    body = _post(
        HISTORY_PATH,
        {
            "userId": user_id,
            "channelId": user_id,
            "startAt": now_ms,
            "endAt": now_ms - window_seconds * 1000,
            "pageSize": 100,
            "includeStart": True,
        },
    )
    if body.get("code") == 1009:
        raise HistoryServiceDisabled(
            "Nexconn server history is not enabled for this App Key (code 1009); "
            "delivery timing is read from the browser client instead"
        )
    if body.get("code") != 0:
        raise LoadTestError(
            f"history read failed code={body.get('code')} "
            f"message={_clean(body.get('errorMessage') or body.get('message'))[:160]}"
        )
    return text in json.dumps(body)


def measure_delivery(user_id: str, text: str, timeout: float) -> float | None:
    started = time.monotonic()
    deadline = started + timeout
    while time.monotonic() < deadline:
        if history_contains(user_id, text):
            return time.monotonic() - started
        time.sleep(0.25)
    return None


class BackendWatcher(threading.Thread):
    """Ping the AEGIS backend and record each outage window.

    A count of "messages sent during the outage" is only honest if the windows
    are timestamped, so every failure-to-success transition becomes one entry
    in ``outages`` and the send loop is matched against those windows.
    """

    def __init__(self, url: str):
        super().__init__(daemon=True)
        self.url = url
        self.stop_event = threading.Event()
        self.samples = 0
        self.outages: list[dict[str, float | str]] = []
        self._lock = threading.Lock()
        self._open_started: float | None = None
        self._open_wall: float = 0.0

    def _open(self, started: float) -> None:
        if self._open_started is None:
            self._open_started = started
            self._open_wall = time.time()

    def _close(self, ended: float) -> None:
        if self._open_started is None:
            return
        self.outages.append(
            {
                "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self._open_wall)),
                "started_mono": self._open_started,
                "ended_mono": ended,
                "seconds": round(ended - self._open_started, 1),
            }
        )
        self._open_started = None

    def run(self) -> None:
        while not self.stop_event.is_set():
            started = time.monotonic()
            try:
                with urlopen(self.url, timeout=1.0) as response:
                    response.read(1)
                with self._lock:
                    self._close(time.monotonic())
            except (HTTPError, URLError, TimeoutError, OSError):
                with self._lock:
                    self._open(started)
            self.samples += 1
            self.stop_event.wait(1.0)
        with self._lock:
            self._close(time.monotonic())

    @property
    def down_seconds(self) -> float:
        return round(sum(float(outage["seconds"]) for outage in self.outages), 1)

    def outage_report(self) -> list[dict[str, float | str]]:
        return [
            {key: value for key, value in outage.items() if not key.endswith("_mono")}
            for outage in self.outages
        ]


def _during_outage(
    sends: list[dict[str, float | bool]],
    outages: list[dict[str, float | str]],
) -> tuple[int, int]:
    """Count sends whose lifetime overlapped an outage, and how many succeeded."""

    started = 0
    completed = 0
    for send in sends:
        overlaps = any(
            float(send["started"]) <= float(outage["ended_mono"])
            and float(send["ended"]) >= float(outage["started_mono"])
            for outage in outages
        )
        if not overlaps:
            continue
        started += 1
        if send["ok"]:
            completed += 1
    return started, completed


def _summary(values: list[float]) -> dict[str, float]:
    if not values:
        return {"count": 0}
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int(round(0.95 * (len(ordered) - 1)))))
    return {
        "count": len(values),
        "avg_ms": round(statistics.fmean(ordered) * 1000, 1),
        "p50_ms": round(statistics.median(ordered) * 1000, 1),
        "p95_ms": round(ordered[index] * 1000, 1),
        "max_ms": round(ordered[-1] * 1000, 1),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Nexconn transport load test")
    parser.add_argument("--users", type=int, default=20, help="synthetic users to mint tokens for")
    parser.add_argument("--messages", type=int, default=10, help="messages sent per user pair")
    parser.add_argument("--rate", type=float, default=8.0, help="target sends per second")
    parser.add_argument("--delivery-timeout", type=float, default=15.0, help="seconds to wait for history")
    parser.add_argument("--aegis-url", default="", help="optional /health URL watched during the run")
    parser.add_argument("--report", default="", help="optional JSON report path")
    parser.add_argument("--label", default="", help="label stored in the report")
    arguments = parser.parse_args()

    if arguments.users < 2:
        parser.error("--users must be at least 2 so messages have a recipient")

    users = [f"aegisload{index:04d}" for index in range(arguments.users)]
    pairs = [(users[index], users[index + 1]) for index in range(0, arguments.users - 1, 2)]
    if not pairs:
        pairs = [(users[0], users[1])]

    token_latencies: list[float] = []
    tokens: dict[str, str] = {}
    for user_id in users:
        started = time.perf_counter()
        tokens[user_id] = issue_token(user_id, f"Load {user_id[-4:]}")
        token_latencies.append(time.perf_counter() - started)
    print(f"tokens: {len(tokens)}/{len(users)} issued, p95 {_summary(token_latencies)['p95_ms']} ms")

    watcher = BackendWatcher(arguments.aegis_url) if arguments.aegis_url else None
    if watcher is not None:
        watcher.start()

    sentinel_pair = pairs[0]
    sentinel_text = f"load-sentinel-{int(time.time())}"
    send_message(sentinel_pair[0], sentinel_pair[1], sentinel_text)
    delivery_latency: float | None = None
    history_state = "enabled"
    try:
        delivery_latency = measure_delivery(
            sentinel_pair[1], sentinel_text, arguments.delivery_timeout
        )
    except HistoryServiceDisabled as error:
        history_state = "disabled"
        print(f"delivery: skipped, {error}")
    if delivery_latency is None and history_state == "enabled":
        print("delivery: sentinel never appeared in history within the timeout", file=sys.stderr)
        if watcher is not None:
            watcher.stop_event.set()
        return 1
    if delivery_latency is not None:
        print(f"delivery: sentinel visible in history after {delivery_latency * 1000:.0f} ms")

    send_latencies: list[float] = []
    sends: list[dict[str, float | bool]] = []
    failures = 0
    interval = 1.0 / arguments.rate if arguments.rate > 0 else 0.0
    for index in range(arguments.messages):
        sender, recipient = pairs[index % len(pairs)]
        started = time.monotonic()
        try:
            send_latencies.append(send_message(sender, recipient, f"load-{index}-{int(time.time() * 1000)}"))
            sends.append({"started": started, "ended": time.monotonic(), "ok": True})
        except LoadTestError as error:
            sends.append({"started": started, "ended": time.monotonic(), "ok": False})
            failures += 1
            print(f"send failure {index}: {error}", file=sys.stderr)
        time.sleep(interval)

    if watcher is not None:
        watcher.stop_event.set()
        watcher.join(timeout=2.0)

    report = {
        "label": arguments.label,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "users": arguments.users,
        "pairs": len(pairs),
        "messages_attempted": arguments.messages,
        "messages_failed": failures,
        "token_issuance": _summary(token_latencies),
        "send_latency": _summary(send_latencies),
        "history_service": history_state,
        "first_delivery_latency_ms": (
            round(delivery_latency * 1000, 1) if delivery_latency is not None else None
        ),
    }
    if watcher is not None:
        started_during, completed_during = _during_outage(sends, watcher.outages)
        report["aegis_backend"] = {
            "url": watcher.url,
            "samples": watcher.samples,
            "down_seconds": watcher.down_seconds,
            "outages": watcher.outage_report(),
            "messages_started_during_outage": started_during,
            "messages_completed_during_outage": completed_during,
        }

    print(json.dumps(report, indent=2))
    if arguments.report:
        report_path = Path(arguments.report)
        if not report_path.is_absolute():
            report_path = (BACKEND_ROOT / report_path).resolve()
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(f"report written to {report_path}")

    return 0 if failures == 0 else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except LoadTestError as error:
        print(f"load test failed: {error}", file=sys.stderr)
        raise SystemExit(1)

"""Nexconn token endpoint for authenticated AEGIS users."""

from __future__ import annotations

import logging
import os
import threading
import time
from collections import deque

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel

from services.auth import CurrentUser, get_current_user
from services.nexconn_server import (
    NexconnError,
    issue_access_token,
    nexconn_configured,
    nexconn_public_app_key,
)


router = APIRouter(prefix="/nexconn", tags=["nexconn"])
logger = logging.getLogger(__name__)

_RATE_WINDOW_SECONDS = 60.0
_rate_lock = threading.Lock()
_rate_events: dict[str, deque[float]] = {}


class NexconnTokenResponse(BaseModel):
    token: str
    user_id: str
    app_key: str
    expires_at: str | None = None


def _rate_limit_per_minute() -> int:
    try:
        return max(1, int(os.getenv("NEXCONN_RATE_LIMIT_PER_MINUTE", "12").strip() or "12"))
    except ValueError:
        return 12


def _allow_token_request(user_id: str) -> bool:
    """Simple in-memory token bucket; matches the project's zero-infra rule."""

    limit = _rate_limit_per_minute()
    now = time.monotonic()
    with _rate_lock:
        events = _rate_events.setdefault(user_id, deque())
        while events and now - events[0] >= _RATE_WINDOW_SECONDS:
            events.popleft()
        if len(events) >= limit:
            return False
        events.append(now)
        return True


@router.get("/token", response_model=NexconnTokenResponse)
def get_nexconn_token(
    response: Response,
    refresh: bool = False,
    user: CurrentUser = Depends(get_current_user),
) -> NexconnTokenResponse:
    """Issue a Nexconn access token for the signed-in Clerk user."""

    if not nexconn_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Private messaging is not configured on this server yet.",
        )

    if not _allow_token_request(user.user_id):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many messaging token requests. Wait a moment and try again.",
            headers={"Retry-After": "60"},
        )

    try:
        issued = issue_access_token(user.user_id, user.username, force_refresh=refresh)
    except NexconnError as error:
        logger.warning("Nexconn token issuance failed: %s", error)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(error),
        ) from error

    response.headers["Cache-Control"] = "no-store"
    return NexconnTokenResponse(
        token=str(issued["token"]),
        user_id=str(issued["user_id"]),
        app_key=nexconn_public_app_key(),
        expires_at=issued.get("expires_at") if isinstance(issued.get("expires_at"), str) else None,
    )
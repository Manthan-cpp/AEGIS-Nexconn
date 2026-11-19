"""Authenticated private-message bookkeeping.

Message transport is owned by Nexconn; ``backend/routers/nexconn.py`` issues the
per-user chat tokens. This router keeps only what AEGIS still owns: profiles,
conversation records and the disappearing-message policy.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from services.auth import CurrentUser, get_current_user
from services.direct_messages import (
    DirectMessageError,
    InvalidDisappearingSettings,
    create_conversation,
    list_conversations,
    search_profiles,
    sync_profile,
    update_conversation_settings,
)
from services.nexconn_server import NexconnError, nexconn_user_id


router = APIRouter(prefix="/dm", tags=["direct-messages"])


class ProfileRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    display_name: str | None = Field(default=None, max_length=120)


class ConversationRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64)


class ConversationSettingsRequest(BaseModel):
    enabled: bool
    seconds: int = Field(default=21_600, ge=10)


def _run(action):
    try:
        return action()
    except InvalidDisappearingSettings as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error
    except DirectMessageError as error:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error


def _with_nexconn_id(profile: dict[str, Any]) -> dict[str, Any]:
    """Add the Nexconn user ID the Web SDK needs to open a direct channel."""

    try:
        nexconn_id = nexconn_user_id(str(profile.get("user_id", "")))
    except NexconnError:
        nexconn_id = ""
    return {**profile, "nexconn_user_id": nexconn_id}


@router.post("/profile")
def update_profile(payload: ProfileRequest, user: CurrentUser = Depends(get_current_user)):
    return _with_nexconn_id(_run(lambda: sync_profile(user.user_id, payload.username, payload.display_name)))


@router.get("/users")
def find_users(
    query: str = Query(default="", max_length=64),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict[str, Any]]:
    return [_with_nexconn_id(profile) for profile in _run(lambda: search_profiles(user.user_id, query))]


@router.get("/conversations")
def conversations(user: CurrentUser = Depends(get_current_user)) -> list[dict[str, Any]]:
    return [
        {**conversation, "recipient": _with_nexconn_id(conversation.get("recipient") or {})}
        for conversation in _run(lambda: list_conversations(user.user_id))
    ]


@router.post("/conversations", status_code=status.HTTP_201_CREATED)
def start_conversation(payload: ConversationRequest, user: CurrentUser = Depends(get_current_user)) -> dict[str, Any]:
    conversation = _run(lambda: create_conversation(user.user_id, payload.username))
    return {**conversation, "recipient": _with_nexconn_id(conversation.get("recipient") or {})}


@router.patch("/conversations/{conversation_id}/settings")
def conversation_settings(
    conversation_id: str,
    payload: ConversationSettingsRequest,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    return _run(
        lambda: update_conversation_settings(
            user.user_id,
            conversation_id,
            payload.enabled,
            payload.seconds,
        )
    )

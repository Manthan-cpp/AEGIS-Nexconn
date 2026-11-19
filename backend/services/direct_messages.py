"""MongoDB persistence for authenticated one-to-one Aegis conversations.

Nexconn stores message content, so this module keeps only the data AEGIS still
owns: searchable profiles, the participant pair behind each conversation, and
its disappearing-message policy.
"""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime
from typing import Any

from pymongo.errors import PyMongoError

from services.clerk_directory import find_username_profiles
from services.direct_message_store import (
    DEFAULT_DISAPPEARING_SECONDS,
    LocalDirectMessageStore,
    LocalDirectMessageStoreError,
    MIN_DISAPPEARING_SECONDS,
)
from services.mongo import mark_mongo_unavailable, mongo_database


class DirectMessageError(RuntimeError):
    """A user-facing private-message error."""


class InvalidDisappearingSettings(DirectMessageError):
    """A disappearing-message setting that does not meet the product rules."""


def validate_disappearing_seconds(seconds: int) -> int:
    """Keep disappearing timers at or above the product minimum of 10 seconds."""

    if seconds < MIN_DISAPPEARING_SECONDS:
        raise InvalidDisappearingSettings("Choose a disappearing-message timer of at least 10 seconds.")
    return seconds


def _database():
    try:
        database = mongo_database()
    except PyMongoError:
        # A free Atlas cluster can be briefly unreachable because of DNS,
        # network, or IP allow-list changes. DMs use a durable local store in
        # that case so conversations do not disappear or fail during a demo.
        mark_mongo_unavailable()
        return None
    return database


_local_store = LocalDirectMessageStore()


def _local_result(action):
    try:
        return action()
    except LocalDirectMessageStoreError as error:
        raise DirectMessageError(str(error)) from error


def _sync_directory_profiles_locally(directory_profiles: list[dict[str, str]], user_id: str) -> None:
    for profile in directory_profiles:
        if profile["user_id"] == user_id:
            continue
        try:
            _local_store.sync_profile(profile["user_id"], profile["username"], profile["display_name"])
        except LocalDirectMessageStoreError:
            # A locally saved profile remains usable if Clerk returns a stale
            # duplicate during a temporary provider failure.
            pass


def _collections():
    database = _database()
    if database is None:
        return None
    profiles = database["dm_profiles"]
    conversations = database["dm_conversations"]
    try:
        profiles.create_index("user_id", unique=True)
        profiles.create_index("username_normalized", unique=True)
        conversations.create_index("participant_ids")
        conversations.create_index("updated_at")
    except PyMongoError:
        # Index creation is best-effort on first use; reads and writes still
        # produce a clear database error if Atlas is unavailable.
        pass
    return profiles, conversations


def _iso(value: Any) -> str:
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat()
    return str(value or "")


def _profile(document: dict[str, Any]) -> dict[str, str]:
    return {
        "user_id": str(document.get("user_id", "")),
        "username": str(document.get("username", "")),
        "display_name": str(document.get("display_name") or document.get("username") or "Aegis user"),
    }


def _conversation(document: dict[str, Any], recipient: dict[str, Any], current_user_id: str) -> dict[str, Any]:
    legacy_hours = int(document.get("disappearing_hours", 6))
    disappearing_seconds = int(
        document.get("disappearing_seconds", legacy_hours * 60 * 60)
    )
    return {
        "conversation_id": str(document.get("conversation_id", document.get("_id", ""))),
        "recipient": _profile(recipient),
        "last_message": str(document.get("last_message", "")),
        "last_sender_id": str(document.get("last_sender_id", "")),
        "updated_at": _iso(document.get("updated_at")),
        "is_last_message_from_me": str(document.get("last_sender_id", "")) == current_user_id,
        "disappearing_enabled": bool(document.get("disappearing_enabled", False)),
        "disappearing_seconds": disappearing_seconds,
    }


def sync_profile(user_id: str, username: str, display_name: str | None = None) -> dict[str, str]:
    clean_username = username.strip()
    normalized = clean_username.casefold()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{2,63}", clean_username):
        raise DirectMessageError("Your Clerk username must contain at least 3 letters or numbers.")

    collections = _collections()
    if collections is None:
        return _local_result(lambda: _local_store.sync_profile(user_id, clean_username, display_name))
    profiles, _ = collections
    document = {
        "user_id": user_id,
        "username": clean_username,
        "username_normalized": normalized,
        "display_name": (display_name or clean_username).strip()[:120] or clean_username,
        "updated_at": datetime.now(UTC),
    }
    try:
        profiles.update_one({"user_id": user_id}, {"$set": document, "$setOnInsert": {"created_at": datetime.now(UTC)}}, upsert=True)
        saved = profiles.find_one({"user_id": user_id}) or document
    except PyMongoError as error:
        mark_mongo_unavailable()
        if getattr(error, "code", None) == 11000:
            raise DirectMessageError("That username is already being used by another Aegis account.") from error
        return _local_result(lambda: _local_store.sync_profile(user_id, clean_username, display_name))
    return _profile(saved)


def search_profiles(user_id: str, query: str, limit: int = 20) -> list[dict[str, str]]:
    collections = _collections()
    if collections is None:
        local_matches = _local_result(lambda: _local_store.search_profiles(user_id, query, limit))
        if local_matches:
            return local_matches
        directory_profiles = find_username_profiles(query, limit)
        _sync_directory_profiles_locally(directory_profiles, user_id)
        return _local_result(lambda: _local_store.search_profiles(user_id, query, limit))
    profiles, _ = collections
    normalized_query = query.strip().casefold()
    compact_query = re.sub(r"[\s_.-]+", "", normalized_query)
    filters: dict[str, Any] = {"user_id": {"$ne": user_id}}
    if compact_query:
        filters["username_normalized"] = {"$regex": re.escape(compact_query)}
    try:
        local_matches = [_profile(document) for document in profiles.find(filters).sort("username_normalized", 1).limit(limit)]
    except PyMongoError:
        mark_mongo_unavailable()
        local_matches = _local_result(lambda: _local_store.search_profiles(user_id, query, limit))
    if local_matches:
        return local_matches

    # Only query Clerk when the already-synced directory has no match. This
    # preserves discovery for accounts created elsewhere while keeping normal
    # searches and message flows local and immediate.
    directory_profiles = find_username_profiles(query, limit)
    _sync_directory_profiles_locally(directory_profiles, user_id)
    for profile in directory_profiles:
        if profile["user_id"] == user_id:
            continue
        try:
            profiles.update_one(
                {"user_id": profile["user_id"]},
                {
                    "$set": {
                        "user_id": profile["user_id"],
                        "username": profile["username"],
                        "username_normalized": profile["username"].casefold(),
                        "display_name": profile["display_name"][:120],
                        "updated_at": datetime.now(UTC),
                    },
                    "$setOnInsert": {"created_at": datetime.now(UTC)},
                },
                upsert=True,
            )
        except PyMongoError:
            mark_mongo_unavailable()
            break
    return _local_result(lambda: _local_store.search_profiles(user_id, query, limit))


def _find_participant(conversation: dict[str, Any], user_id: str) -> None:
    if user_id not in conversation.get("participant_ids", []):
        raise DirectMessageError("You do not have access to this conversation.")


def create_conversation(user_id: str, recipient_username: str) -> dict[str, Any]:
    collections = _collections()
    if collections is None:
        return _local_result(lambda: _local_store.create_conversation(user_id, recipient_username))
    profiles, conversations = collections
    try:
        target = profiles.find_one({"username_normalized": recipient_username.strip().casefold()})
    except PyMongoError:
        mark_mongo_unavailable()
        directory_profiles = find_username_profiles(recipient_username, 1)
        _sync_directory_profiles_locally(directory_profiles, user_id)
        return _local_result(lambda: _local_store.create_conversation(user_id, recipient_username))
    if not target:
        directory_profiles = find_username_profiles(recipient_username, 1)
        _sync_directory_profiles_locally(directory_profiles, user_id)
        try:
            target = profiles.find_one({"username_normalized": recipient_username.strip().casefold()})
        except PyMongoError:
            mark_mongo_unavailable()
            return _local_result(lambda: _local_store.create_conversation(user_id, recipient_username))
        if not target:
            return _local_result(lambda: _local_store.create_conversation(user_id, recipient_username))
    target_id = str(target.get("user_id", ""))
    if not target_id or target_id == user_id:
        raise DirectMessageError("Choose another signed-in user to start a conversation.")

    participant_ids = sorted([user_id, target_id])
    try:
        existing = conversations.find_one({"participant_ids": participant_ids})
        if existing:
            return _conversation(existing, target, user_id)
        now = datetime.now(UTC)
        document = {
            "conversation_id": uuid.uuid4().hex,
            "participant_ids": participant_ids,
            "created_at": now,
            "updated_at": now,
            "disappearing_enabled": False,
            "disappearing_seconds": DEFAULT_DISAPPEARING_SECONDS,
        }
        conversations.insert_one(document)
        return _conversation(document, target, user_id)
    except PyMongoError:
        mark_mongo_unavailable()
        return _local_result(lambda: _local_store.create_conversation(user_id, recipient_username))


def list_conversations(user_id: str) -> list[dict[str, Any]]:
    collections = _collections()
    if collections is None:
        return _local_result(lambda: _local_store.list_conversations(user_id))
    profiles, conversations = collections
    try:
        documents = conversations.find({"participant_ids": user_id}).sort("updated_at", -1).limit(50)
        result = []
        for document in documents:
            participant_ids = [str(value) for value in document.get("participant_ids", [])]
            recipient_id = next((value for value in participant_ids if value != user_id), "")
            recipient = profiles.find_one({"user_id": recipient_id}) or {
                "user_id": recipient_id,
                "username": "Aegis user",
                "display_name": "Aegis user",
            }
            result.append(_conversation(document, recipient, user_id))
        return result
    except PyMongoError:
        mark_mongo_unavailable()
        return _local_result(lambda: _local_store.list_conversations(user_id))


def update_conversation_settings(
    user_id: str,
    conversation_id: str,
    enabled: bool,
    seconds: int,
) -> dict[str, Any]:
    validated_seconds = validate_disappearing_seconds(seconds)
    collections = _collections()
    if collections is None:
        return _local_result(
            lambda: _local_store.update_settings(user_id, conversation_id, enabled, validated_seconds)
        )

    _, conversations = collections
    try:
        conversation = conversations.find_one({"conversation_id": conversation_id})
        if not conversation:
            raise DirectMessageError("That conversation no longer exists.")
        _find_participant(conversation, user_id)
        conversations.update_one(
            {"conversation_id": conversation_id},
            {
                "$set": {
                    "disappearing_enabled": bool(enabled),
                    # Keep the old field populated for documents or clients
                    # created before timer values moved from hours to seconds.
                    "disappearing_hours": max(1, (validated_seconds + 3599) // 3600),
                    "disappearing_seconds": validated_seconds,
                }
            },
        )
        return {
            "conversation_id": conversation_id,
            "disappearing_enabled": bool(enabled),
            "disappearing_seconds": validated_seconds,
        }
    except DirectMessageError:
        raise
    except PyMongoError:
        mark_mongo_unavailable()
        return _local_result(
            lambda: _local_store.update_settings(user_id, conversation_id, enabled, validated_seconds)
        )

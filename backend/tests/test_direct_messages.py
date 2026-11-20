import copy
from pathlib import Path
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient
from pymongo.errors import PyMongoError

from main import app
from services.auth import CurrentUser, get_current_user
from services.direct_message_store import LocalDirectMessageStore
from services.nexconn_server import nexconn_user_id


class FakeCursor:
    def __init__(self, documents):
        self.documents = documents

    def sort(self, field, direction):
        self.documents.sort(key=lambda item: item.get(field, ""), reverse=direction < 0)
        return self

    def limit(self, amount):
        self.documents = self.documents[:amount]
        return self

    def __iter__(self):
        return iter(copy.deepcopy(self.documents))


class FakeCollection:
    def __init__(self):
        self.documents = []

    def create_index(self, *_args, **_kwargs):
        return None

    @staticmethod
    def matches(document, filters):
        for field, expected in filters.items():
            actual = document.get(field)
            if isinstance(expected, dict) and "$ne" in expected:
                if actual == expected["$ne"]:
                    return False
            elif isinstance(expected, dict) and "$regex" in expected:
                import re

                if not re.search(expected["$regex"], str(actual or "")):
                    return False
            elif isinstance(expected, dict) and "$in" in expected:
                if actual not in expected["$in"]:
                    return False
            elif isinstance(actual, list) and not isinstance(expected, list):
                if expected not in actual:
                    return False
            elif actual != expected:
                return False
        return True

    def find_one(self, filters):
        return copy.deepcopy(next((item for item in self.documents if self.matches(item, filters)), None))

    def find(self, filters):
        return FakeCursor([item for item in self.documents if self.matches(item, filters)])

    def update_one(self, filters, update, upsert=False):
        document = next((item for item in self.documents if self.matches(item, filters)), None)
        if document is None:
            if not upsert:
                return None
            document = {key: value for key, value in filters.items() if not isinstance(value, dict)}
            self.documents.append(document)
        document.update(update.get("$set", {}))
        if not document.get("created_at"):
            document.update(update.get("$setOnInsert", {}))
        return None

    def insert_one(self, document):
        self.documents.append(copy.deepcopy(document))
        return None


class FakeDatabase:
    def __init__(self):
        self.collections = {}

    def __getitem__(self, name):
        self.collections.setdefault(name, FakeCollection())
        return self.collections[name]


class FailingSearchCollection(FakeCollection):
    def find(self, _filters):
        raise PyMongoError("simulated query failure")


class FailingSearchDatabase(FakeDatabase):
    def __getitem__(self, name):
        if name == "dm_profiles":
            self.collections.setdefault(name, FailingSearchCollection())
        else:
            self.collections.setdefault(name, FakeCollection())
        return self.collections[name]


class DirectMessageApiTests(unittest.TestCase):
    def tearDown(self):
        app.dependency_overrides.clear()

    def test_private_messages_require_sign_in(self):
        with TestClient(app) as client:
            response = client.get("/dm/conversations")

        self.assertEqual(response.status_code, 401)
        self.assertIn("Sign in", response.json()["detail"])

    def test_conversations_expose_nexconn_ids_for_both_participants(self):
        database = FakeDatabase()
        current_user = {"value": CurrentUser("user_a", "alice")}
        app.dependency_overrides[get_current_user] = lambda: current_user["value"]

        with patch("services.direct_messages.mongo_database", return_value=database), TestClient(app) as client:
            alice_profile = client.post("/dm/profile", json={"username": "alice", "display_name": "Alice"})
            current_user["value"] = CurrentUser("user_b", "bob")
            bob_profile = client.post("/dm/profile", json={"username": "bob", "display_name": "Bob"})
            self.assertEqual(alice_profile.status_code, 200)
            self.assertEqual(bob_profile.status_code, 200)
            self.assertEqual(alice_profile.json()["nexconn_user_id"], nexconn_user_id("user_a"))

            current_user["value"] = CurrentUser("user_a", "alice")
            search = client.get("/dm/users", params={"query": "bob"})
            conversation = client.post("/dm/conversations", json={"username": "bob"})
            listed = client.get("/dm/conversations")

            self.assertEqual(search.status_code, 200)
            self.assertEqual(search.json()[0]["username"], "bob")
            self.assertEqual(search.json()[0]["nexconn_user_id"], nexconn_user_id("user_b"))
            self.assertEqual(conversation.status_code, 201)
            self.assertEqual(conversation.json()["recipient"]["nexconn_user_id"], nexconn_user_id("user_b"))
            self.assertEqual(listed.status_code, 200)
            self.assertEqual(len(listed.json()), 1)
            self.assertEqual(listed.json()[0]["recipient"]["nexconn_user_id"], nexconn_user_id("user_b"))

            current_user["value"] = CurrentUser("user_b", "bob")
            bob_side = client.get("/dm/conversations")

        self.assertEqual(bob_side.status_code, 200)
        self.assertEqual(bob_side.json()[0]["recipient"]["nexconn_user_id"], nexconn_user_id("user_a"))

    def test_conversation_settings_are_saved_in_mongo_path(self):
        database = FakeDatabase()
        current_user = {"value": CurrentUser("user_admin", "Admin")}
        app.dependency_overrides[get_current_user] = lambda: current_user["value"]

        with patch("services.direct_messages.mongo_database", return_value=database), TestClient(app) as client:
            client.post("/dm/profile", json={"username": "Admin"})
            current_user["value"] = CurrentUser("user_test_a", "testA")
            client.post("/dm/profile", json={"username": "testA"})
            current_user["value"] = CurrentUser("user_admin", "Admin")
            conversation = client.post("/dm/conversations", json={"username": "testA"})
            conversation_id = conversation.json()["conversation_id"]
            settings = client.patch(
                f"/dm/conversations/{conversation_id}/settings",
                json={"enabled": True, "seconds": 36_000},
            )
            rejected = client.patch(
                f"/dm/conversations/{conversation_id}/settings",
                json={"enabled": True, "seconds": 5},
            )

        self.assertEqual(settings.status_code, 200)
        self.assertTrue(settings.json()["disappearing_enabled"])
        self.assertEqual(settings.json()["disappearing_seconds"], 36_000)
        self.assertEqual(rejected.status_code, 422)

    def test_private_messages_use_durable_local_store_when_mongo_is_unavailable(self):
        current_user = {"value": CurrentUser("user_admin", "Admin")}
        app.dependency_overrides[get_current_user] = lambda: current_user["value"]

        with TemporaryDirectory() as directory:
            database_path = Path(directory) / "direct_messages.sqlite3"
            local_store = LocalDirectMessageStore(database_path)
            with patch("services.direct_messages.mongo_database", return_value=None), patch(
                "services.direct_messages._local_store", local_store
            ), TestClient(app) as client:
                self.assertEqual(
                    client.post("/dm/profile", json={"username": "Admin"}).status_code,
                    200,
                )
                current_user["value"] = CurrentUser("user_test_a", "testA")
                self.assertEqual(
                    client.post("/dm/profile", json={"username": "testA"}).status_code,
                    200,
                )
                current_user["value"] = CurrentUser("user_admin", "Admin")
                search = client.get("/dm/users", params={"query": "testA"})
                conversation = client.post("/dm/conversations", json={"username": "testA"})
                conversation_id = conversation.json()["conversation_id"]
                settings = client.patch(
                    f"/dm/conversations/{conversation_id}/settings",
                    json={"enabled": True, "seconds": 21_600},
                )

            reloaded_store = LocalDirectMessageStore(database_path)
            reloaded_conversations = reloaded_store.list_conversations("user_admin")

        self.assertEqual(search.status_code, 200)
        self.assertEqual(search.json()[0]["username"], "testA")
        self.assertEqual(search.json()[0]["nexconn_user_id"], nexconn_user_id("user_test_a"))
        self.assertEqual(settings.status_code, 200)
        self.assertTrue(reloaded_conversations[0]["disappearing_enabled"])
        self.assertEqual(reloaded_conversations[0]["disappearing_seconds"], 21_600)

    def test_username_search_imports_existing_clerk_profiles(self):
        current_user = {"value": CurrentUser("user_admin", "Admin")}
        app.dependency_overrides[get_current_user] = lambda: current_user["value"]

        with TemporaryDirectory() as directory:
            local_store = LocalDirectMessageStore(Path(directory) / "direct_messages.sqlite3")
            clerk_profiles = [{"user_id": "user_test_a", "username": "testA", "display_name": "Test A"}]
            with patch("services.direct_messages.mongo_database", return_value=None), patch(
                "services.direct_messages._local_store", local_store
            ), patch("services.direct_messages.find_username_profiles", return_value=clerk_profiles), TestClient(app) as client:
                client.post("/dm/profile", json={"username": "Admin"})
                search = client.get("/dm/users", params={"query": "testA"})

        self.assertEqual(search.status_code, 200)
        self.assertEqual(search.json()[0]["username"], "testA")

    def test_search_accepts_display_style_username_with_spaces(self):
        current_user = {"value": CurrentUser("user_admin", "Admin")}
        app.dependency_overrides[get_current_user] = lambda: current_user["value"]

        with TemporaryDirectory() as directory:
            local_store = LocalDirectMessageStore(Path(directory) / "direct_messages.sqlite3")
            local_store.sync_profile("user_admin", "admin", "Admin")
            local_store.sync_profile("user_test_a", "testa", "Test A")
            with patch("services.direct_messages.mongo_database", return_value=None), patch(
                "services.direct_messages._local_store", local_store
            ), patch("services.direct_messages.find_username_profiles", return_value=[]), TestClient(app) as client:
                search = client.get("/dm/users", params={"query": "test A"})

        self.assertEqual(search.status_code, 200)
        self.assertEqual(search.json()[0]["username"], "testa")

    def test_call_authorization_allows_an_existing_conversation(self):
        database = FakeDatabase()
        current_user = {"value": CurrentUser("user_admin", "Admin")}
        app.dependency_overrides[get_current_user] = lambda: current_user["value"]

        with patch("services.direct_messages.mongo_database", return_value=database), TestClient(app) as client:
            client.post("/dm/profile", json={"username": "Admin"})
            current_user["value"] = CurrentUser("user_test_a", "testA")
            client.post("/dm/profile", json={"username": "testA"})
            current_user["value"] = CurrentUser("user_admin", "Admin")
            conversation = client.post("/dm/conversations", json={"username": "testA"})
            allowed = client.get(
                "/nexconn/calls/authorize",
                params={"peer_id": nexconn_user_id("user_test_a")},
            )

        self.assertEqual(allowed.status_code, 200)
        self.assertTrue(allowed.json()["allowed"])
        self.assertEqual(allowed.json()["conversation_id"], conversation.json()["conversation_id"])
        self.assertEqual(allowed.headers["cache-control"], "no-store")

    def test_call_authorization_rejects_a_stranger(self):
        database = FakeDatabase()
        current_user = {"value": CurrentUser("user_admin", "Admin")}
        app.dependency_overrides[get_current_user] = lambda: current_user["value"]

        with patch("services.direct_messages.mongo_database", return_value=database), TestClient(app) as client:
            client.post("/dm/profile", json={"username": "Admin"})
            denied = client.get(
                "/nexconn/calls/authorize",
                params={"peer_id": nexconn_user_id("user_stranger")},
            )

        self.assertEqual(denied.status_code, 403)
        self.assertIn("conversation", denied.json()["detail"])

    def test_search_falls_back_when_mongo_fails_during_find(self):
        current_user = {"value": CurrentUser("user_admin", "admin")}
        app.dependency_overrides[get_current_user] = lambda: current_user["value"]

        with TemporaryDirectory() as directory:
            local_store = LocalDirectMessageStore(Path(directory) / "direct_messages.sqlite3")
            local_store.sync_profile("user_admin", "admin", "Admin")
            local_store.sync_profile("user_test_a", "testa", "Test A")
            with patch("services.direct_messages.mongo_database", return_value=FailingSearchDatabase()), patch(
                "services.direct_messages._local_store", local_store
            ), patch("services.direct_messages.find_username_profiles", return_value=[]), TestClient(app) as client:
                search = client.get("/dm/users", params={"query": "testA"})

        self.assertEqual(search.status_code, 200)
        self.assertEqual(search.json()[0]["username"], "testa")


if __name__ == "__main__":
    unittest.main()

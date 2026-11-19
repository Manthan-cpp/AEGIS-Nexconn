import hashlib
import json
import os
import unittest
from unittest.mock import patch
from urllib.error import URLError

from fastapi.testclient import TestClient

os.environ["MONGODB_URI"] = ""

from main import app  # noqa: E402
from routers import nexconn as nexconn_router  # noqa: E402
from services import nexconn_server  # noqa: E402
from services.auth import CurrentUser, get_current_user  # noqa: E402
from services.nexconn_server import NexconnError  # noqa: E402

CONFIGURED_ENV = {
    "NEXCONN_APP_KEY": "test-app-key",
    "NEXCONN_APP_SECRET": "test-app-secret",
    "NEXCONN_API_BASE_URL": "https://api.sg-light-api.com",
    "NEXCONN_API_BACKUP_URL": "https://api-b.sg-light-api.com",
    "NEXCONN_TOKEN_CACHE_SECONDS": "3600",
}


class _FakeResponse:
    def __init__(self, payload: dict):
        self._body = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def read(self):
        return self._body


def _reset_state():
    nexconn_server.clear_token_cache()
    nexconn_router._rate_events.clear()


class NexconnUserIdTests(unittest.TestCase):
    def test_user_id_is_stable_nexconn_safe_and_unique(self):
        first = nexconn_server.nexconn_user_id("user_2abc")
        second = nexconn_server.nexconn_user_id("user_2abc")
        other = nexconn_server.nexconn_user_id("user_2xyz")

        self.assertEqual(first, second)
        self.assertNotEqual(first, other)
        self.assertTrue(first.isalnum())
        self.assertLessEqual(len(first.encode("utf-8")), 64)

    def test_empty_user_id_is_rejected(self):
        with self.assertRaises(NexconnError):
            nexconn_server.nexconn_user_id("   ")


class NexconnServerTests(unittest.TestCase):
    def setUp(self):
        _reset_state()

    @patch("services.nexconn_server.urlopen")
    def test_token_request_is_signed_per_nexconn_contract(self, open_url):
        open_url.return_value = _FakeResponse(
            {"code": 0, "result": {"userId": "server-id", "accessToken": "token-1"}}
        )

        with patch.dict(os.environ, CONFIGURED_ENV, clear=False):
            issued = nexconn_server.issue_access_token("user_abc", "Manthan")

        request = open_url.call_args.args[0]
        headers = {key.lower(): value for key, value in request.header_items()}
        expected_signature = hashlib.sha1(
            f"test-app-secret{headers['nonce']}{headers['timestamp']}".encode("utf-8")
        ).hexdigest()

        self.assertEqual(headers["app-key"], "test-app-key")
        self.assertEqual(headers["signature"], expected_signature)
        self.assertLessEqual(len(headers["nonce"]), 18)
        self.assertTrue(headers["timestamp"].isdigit())
        self.assertEqual(
            request.get_full_url(),
            "https://api.sg-light-api.com/v4/auth/access-token/issue",
        )

        payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual(payload["userId"], issued["user_id"])
        self.assertEqual(payload["name"], "Manthan")
        self.assertEqual(issued["token"], "token-1")
        self.assertIsNone(issued["expires_at"])

    @patch("services.nexconn_server.urlopen")
    def test_minted_token_is_cached_between_calls(self, open_url):
        open_url.return_value = _FakeResponse(
            {"code": 0, "result": {"userId": "server-id", "accessToken": "token-1"}}
        )

        with patch.dict(os.environ, CONFIGURED_ENV, clear=False):
            first = nexconn_server.issue_access_token("user_abc", "Manthan")
            second = nexconn_server.issue_access_token("user_abc", "Manthan")

        self.assertEqual(open_url.call_count, 1)
        self.assertFalse(first["cached"])
        self.assertTrue(second["cached"])

    @patch("services.nexconn_server.urlopen")
    def test_force_refresh_bypasses_the_token_cache(self, open_url):
        open_url.return_value = _FakeResponse(
            {"code": 0, "result": {"userId": "server-id", "accessToken": "token-1"}}
        )

        with patch.dict(os.environ, CONFIGURED_ENV, clear=False):
            nexconn_server.issue_access_token("user_abc", "Manthan")
            nexconn_server.issue_access_token("user_abc", "Manthan", force_refresh=True)

        self.assertEqual(open_url.call_count, 2)

    @patch("services.nexconn_server.urlopen")
    def test_provider_error_code_becomes_a_safe_nexconn_error(self, open_url):
        open_url.return_value = _FakeResponse({"code": 1003, "errorMessage": "invalid signature"})

        with patch.dict(os.environ, CONFIGURED_ENV, clear=False):
            with self.assertRaises(NexconnError) as raised:
                nexconn_server.issue_access_token("user_abc", "Manthan")

        self.assertNotIn("invalid signature", str(raised.exception))

    @patch("services.nexconn_server.urlopen")
    def test_primary_domain_failure_falls_back_to_backup(self, open_url):
        open_url.side_effect = [
            URLError("primary down"),
            _FakeResponse({"code": 0, "result": {"userId": "server-id", "accessToken": "token-2"}}),
        ]

        with patch.dict(os.environ, CONFIGURED_ENV, clear=False):
            issued = nexconn_server.issue_access_token("user_abc", "Manthan")

        self.assertEqual(issued["token"], "token-2")
        self.assertEqual(open_url.call_count, 2)
        self.assertEqual(
            open_url.call_args.args[0].get_full_url(),
            "https://api-b.sg-light-api.com/v4/auth/access-token/issue",
        )

    def test_missing_credentials_are_reported_before_any_http_call(self):
        with patch.dict(os.environ, {"NEXCONN_APP_KEY": "", "NEXCONN_APP_SECRET": ""}, clear=False):
            with self.assertRaises(NexconnError):
                nexconn_server.issue_access_token("user_abc", "Manthan")


class NexconnTokenEndpointTests(unittest.TestCase):
    def setUp(self):
        _reset_state()
        app.dependency_overrides[get_current_user] = lambda: CurrentUser(
            user_id="user_test", username="Tester"
        )

    def tearDown(self):
        app.dependency_overrides.clear()

    def test_unauthenticated_request_is_rejected(self):
        app.dependency_overrides.clear()
        response = TestClient(app).get("/nexconn/token")
        self.assertEqual(response.status_code, 401)

    def test_missing_configuration_returns_503(self):
        with patch.dict(os.environ, {"NEXCONN_APP_KEY": "", "NEXCONN_APP_SECRET": ""}, clear=False):
            response = TestClient(app).get("/nexconn/token")

        self.assertEqual(response.status_code, 503)
        self.assertIn("not configured", response.json()["detail"])

    @patch("services.nexconn_server.urlopen")
    def test_authenticated_request_returns_a_token(self, open_url):
        open_url.return_value = _FakeResponse(
            {"code": 0, "result": {"userId": "server-id", "accessToken": "token-1"}}
        )

        with patch.dict(os.environ, CONFIGURED_ENV, clear=False):
            response = TestClient(app).get("/nexconn/token")

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["token"], "token-1")
        self.assertEqual(body["app_key"], "test-app-key")
        self.assertEqual(body["user_id"], nexconn_server.nexconn_user_id("user_test"))
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_rate_limit_rejects_a_retry_loop(self):
        with patch.dict(
            os.environ,
            {**CONFIGURED_ENV, "NEXCONN_RATE_LIMIT_PER_MINUTE": "1"},
            clear=False,
        ), patch(
            "routers.nexconn.issue_access_token",
            return_value={"token": "token-1", "user_id": "server-id", "expires_at": None, "cached": False},
        ):
            client = TestClient(app)
            first = client.get("/nexconn/token")
            second = client.get("/nexconn/token")

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 429)
        self.assertEqual(second.headers["retry-after"], "60")

    def test_health_reports_whether_nexconn_is_configured(self):
        with patch.dict(os.environ, {"NEXCONN_APP_KEY": "", "NEXCONN_APP_SECRET": ""}, clear=False):
            unconfigured = TestClient(app).get("/health").json()
        with patch.dict(os.environ, CONFIGURED_ENV, clear=False):
            configured = TestClient(app).get("/health").json()

        self.assertFalse(unconfigured["nexconn_configured"])
        self.assertTrue(configured["nexconn_configured"])


if __name__ == "__main__":
    unittest.main()
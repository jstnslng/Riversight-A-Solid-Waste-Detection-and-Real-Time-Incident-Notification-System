"""Offline security tests: no Firebase, private files or camera connections."""
import io
import json
import os
import threading
import time
import unittest
from unittest.mock import Mock, patch

from firebase_access import AccessDenied, FirebaseAccess, GuardedStream, secure_application
from production_server import application_for
import segmentation_feed as feed


class AccessTests(unittest.TestCase):
    def setUp(self):
        self.user = {"role": "Monitoring", "status": "Active"}
        self.grant = {"enabled": True}
        self.verify = Mock(return_value={"uid": "user-1", "exp": time.time() + 300})
        self.access = FirebaseAccess(self.verify, lambda path: self.user if path.startswith("users/") else self.grant)
        self.state = feed.StreamingFrame("camera-1", 10, 2, threading.Event())
        self.state.publish_raw(b"jpeg", time.monotonic())
        self.state.publish_result(b"evidence", 0, "now")
        origins, hosts = ("https://frontend.invalid",), ("backend.invalid",)
        self.app = secure_application(application_for(self.state, origins, "127.0.0.1", 5001, hosts),
                                      self.access, "camera-1", origins, hosts)

    def request(self, path, **values):
        env = dict(PATH_INFO=path, REQUEST_METHOD="GET", HTTP_HOST="backend.invalid",
                   HTTP_ORIGIN="https://frontend.invalid", QUERY_STRING="cameraDocId=camera-1",
                   HTTP_AUTHORIZATION="Bearer verified-token")
        env.update(values)
        result = []
        body = self.app(env, lambda status, headers: result.append((status, dict(headers))))
        return result[0], body

    def ticket(self):
        (_, _), body = self.request("/stream-ticket", REQUEST_METHOD="POST")
        return json.loads(b"".join(body))["ticket"]

    def test_public_health_is_minimal_and_camera_routes_require_auth(self):
        self.assertEqual(json.loads(b"".join(self.request("/health", HTTP_AUTHORIZATION="")[1])), {"status": "alive"})
        self.verify.assert_not_called()
        for path in ("/feed-health", "/latest-segmentation.jpg", "/segmentation-stream.mjpg", "/stream-ticket"):
            method = "POST" if path == "/stream-ticket" else "GET"
            self.assertEqual(self.request(path, REQUEST_METHOD=method, HTTP_AUTHORIZATION="")[0][0], "401 Unauthorized")

    def test_wrong_origin_host_camera_and_query_token_are_denied(self):
        for values in ({"HTTP_HOST": "evil.invalid"}, {"HTTP_ORIGIN": "https://evil.invalid"},
                       {"QUERY_STRING": "cameraDocId=other"},
                       {"QUERY_STRING": "cameraDocId=camera-1&cameraDocId=camera-1"}):
            self.assertEqual(self.request("/feed-health", **values)[0][0], "403 Forbidden")
        self.assertEqual(self.request("/feed-health", HTTP_AUTHORIZATION="",
                                     QUERY_STRING="cameraDocId=camera-1&token=verified-token")[0][0], "401 Unauthorized")
        self.verify.assert_not_called()

    def test_invalid_revoked_expired_token_and_database_outage_fail_closed(self):
        self.verify.side_effect = RuntimeError("sensitive token error")
        self.assertEqual(self.request("/feed-health")[0][0], "403 Forbidden")
        self.verify.side_effect = None
        self.verify.return_value = {"uid": "user-1", "exp": time.time() - 1}
        self.assertEqual(self.request("/latest-segmentation.jpg")[0][0], "403 Forbidden")
        self.verify.return_value = {"uid": "user-1", "exp": time.time() + 300}
        with patch.object(self.access, "read", side_effect=RuntimeError("private database error")):
            self.assertEqual(self.request("/feed-health")[0][0], "403 Forbidden")

    def test_roles_status_and_explicit_grants_including_admin(self):
        for role in ("Monitoring", "Monitoring Personnel", "Administrator"):
            self.user = {"role": role, "status": "Active"}
            self.assertEqual(self.request("/feed-health")[0][0], "200 OK")
            self.grant = {}
            self.assertEqual(self.request("/feed-health")[0][0], "403 Forbidden")
            self.grant = {"enabled": True}
        for user in ({}, {"role": "User", "status": "Active"}, {"role": "Administrator", "status": "inactive"},
                     {"role": "Monitoring", "status": "pending"}):
            self.user = user
            self.assertEqual(self.request("/feed-health")[0][0], "403 Forbidden")

    def test_ticket_is_single_use_camera_origin_bound_and_expiring(self):
        ticket = self.ticket()
        query = "cameraDocId=camera-1&streamId=viewer&ticket=" + ticket
        (status, _), stream = self.request("/segmentation-stream.mjpg", QUERY_STRING=query, HTTP_AUTHORIZATION="")
        self.assertEqual(status, "200 OK")
        self.assertTrue(next(stream).endswith(b"jpeg\r\n"))
        self.assertEqual(self.request("/segmentation-stream.mjpg", QUERY_STRING=query)[0][0], "401 Unauthorized")
        stream.close()
        ticket = self.ticket()
        with patch("firebase_access.time.monotonic", return_value=time.monotonic() + 31):
            self.assertEqual(self.request("/segmentation-stream.mjpg", QUERY_STRING="cameraDocId=camera-1&ticket=" + ticket)[0][0], "401 Unauthorized")

    def test_stream_revocation_and_lifetime_release_viewer_slot(self):
        ticket = self.ticket()
        _, stream = self.request("/segmentation-stream.mjpg", QUERY_STRING="cameraDocId=camera-1&streamId=viewer&ticket=" + ticket)
        next(stream)
        self.grant = {}
        stream.check_at = 0
        with self.assertRaises(StopIteration):
            next(stream)
        self.assertFalse(self.state.client_active("viewer"))
        self.grant = {"enabled": True}
        ticket = self.ticket()
        _, stream = self.request("/segmentation-stream.mjpg", QUERY_STRING="cameraDocId=camera-1&ticket=" + ticket)
        stream.deadline = 0
        with self.assertRaises(StopIteration):
            next(stream)

    def test_ticket_storage_is_bounded_and_preflight_allows_authorization(self):
        for _ in range(256):
            self.ticket()
        self.assertEqual(self.request("/stream-ticket", REQUEST_METHOD="POST")[0][0], "503 Service Unavailable")
        (_, headers), _ = self.request("/feed-health", REQUEST_METHOD="OPTIONS", HTTP_AUTHORIZATION="")
        self.assertEqual(headers["Access-Control-Allow-Headers"], "Authorization")
        self.assertNotIn("Access-Control-Allow-Credentials", headers)

    def test_admin_sdk_wiring_checks_revocation_project_and_disables_read_retries(self):
        try:
            import firebase_admin
            from firebase_admin import auth, credentials, firestore
        except ImportError:
            self.skipTest("Firebase Admin absent in legacy local venv")
        app, database = Mock(), Mock()
        with patch.dict(os.environ, {"FIREBASE_PROJECT_ID": "expected-project"}, clear=True), \
                patch.object(credentials, "ApplicationDefault", return_value=Mock()), \
                patch.object(firebase_admin, "initialize_app", return_value=app) as initialize, \
                patch.object(firestore, "client", return_value=database), \
                patch.object(auth, "verify_id_token", return_value={"uid": "user-1"}) as verify:
            access = FirebaseAccess.from_environment()
            access.verify("test-id-token")
            access.read("users/user-1")
            verify.assert_called_once_with("test-id-token", app=app, check_revoked=True)
            self.assertEqual(initialize.call_args.args[1]["projectId"], "expected-project")
            database.document.return_value.get.assert_called_once_with(timeout=5, retry=None)
        for key in ("FIREBASE_AUTH_EMULATOR_HOST", "FIRESTORE_EMULATOR_HOST"):
            with patch.dict(os.environ, {"FIREBASE_PROJECT_ID": "expected-project", key: "localhost"}, clear=True):
                with self.assertRaises(ValueError):
                    FirebaseAccess.from_environment()

    def test_ticket_cannot_move_to_another_allowed_origin(self):
        hosts = ("backend.invalid",)
        origins = ("https://frontend.invalid", "https://second.invalid")
        self.app = secure_application(application_for(self.state, origins, "127.0.0.1", 5001, hosts),
                                      self.access, "camera-1", origins, hosts)
        ticket = self.ticket()
        self.assertEqual(self.request("/segmentation-stream.mjpg", HTTP_ORIGIN="https://second.invalid",
                                     QUERY_STRING="cameraDocId=camera-1&ticket=" + ticket)[0][0], "401 Unauthorized")

    def test_slow_reverification_and_frame_iteration_cannot_extend_stream_deadline(self):
        source = Mock()
        source.__next__ = Mock(return_value=b"frame")
        stream = GuardedStream(source, self.access, "token", "camera-1", time.time() + 300)
        stream.deadline = 10
        with patch("firebase_access.time.monotonic", side_effect=[0, 11]):
            with self.assertRaises(StopIteration):
                next(stream)
        source.__next__.assert_not_called()
        source.close.assert_called()
        stream = GuardedStream(source, self.access, "token", "camera-1", time.time() + 300)
        stream.deadline, stream.check_at = 10, 100
        with patch("firebase_access.time.monotonic", side_effect=[0, 0, 11]):
            with self.assertRaises(StopIteration):
                next(stream)
        source.close.assert_called()

    def test_real_firebase_sdk_signature_project_expiry_disabled_and_revocation_checks(self):
        # Ephemeral test keys and mocked certificate/account transport only.
        # The SDK's cryptographic verifier itself is not mocked.
        try:
            import firebase_admin
            from firebase_admin import auth, credentials
            from google.auth.credentials import AnonymousCredentials
            from cryptography.hazmat.primitives.asymmetric import rsa
            from cryptography.hazmat.primitives import serialization
            import jwt
        except ImportError:
            self.skipTest("Firebase Admin/crypto absent in legacy local venv")

        class TestCredential(credentials.Base):
            def get_credential(self):
                return AnonymousCredentials()

        private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        public = private.public_key().public_bytes(serialization.Encoding.PEM,
                                                  serialization.PublicFormat.SubjectPublicKeyInfo).decode()
        issued = int(time.time()) - 10
        claims = dict(sub="user-1", aud="expected-project", iss="https://securetoken.google.com/expected-project",
                      iat=issued, auth_time=issued, exp=issued + 3600)
        app = firebase_admin.initialize_app(TestCredential(), {"projectId": "expected-project"}, name="offline-security-test")
        try:
            client = auth._get_client(app)
            with patch("google.oauth2.id_token._fetch_certs", return_value={"test-key": public}), \
                    patch.object(client, "get_user", return_value=Mock(disabled=False, tokens_valid_after_timestamp=0)) as account:
                def token(values, signing_key=private):
                    return jwt.encode(values, signing_key, algorithm="RS256", headers={"kid": "test-key"})
                self.assertEqual(auth.verify_id_token(token(claims), app=app, check_revoked=True)["uid"], "user-1")
                for changes in ({"aud": "other-project"}, {"iss": "https://securetoken.google.com/other-project"},
                                {"exp": issued - 1}):
                    with self.assertRaises(auth.InvalidIdTokenError):
                        auth.verify_id_token(token({**claims, **changes}), app=app, check_revoked=True)
                bad_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
                with self.assertRaises(auth.InvalidIdTokenError):
                    auth.verify_id_token(token(claims, bad_key), app=app, check_revoked=True)
                account.return_value = Mock(disabled=True, tokens_valid_after_timestamp=0)
                with self.assertRaises(auth.UserDisabledError):
                    auth.verify_id_token(token(claims), app=app, check_revoked=True)
                account.return_value = Mock(disabled=False, tokens_valid_after_timestamp=(issued + 1) * 1000)
                with self.assertRaises(auth.RevokedIdTokenError):
                    auth.verify_id_token(token(claims), app=app, check_revoked=True)
        finally:
            firebase_admin.delete_app(app)


if __name__ == "__main__":
    unittest.main()

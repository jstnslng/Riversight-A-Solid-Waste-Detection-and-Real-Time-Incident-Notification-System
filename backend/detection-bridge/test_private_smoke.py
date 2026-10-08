"""Offline client tests: fake transport, no private environment or network."""
import contextlib
import io
import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch

import private_smoke as smoke


class FakeClient:
    camera, origin = "camera-1", "https://frontend.invalid"

    def __init__(self):
        self.calls, self.expired = [], False
        self.issued, self.used = 0, set()
        self.health_reads = 0

    def request(self, path, token=None, method="GET", ticket=None, **kwargs):
        self.calls.append((path, token, ticket))
        if kwargs.get("host") or kwargs.get("origin"):
            return 403, {}, b'{}'
        if method == "OPTIONS":
            return 200, {"access-control-allow-origin": self.origin, "access-control-allow-headers": "Authorization"}, b'{}'
        if path == "/health":
            return 200, {}, b'{"status":"alive"}'
        if path == "/segmentation-stream.mjpg":
            if not ticket or ticket in self.used or self.expired:
                return 401, {}, b'{}'
            self.used.add(ticket)
            return 200, {"x-camera-doc-id": self.camera, "content-type": "multipart/x-mixed-replace"}, b''
        if not token:
            return 401, {}, b'{}'
        if token != "authorized-test-token":
            return 403, {}, b'{}'
        now = datetime.now(timezone.utc).isoformat()
        if path == "/feed-health":
            self.health_reads += 1
            captured = (datetime.now(timezone.utc) - timedelta(seconds=max(0, 2 - self.health_reads))).isoformat()
            return 200, {}, json.dumps(dict(cameraDocId=self.camera, status="ok", latestFrameAvailable=True,
                                            lastInferenceAt=now, streamEnabled=True, streamAvailable=True,
                                            captureActive=True, lastFrameAt=captured)).encode()
        if path == "/latest-segmentation.jpg":
            return 200, {"x-camera-doc-id": self.camera, "x-feed-status": "ok", "x-inference-at": now,
                         "content-type": "image/jpeg"}, b'\xff\xd8jpeg\xff\xd9'
        if path == "/stream-ticket":
            self.issued += 1
            return 200, {}, json.dumps({"ticket": str(self.issued) * 43, "expiresIn": 30}).encode()
        raise ValueError()


class SmokeTests(unittest.TestCase):
    def test_private_only_configuration_and_no_secrets_in_failure_logs(self):
        env = dict(SMOKE_PRIVATE_URL="http://bridge.railway.internal:5001", SMOKE_ALLOWED_HOST="backend.invalid",
                   SMOKE_ALLOWED_ORIGIN="https://frontend.invalid", SMOKE_CAMERA_DOC_ID="camera-1")
        self.assertEqual(smoke.configuration(env)[1], 5001)
        for url in ("https://public.invalid:5001", "http://public.invalid:5001", "http://secret@bridge.railway.internal:5001",
                    "http://bridge.railway.internal:5001/?token=secret"):
            with self.assertRaises(ValueError):
                smoke.configuration({**env, "SMOKE_PRIVATE_URL": url})
        with patch.dict(smoke.os.environ, {"SMOKE_PRIVATE_URL": "secret"}, clear=True), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(smoke.main(), 2)
        self.assertNotIn("secret", output.getvalue())

    def test_negative_checks_and_authorized_skips(self):
        output = []
        self.assertEqual(smoke.run(FakeClient(), emit=output.append), 0)
        self.assertIn("SKIP authorized_checks: no ID token supplied", output)
        self.assertEqual(sum(row.startswith("PASS") for row in output), 8)

    def test_authorized_grant_replay_expiry_freshness_and_no_secret_output(self):
        client, output = FakeClient(), []
        def sleep(seconds):
            if seconds == 32:
                client.expired = True
        self.assertEqual(smoke.run(client, "authorized-test-token", "known-ungranted-token",
                                  expiry=True, sleep=sleep, emit=output.append), 0)
        text = "\n".join(output)
        self.assertNotIn("authorized-test-token", text)
        self.assertNotIn("known-ungranted-token", text)
        self.assertNotIn("1" * 43, text)
        self.assertIn("PASS expired_ticket_with_authorized_control", output)

    def test_wrong_health_schema_and_sensitive_errors_fail_without_printing_details(self):
        client = FakeClient()
        original = client.request
        client.request = lambda path, **kwargs: (200, {}, b'{"status":"alive","cameraDocId":"private"}') if path == "/health" else original(path, **kwargs)
        output = []
        self.assertEqual(smoke.run(client, emit=output.append), 1)
        self.assertIn("FAIL minimal_health", output)
        client.request = Mock(side_effect=RuntimeError("sensitive-token-url"))
        output = []
        self.assertEqual(smoke.run(client, emit=output.append), 1)
        self.assertNotIn("sensitive-token-url", "\n".join(output))

    def test_transport_reads_bounded_jpeg_and_closes_connection(self):
        response = Mock(status=200)
        response.getheaders.return_value = [("Content-Type", "multipart/x-mixed-replace")]
        response.readline.side_effect = [b'--frame\r\n', b'Content-Type: image/jpeg\r\n', b'Content-Length: 8\r\n', b'\r\n']
        response.read.return_value = b'\xff\xd8jpeg\xff\xd9'
        connection = Mock()
        connection.getresponse.return_value = response
        with patch.object(smoke.http.client, "HTTPConnection", return_value=connection):
            client = smoke.Client(("bridge.railway.internal", 5001, "backend.invalid", "https://frontend.invalid", "camera-1"))
            self.assertEqual(client.request("/segmentation-stream.mjpg", ticket="opaque-ticket", stream=True)[0], 200)
        connection.close.assert_called_once()
        self.assertEqual(connection.request.call_args.kwargs["headers"]["Host"], "backend.invalid")


if __name__ == "__main__":
    unittest.main()

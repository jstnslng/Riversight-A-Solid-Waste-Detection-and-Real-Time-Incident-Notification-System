"""Offline tests for restart-safe, bounded authorization lease continuity."""

import json
import sys
import time
import unittest
from unittest.mock import Mock, patch

from firebase_access import (
    AccessDependencyError,
    AccessDenied,
    FirebaseAccess,
    UnavailableFirebaseAccess,
    secure_application,
)


class LeaseTests(unittest.TestCase):
    def setUp(self):
        self.verify = Mock(return_value={"uid": "user-1", "exp": time.time() + 300})
        self.read = Mock(side_effect=lambda path: (
            {"role": "Monitoring", "status": "Active"}
            if path.startswith("users/") else {"enabled": True}
        ))
        self.access = FirebaseAccess(
            self.verify, self.read, lease_secret=b"test-secret", lease_seconds=30)

    def test_lease_requires_initial_grant_and_is_camera_scoped(self):
        lease = self.access.issue_lease("token", "camera-1", time.time() + 300)
        self.assertGreater(self.access.validate_lease(lease, "camera-1"), time.time())
        with self.assertRaises(AccessDenied):
            self.access.validate_lease(lease, "camera-2")

        unavailable = UnavailableFirebaseAccess()
        with self.assertRaises(AccessDependencyError):
            unavailable.validate_lease(lease, "camera-1")

    def test_expired_lease_is_rejected(self):
        with patch("firebase_access.time.time", side_effect=[100, 102]):
            lease = self.access.issue_lease("token", "camera-1", 101)
            with self.assertRaises(AccessDenied):
                self.access.validate_lease(lease, "camera-1")

    def test_lease_rejects_mismatched_authenticated_user(self):
        lease = self.access.issue_lease("token", "camera-1", time.time() + 300)
        with self.assertRaises(AccessDenied):
            self.access.validate_lease(lease, "camera-1", expected_uid="other-user")

    def test_ticket_remains_stream_authorized_during_firestore_outage(self):
        source = iter([b"overlay-jpeg"])

        def application(environ, start):
            start("200 OK", [("Content-Type", "multipart/x-mixed-replace")])
            return source

        wrapped = secure_application(
            application, self.access, "camera-1",
            ("https://frontend.invalid",), ("backend.invalid",))

        result = []
        ticket_body = wrapped({
            "PATH_INFO": "/stream-ticket",
            "REQUEST_METHOD": "POST",
            "HTTP_HOST": "backend.invalid",
            "HTTP_ORIGIN": "https://frontend.invalid",
            "HTTP_AUTHORIZATION": "Bearer token",
            "QUERY_STRING": "cameraDocId=camera-1",
        }, lambda status, headers: result.append((status, dict(headers))))
        self.assertEqual(result[0][0], "200 OK")
        ticket = json.loads(b"".join(ticket_body))["ticket"]
        lease = result[0][1]["X-RiverSight-Authorization-Lease"]

        self.read.side_effect = RuntimeError("quota")
        result.clear()
        body = wrapped({
            "PATH_INFO": "/segmentation-stream.mjpg",
            "REQUEST_METHOD": "GET",
            "HTTP_HOST": "backend.invalid",
            "HTTP_ORIGIN": "https://frontend.invalid",
            "QUERY_STRING": "cameraDocId=camera-1&ticket=" + ticket,
        }, lambda status, headers: result.append((status, dict(headers))))
        self.assertEqual(result[0][0], "200 OK")
        self.assertEqual(next(body), b"overlay-jpeg")
        self.assertIsNotNone(lease)


if __name__ == "__main__":
    unittest.main()

"""Offline tests for lifecycle-based Firestore detection recording."""

import unittest
import threading
import time
from unittest.mock import Mock

from detection_recorder import DetectionRecorder


def row(x=10, confidence=0.8, class_id=0, name="Plastic"):
    return {
        "class": class_id,
        "name": name,
        "confidence": confidence,
        "box": {"x1": x, "y1": 10, "x2": x + 20, "y2": 30},
    }


class DetectionRecorderTests(unittest.TestCase):
    def setUp(self):
        self.writes = []
        self.writer = lambda detection_id, data: self.writes.append((detection_id, data))
        self.timestamp = lambda: "SERVER_TIMESTAMP"

    def recorder(self, session_id="session" + "a" * 15):
        return DetectionRecorder(
            "camera-document-1", self.writer, self.timestamp,
            timeout=5, write_interval=2, session_id=session_id,
        )

    def tearDown(self):
        if hasattr(self, "recorder_instance"):
            self.recorder_instance.close()

    def test_successful_creation_and_dashboard_compatible_fields(self):
        self.recorder_instance = self.recorder()
        self.recorder_instance.observe([row()], "CAM-001", now=10)
        self.recorder_instance.flush()

        detection_id, data = self.writes[0]
        self.assertEqual(detection_id, "session" + "a" * 15 + ":1")
        self.assertEqual(data["cameraDocId"], "camera-document-1")
        self.assertEqual(data["cameraId"], "CAM-001")
        self.assertEqual(data["wasteClass"], "Plastic")
        self.assertEqual(data["classId"], 0)
        self.assertEqual(data["confidenceScore"], 80)
        self.assertEqual(data["confidence"], 0.8)
        self.assertEqual(data["timestamp"], "SERVER_TIMESTAMP")
        self.assertEqual(data["status"], "active")
        self.assertEqual(data["trackingId"], detection_id)
        self.assertEqual(data["boundingBox"]["x1"], 10)

    def test_repeated_observations_update_same_record_at_bounded_rate(self):
        self.recorder_instance = self.recorder()
        self.recorder_instance.observe([row()], now=10)
        self.recorder_instance.observe([row(confidence=0.9)], now=11)
        self.recorder_instance.observe([row(confidence=0.9)], now=12)
        self.recorder_instance.flush()

        self.assertEqual([item[0] for item in self.writes], [
            "session" + "a" * 15 + ":1",
            "session" + "a" * 15 + ":1",
        ])
        self.assertEqual(self.writes[-1][1]["confidenceScore"], 90)
        self.assertNotIn("timestamp", self.writes[-1][1])

    def test_expiration_resolves_and_reappearance_creates_new_lifecycle(self):
        self.recorder_instance = self.recorder()
        self.recorder_instance.observe([row()], now=10)
        self.recorder_instance.observe([], now=15)
        self.recorder_instance.observe([row()], now=16)
        self.recorder_instance.flush()

        self.assertEqual([item[0] for item in self.writes], [
            "session" + "a" * 15 + ":1",
            "session" + "a" * 15 + ":1",
            "session" + "a" * 15 + ":2",
        ])
        self.assertEqual(self.writes[1][1]["status"], "resolved")

    def test_invalid_camera_identifier_is_rejected(self):
        with self.assertRaises(ValueError):
            DetectionRecorder("camera/invalid", self.writer, self.timestamp)

    def test_invalid_optional_camera_id_is_not_written(self):
        self.recorder_instance = self.recorder()
        self.recorder_instance.observe([row()], "CAM/INVALID", now=10)
        self.recorder_instance.flush()
        self.assertNotIn("cameraId", self.writes[0][1])

    def test_write_failures_do_not_escape_observation(self):
        writer = Mock(side_effect=RuntimeError("private failure"))
        self.recorder_instance = DetectionRecorder(
            "camera-document-1", writer, self.timestamp, timeout=5, session_id="session" + "b" * 15,
        )
        self.recorder_instance.observe([row()], now=10)
        self.recorder_instance.flush()
        self.assertEqual(self.recorder_instance.failures[-1], "firestore_write_failed")

    def test_restart_sessions_never_reuse_ids(self):
        first = self.recorder("session" + "c" * 15)
        second = self.recorder("session" + "d" * 15)
        first.observe([row()], now=10)
        second.observe([row()], now=10)
        first.flush()
        second.flush()
        first.close()
        second.close()
        self.assertNotEqual(first.session_id + ":1", second.session_id + ":1")

    def test_shutdown_is_bounded_when_a_write_stalls(self):
        started = threading.Event()
        release = threading.Event()

        def stalled_writer(*_):
            started.set()
            release.wait()

        self.recorder_instance = DetectionRecorder(
            "camera-document-1", stalled_writer, self.timestamp, session_id="session" + "e" * 15,
        )
        self.recorder_instance.observe([row()], now=10)
        self.assertTrue(started.wait(1))
        started_at = time.monotonic()
        self.recorder_instance.close()
        self.assertLess(time.monotonic() - started_at, 3)
        self.assertIn("shutdown_timeout", self.recorder_instance.failures)
        release.set()


if __name__ == "__main__":
    unittest.main()

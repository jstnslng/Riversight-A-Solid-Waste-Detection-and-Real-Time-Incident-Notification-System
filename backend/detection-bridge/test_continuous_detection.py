"""Offline tests: no private config, camera, HTTP, or third-party imports."""

import contextlib
import io
import os
import types
import unittest
from unittest.mock import Mock, patch

import continuous_detection as monitor
import one_frame


class RequestError(Exception):
    pass


class Timeout(RequestError):
    pass


class ConnectionError(RequestError):
    pass


class Response:
    def __init__(self, status=200, rows=None, malformed=False, invalid_json=False):
        self.status_code = status
        self.rows = rows or []
        self.malformed = malformed
        self.invalid_json = invalid_json

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def json(self):
        if self.invalid_json:
            raise ValueError("PRIVATE_SECRET")
        if self.malformed:
            return {"error": "PRIVATE_SECRET"}
        return {"images": [{"shape": [100, 200], "results": self.rows,
                            "speed": {"inference": 10}}]}


class Session:
    def __init__(self, post):
        self.post = post

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.output = io.StringIO()
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(contextlib.redirect_stdout(self.output))
        self.stack.enter_context(contextlib.redirect_stderr(self.output))
        self.stack.enter_context(patch.object(one_frame, "save_debug_frame", side_effect=AssertionError("Must not save")))

    def fake_requests(self, responses):
        post = Mock(side_effect=responses)
        fake = types.SimpleNamespace(
            Session=lambda: Session(post),
            exceptions=types.SimpleNamespace(Timeout=Timeout, ConnectionError=ConnectionError,
                                             RequestException=RequestError))
        return fake, post

    def run_monitor(self, responses, captures=None, times=None):
        fake, post = self.fake_requests(responses)
        with patch.object(monitor, "capture_one_frame", side_effect=captures,
                          return_value=(b"jpeg", 200, 100)) as capture, \
                patch.object(monitor.time, "monotonic", side_effect=times, return_value=0), \
                patch.object(monitor.time, "sleep", side_effect=[None, KeyboardInterrupt]) as sleep:
            with self.assertRaises(KeyboardInterrupt):
                monitor.monitor("PRIVATE_CAMERA", "PRIVATE_ENDPOINT", "PRIVATE_SECRET", 5, fake)
        self.assertNotIn("PRIVATE_", self.output.getvalue())
        self.assertNotIn("Traceback", self.output.getvalue())
        return capture, post, sleep

    def test_intervals(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(monitor.detection_interval(), 5)
        for raw, expected in [("2.5", 2.5), ("1", 1), ("86400", 86400)]:
            with patch.dict(os.environ, {"DETECTION_INTERVAL_SECONDS": raw}):
                self.assertEqual(monitor.detection_interval(), expected)
        for raw in ("", "PRIVATE_SECRET", "0", "-5", "0.5", "86401", "nan", "inf"):
            with self.subTest(raw=raw), patch.dict(os.environ, {"DETECTION_INTERVAL_SECONDS": raw}):
                with self.assertRaises(monitor.BridgeError) as error:
                    monitor.detection_interval()
                self.assertNotIn(raw, str(error.exception)) if raw == "PRIVATE_SECRET" else None

    def test_success_zero_and_multiple_predictions(self):
        row = {"class": 0, "name": "bottle", "confidence": 0.9,
               "box": {"x1": 1, "y1": 2, "x2": 30, "y2": 40}}
        capture, post, sleep = self.run_monitor([Response(), Response(rows=[row, row])])
        self.assertEqual(capture.call_count, 2)
        self.assertEqual(post.call_count, 2)
        self.assertIn("Predictions: 0", self.output.getvalue())
        self.assertIn("Predictions: 2", self.output.getvalue())
        self.assertIn("HTTP status: 200", self.output.getvalue())
        self.assertIn("Cloud inference duration: 10.00 ms", self.output.getvalue())
        self.assertEqual(post.call_args.kwargs["data"], {"conf": "0.25", "iou": "0.70", "imgsz": "640"})
        self.assertEqual(post.call_args.kwargs["files"]["file"][1], b"jpeg")
        self.assertFalse(post.call_args.kwargs["allow_redirects"])

    def test_camera_failure_recovers(self):
        capture, post, sleep = self.run_monitor([Response()],
            [monitor.BridgeError("Camera connection failed."), (b"jpeg", 200, 100)])
        self.assertEqual(capture.call_count, 2)
        self.assertEqual(post.call_count, 1)
        self.assertIn("Cycle 2", self.output.getvalue())
        self.assertEqual(sleep.call_args_list[0].args, (5,))

    def test_request_and_response_failures_recover(self):
        failures = [Response(401), Response(403), Response(429), Response(500),
                    Response(302), Response(malformed=True), Response(invalid_json=True),
                    Timeout("PRIVATE_SECRET"), ConnectionError("PRIVATE_SECRET")]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                capture, post, sleep = self.run_monitor([failure, Response()])
                self.assertEqual(capture.call_count, 2)
                self.assertEqual(post.call_count, 2)
                self.assertEqual(sleep.call_args_list[0].args, (5,))

    def test_unexpected_error_is_sanitized_and_recovers(self):
        capture, post, sleep = self.run_monitor([Response()],
            [RuntimeError("PRIVATE_SECRET"), (b"jpeg", 200, 100)])
        self.assertEqual(capture.call_count, 2)
        self.assertEqual(post.call_count, 1)

    def test_start_spacing_and_slow_cycle_no_overlap(self):
        # Per cycle: start, request start, request end, cycle end.
        capture, post, sleep = self.run_monitor([Response(), Response()],
            times=[0, 1, 2, 2, 5, 6, 13, 13])
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [3, 0])
        self.assertEqual(post.call_count, 2)
        # Each capture must happen after the previous synchronous request finishes.
        events = []
        def capture_frame(*args):
            events.append("capture")
            return b"jpeg", 200, 100
        def prediction(*args):
            events.extend(["request-start", "request-end"])
            return [], None
        with patch.object(monitor, "capture_one_frame", side_effect=capture_frame), \
                patch.object(monitor, "predict", side_effect=prediction), \
                patch.object(monitor.time, "sleep", side_effect=[None, KeyboardInterrupt]):
            with self.assertRaises(KeyboardInterrupt):
                monitor.monitor("", "", "", 5, None)
        self.assertEqual(events, ["capture", "request-start", "request-end"] * 2)

    def test_ctrl_c_during_capture_request_and_wait(self):
        for stage in ("capture", "request", "wait"):
            fake, post = self.fake_requests([KeyboardInterrupt] if stage == "request" else [Response()])
            with self.subTest(stage=stage), \
                    patch.dict("sys.modules", {"requests": fake}), \
                    patch.object(monitor, "configuration", return_value=("PRIVATE_CAMERA", "PRIVATE_ENDPOINT", "PRIVATE_SECRET")), \
                    patch.object(monitor, "detection_interval", return_value=5), \
                    patch.object(monitor, "capture_one_frame", side_effect=KeyboardInterrupt if stage == "capture" else None, return_value=(b"jpeg", 200, 100)), \
                    patch.object(monitor.time, "sleep", side_effect=KeyboardInterrupt):
                self.assertEqual(monitor.main(), 0)
        self.assertEqual(self.output.getvalue().count("Monitoring stopped."), 3)
        self.assertNotIn("PRIVATE_", self.output.getvalue())
        self.assertNotIn("Traceback", self.output.getvalue())


if __name__ == "__main__":
    unittest.main()

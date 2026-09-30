"""Offline feed tests: HTTP handlers use memory streams, not listening sockets."""

import contextlib
from email.message import Message
import io
import json
import os
import threading
import unittest
from unittest.mock import Mock, patch

import cv2
import numpy as np

import segmentation_feed as feed


class FeedTests(unittest.TestCase):
    def setUp(self):
        self.state = feed.LatestFrame()
        self.jpeg = cv2.imencode(".jpg", np.full((100, 200, 3), 100, np.uint8))[1].tobytes()

    def request(self, path, origin="http://localhost:5500", host="127.0.0.1:5001", preflight=False, origins=("http://localhost:5500",)):
        handler = object.__new__(feed.handler_for(self.state, origins, "127.0.0.1", 5001))
        handler.path = path
        handler.headers = Message()
        handler.headers["Host"] = host
        if origin:
            handler.headers["Origin"] = origin
        handler.wfile = io.BytesIO()
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler.respond(preflight)
        return handler.send_response.call_args.args[0], dict(call.args for call in handler.send_header.call_args_list), handler.wfile.getvalue()

    def test_no_frame_health_and_cache_headers(self):
        code, headers, body = self.request("/health")
        self.assertEqual(code, 200)
        self.assertFalse(json.loads(body)["latestFrameAvailable"])
        self.assertEqual(self.request("/latest-segmentation.jpg?t=1")[0], 503)
        self.assertIn("no-store", headers["Cache-Control"])
        self.assertEqual(headers["Access-Control-Allow-Origin"], "http://localhost:5500")
        self.assertEqual(self.request("/.env")[0], 404)

    def test_latest_frame_and_degraded_status(self):
        self.state.publish(self.jpeg, 2)
        code, headers, body = self.request("/latest-segmentation.jpg?t=2")
        self.assertEqual((code, body), (200, self.jpeg))
        self.assertEqual(headers["Content-Type"], "image/jpeg")
        self.assertIn("X-Inference-At", headers)
        self.state.failure()
        health = json.loads(self.request("/health")[2])
        self.assertEqual(health["status"], "degraded")
        self.assertEqual(health["lastPredictionCount"], 2)
        self.assertEqual(set(health), {"status", "model", "latestFrameAvailable", "lastInferenceAt", "lastPredictionCount", "cameraDocId",
            "lastInferenceCapturedAt", "lastCloudRequestAt", "lastCloudResponseAt", "latestInferenceLatencyMs",
            "averageInferenceLatencyMs", "inferenceFrameAgeMs"})

    def test_safe_explicit_camera_identity(self):
        self.state = feed.LatestFrame("camera-document-1")
        self.state.publish(self.jpeg, 0)
        self.assertEqual(json.loads(self.request("/health")[2])["cameraDocId"], "camera-document-1")
        _, headers, _ = self.request("/latest-segmentation.jpg")
        self.assertEqual(headers["X-Camera-Doc-Id"], "camera-document-1")
        self.assertIn("X-Camera-Doc-Id", headers["Access-Control-Expose-Headers"])
        self.assertEqual(feed.LatestFrame().snapshot()[1]["cameraDocId"], "")
        with self.assertRaises(ValueError):
            feed.LatestFrame("rtsp://private:private@camera/")

    def test_cors_host_and_preflight(self):
        self.assertEqual(self.request("/health", origin="https://untrusted.invalid")[0], 403)
        self.assertEqual(self.request("/health", host="attacker.invalid:5001")[0], 403)
        self.assertEqual(self.request("/health", origin="null")[0], 403)
        self.assertEqual(self.request("/health", origin=None)[0], 200)
        code, headers, _ = self.request("/health", preflight=True)
        self.assertEqual(code, 204)
        self.assertEqual(headers["Access-Control-Allow-Private-Network"], "true")

    def test_atomic_snapshot_replacement(self):
        self.state.publish(b"old", 0)
        old, _ = self.state.snapshot()
        def producer():
            for number in range(1, 500):
                self.state.publish(str(number).encode(), number)
        thread = threading.Thread(target=producer)
        thread.start()
        for _ in range(500):
            jpeg, health = self.state.snapshot()
            if jpeg != b"old":
                self.assertEqual(int(jpeg), health["lastPredictionCount"])
        thread.join()
        self.assertEqual(old, b"old")

    def test_default_web_origins_allowed_and_filesystem_origins_rejected(self):
        with patch.dict(os.environ, {}, clear=True):
            host, port, _, origins = feed.feed_configuration()
        self.assertEqual((host, port), ("127.0.0.1", 5001))
        self.assertNotIn("*", origins)
        self.state.publish(self.jpeg, 0)
        for origin in ("http://127.0.0.1:8000", "http://localhost:8000"):
            for path in ("/health", "/latest-segmentation.jpg"):
                code, headers, _ = self.request(path, origin=origin, origins=origins)
                self.assertEqual(code, 200)
                self.assertEqual(headers["Access-Control-Allow-Origin"], origin)
        for origin in ("null", "file://", "http://untrusted.invalid:8000"):
            code, headers, _ = self.request("/health", origin=origin, origins=origins)
            self.assertEqual(code, 403)
            self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_zero_predictions_preserve_exact_jpeg(self):
        result, count = feed.processed_jpeg(self.jpeg, [])
        self.assertIs(result, self.jpeg)
        self.assertEqual(count, 0)

    def test_segmented_publication_reuses_renderer(self):
        row = {"class": 0, "name": "Plastic", "confidence": 0.8,
               "box": {"x1": 30, "y1": 30, "x2": 80, "y2": 90},
               "segments": {"x": [30, 80, 50], "y": [30, 30, 90]}}
        original = bytes(self.jpeg)
        with patch.object(feed, "capture_one_frame", return_value=(self.jpeg, 200, 100)) as capture, \
                patch.object(feed, "predict", return_value=([row, {"box": {}}], 1)) as predict, \
                patch.object(feed, "render_predictions", wraps=feed.render_predictions) as render:
            feed.sample_cycle(self.state, "PRIVATE", "PRIVATE", "PRIVATE", None)
        capture.assert_called_once()
        predict.assert_called_once()
        self.assertIs(predict.call_args.args[2], self.jpeg)
        render.assert_called_once()
        latest, status = self.state.snapshot()
        self.assertEqual(status["lastPredictionCount"], 1)
        self.assertNotEqual(latest, original)
        self.assertEqual(self.jpeg, original)

    def test_configuration_defaults_and_validation(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(feed.feed_configuration()[:3], ("127.0.0.1", 5001, 2))
        for value in ("0", "nan", "inf", "PRIVATE", "86401"):
            with patch.dict(os.environ, {"SEGMENTATION_INTERVAL_SECONDS": value}, clear=True):
                with self.assertRaises(ValueError) as error:
                    feed.feed_configuration()
                self.assertNotIn("PRIVATE", str(error.exception))
        with patch.dict(os.environ, {"SEGMENTATION_ALLOWED_ORIGINS": "*"}, clear=True):
            with self.assertRaises(ValueError):
                feed.feed_configuration()

    def test_failure_recovery_sequential_and_interval(self):
        stop = Mock()
        stop.is_set.side_effect = [False, False, True]
        with patch.object(feed, "sample_cycle", side_effect=[RuntimeError("PRIVATE"), None]) as cycle, \
                patch.object(feed.time, "monotonic", side_effect=[0, 1, 2, 5]), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            feed.sampling_loop(self.state, 2, stop, ("PRIVATE",) * 3, None)
        self.assertEqual(cycle.call_count, 2)
        self.assertEqual([call.args[0] for call in stop.wait.call_args_list], [1, 0])
        self.assertNotIn("PRIVATE", output.getvalue())

    def test_ctrl_c_closes_http_service(self):
        server, thread = Mock(), Mock()
        with patch.object(feed, "configuration", return_value=("PRIVATE",) * 3), \
                patch.object(feed, "stream_configuration", return_value=0), \
                patch.object(feed, "feed_configuration", return_value=("127.0.0.1", 5001, 2, ())), \
                patch.object(feed, "ThreadingHTTPServer", return_value=server), \
                patch.object(feed.threading, "Thread", return_value=thread), \
                patch.object(feed, "sampling_loop", side_effect=KeyboardInterrupt), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(feed.main(), 0)
        server.shutdown.assert_called_once()
        server.server_close.assert_called_once()
        thread.join.assert_called_once()
        self.assertNotIn("PRIVATE", output.getvalue())

    def test_startup_identity_configuration_and_missing_warning(self):
        for configured in (None, "", "  ", " camera-document-1 "):
            environment = {} if configured is None else {"SEGMENTATION_CAMERA_DOC_ID": configured}
            captured = []
            def capture_state(state, *args):
                captured.append(state)
                raise KeyboardInterrupt
            with patch.dict(os.environ, environment, clear=True), \
                    patch.object(feed, "stream_configuration", return_value=0), \
                    patch.object(feed, "configuration", return_value=("PRIVATE",) * 3), \
                    patch.object(feed, "feed_configuration", return_value=("127.0.0.1", 5001, 2, ())), \
                    patch.object(feed, "ThreadingHTTPServer", return_value=Mock()), \
                    patch.object(feed.threading, "Thread", return_value=Mock()), \
                    patch.object(feed, "sampling_loop", side_effect=capture_state), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(feed.main(), 0)
            self.state = captured[0]
            expected = (configured or "").strip()
            health = json.loads(self.request("/health")[2])
            self.assertEqual(health["cameraDocId"], expected)
            self.assertNotIn("PRIVATE", json.dumps(health) + output.getvalue())
            self.assertEqual("Camera document ID is not configured" in output.getvalue(), not bool(expected))


if __name__ == "__main__":
    unittest.main()

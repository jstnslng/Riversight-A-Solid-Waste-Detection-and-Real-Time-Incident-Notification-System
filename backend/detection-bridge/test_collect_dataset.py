"""Offline collector tests with fake RTSP capture and synthetic image data."""

import base64
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import cv2
import numpy as np

import collect_dataset as collector


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name) / "dataset-captures" / "images"
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(collector, "OUTPUT_DIRECTORY", self.directory))
        self.output = io.StringIO()
        self.stack.enter_context(contextlib.redirect_stdout(self.output))
        self.stack.enter_context(contextlib.redirect_stderr(self.output))
        # Any accidental network call is a test failure, even on the LAN.
        self.stack.enter_context(patch("socket.socket.connect", side_effect=AssertionError("No network allowed")))

    def test_original_dimensions_quality_and_release_before_encoding(self):
        frame = np.zeros((123, 237, 3), dtype=np.uint8)
        frame[:, :, 1] = 127
        camera = Mock()
        camera.open.return_value = True
        camera.read.return_value = (True, frame)
        real_encode = cv2.imencode

        def encode(extension, actual, options):
            camera.release.assert_called_once()
            self.assertIs(actual, frame)
            self.assertEqual(options, [cv2.IMWRITE_JPEG_QUALITY, 95])
            return real_encode(extension, actual, options)

        worker_output = io.StringIO()
        with patch.object(cv2, "VideoCapture", return_value=camera), \
                patch.object(cv2, "imencode", side_effect=encode), \
                patch("sys.stdin", io.StringIO("rtsp://PRIVATE_SECRET@camera/stream")), \
                patch.dict(os.environ, {}, clear=True), \
                contextlib.redirect_stdout(worker_output):
            exec(compile(collector.CAPTURE_WORKER, "worker", "exec"), {})
        camera.read.assert_called_once()
        payload = json.loads(worker_output.getvalue())
        self.assertEqual((payload["height"], payload["width"]), (123, 237))
        jpeg = base64.b64decode(payload["jpeg"])
        name = collector.save_image(jpeg)
        saved = (self.directory / name).read_bytes()
        self.assertEqual(saved, jpeg)
        self.assertEqual(cv2.imdecode(np.frombuffer(saved, np.uint8), cv2.IMREAD_COLOR).shape, frame.shape)
        self.assertNotIn("PRIVATE_SECRET", worker_output.getvalue())

    def test_directory_unique_names_and_no_overwrite(self):
        self.assertFalse(self.directory.exists())
        first = collector.save_image(b"first")
        second = collector.save_image(b"second")
        self.assertNotEqual(first, second)
        self.assertEqual((self.directory / first).read_bytes(), b"first")

    def test_exclusive_creation(self):
        with patch.object(collector, "uuid4", return_value=Mock(hex="fixed")), \
                patch.object(collector, "datetime") as date:
            from datetime import datetime
            date.now.return_value = datetime(2026, 9, 29)
            filename = collector.save_image(b"original")
            with self.assertRaises(collector.CollectorError):
                collector.save_image(b"replacement")
            self.assertEqual((self.directory / filename).read_bytes(), b"original")

    def run_interaction(self, commands, capture_effect=None):
        with patch.object(collector, "camera_configuration", return_value="PRIVATE_SECRET"), \
                patch("builtins.input", side_effect=commands), \
                patch.object(collector, "capture_image", side_effect=capture_effect,
                             return_value=(b"jpeg", 237, 123)) as capture:
            self.assertEqual(collector.main(), 0)
        self.assertNotIn("PRIVATE_SECRET", self.output.getvalue())
        self.assertNotIn("Traceback", self.output.getvalue())
        return capture

    def test_enter_success_and_q(self):
        capture = self.run_interaction(["", "", "q"])
        self.assertEqual(capture.call_count, 2)
        self.assertEqual(len(list(self.directory.glob("*.jpg"))), 2)
        self.assertIn("Captured images: 2", self.output.getvalue())

    def test_failure_recovers(self):
        capture = self.run_interaction(["", "", "q"],
            [RuntimeError("PRIVATE_SECRET"), (b"jpeg", 237, 123)])
        self.assertEqual(capture.call_count, 2)
        self.assertEqual(len(list(self.directory.glob("*.jpg"))), 1)

    def test_quit_unknown_command_and_interrupt(self):
        for commands in (["q"], ["other", "q"], [KeyboardInterrupt], [EOFError]):
            capture = self.run_interaction(commands)
            capture.assert_not_called()
        capture = self.run_interaction([""], KeyboardInterrupt)
        capture.assert_called_once()
        self.assertIn("Dataset collector stopped.", self.output.getvalue())

    def test_capture_wrapper_suppresses_diagnostics(self):
        completed = subprocess.CompletedProcess([], 0, json.dumps({"width": 2, "height": 1,
            "jpeg": base64.b64encode(b"jpeg").decode()}).encode())
        with patch.object(collector.subprocess, "run", return_value=completed) as run:
            self.assertEqual(collector.capture_image("PRIVATE_SECRET"), (b"jpeg", 2, 1))
            run.assert_called_once()
            self.assertNotIn("PRIVATE_SECRET", str(run.call_args.args))
            self.assertEqual(run.call_args.kwargs["stderr"], subprocess.DEVNULL)
            self.assertNotIn("ULTRALYTICS_API_KEY", run.call_args.kwargs["env"])
        for effect in (subprocess.TimeoutExpired("PRIVATE_SECRET", 30), OSError("PRIVATE_SECRET")):
            with patch.object(collector.subprocess, "run", side_effect=effect):
                with self.assertRaises(collector.CollectorError) as error:
                    collector.capture_image("PRIVATE_SECRET")
                self.assertNotIn("PRIVATE_SECRET", str(error.exception))

    def test_only_camera_dotenv_assignment_is_parsed(self):
        from dotenv import dotenv_values
        with patch.object(collector, "BRIDGE_DIRECTORY", Path(self.temp.name)), \
                patch.dict(os.environ, {}, clear=True):
            (Path(self.temp.name) / ".env").write_text(
                'ULTRALYTICS_API_KEY=PRIVATE_CLOUD\nCAMERA_RTSP_URL="rtsp://u:p@camera/stream"\n', encoding="utf-8")
            def parse_camera(*, stream, interpolate):
                text = stream.read()
                self.assertNotIn("PRIVATE_CLOUD", text)
                return dotenv_values(stream=io.StringIO(text), interpolate=interpolate)
            with patch("dotenv.dotenv_values", side_effect=parse_camera) as parse:
                self.assertEqual(collector.camera_configuration(), "rtsp://u:p@camera/stream")
                parse.assert_called_once()
            self.assertNotIn("ULTRALYTICS_API_KEY", os.environ)
        self.assertNotIn("PRIVATE_CLOUD", self.output.getvalue())


if __name__ == "__main__":
    unittest.main()

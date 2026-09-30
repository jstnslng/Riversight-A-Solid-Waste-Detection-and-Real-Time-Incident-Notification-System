"""Synthetic-image and mocked CLI tests; no private configuration or network."""

import contextlib
import copy
import io
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import cv2
import numpy as np

import evidence_renderer as renderer
import one_frame


def prediction(**changes):
    result = {"class": 0, "name": "bottle", "confidence": 0.7807,
              "box": {"x1": 40.5, "y1": 50.2, "x2": 100.3, "y2": 120.8}}
    result.update(changes)
    return result


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(renderer, "__file__", str(self.root / "evidence_renderer.py")))
        self.stack.enter_context(patch.object(one_frame, "__file__", str(self.root / "one_frame.py")))
        self.stack.enter_context(patch("socket.socket.connect", side_effect=AssertionError("No network")))
        self.stack.enter_context(patch.object(one_frame.subprocess, "run", side_effect=AssertionError("No real capture")))
        self.frame = np.full((180, 320, 3), 80, dtype=np.uint8)
        ok, encoded = cv2.imencode(".jpg", self.frame)
        self.assertTrue(ok)
        self.jpeg = encoded.tobytes()

    def test_single_box_label_and_original_unchanged(self):
        original = self.frame.copy()
        row = prediction()
        before = copy.deepcopy(row)
        with patch.object(cv2, "putText", wraps=cv2.putText) as text:
            annotated, count = renderer.render_predictions(self.frame, [row], one_frame.CLASSES)
        self.assertEqual(count, 1)
        self.assertEqual(text.call_args.args[1], "bottle 78.1%")
        self.assertTrue(np.array_equal(self.frame, original))
        self.assertFalse(np.array_equal(annotated, original))
        self.assertEqual(row, before)
        self.assertFalse(np.shares_memory(annotated, self.frame))

    def test_multiple_and_malformed_predictions(self):
        rows = [prediction(), prediction(**{"class": 4, "name": "plastic-bag"}),
                prediction(box={}), prediction(name="PRIVATE_SECRET"), None]
        with patch.object(cv2, "putText", wraps=cv2.putText) as text:
            _, count = renderer.render_predictions(self.frame, rows, one_frame.CLASSES)
        self.assertEqual(count, 2)
        self.assertEqual(text.call_count, 2)
        self.assertNotIn("PRIVATE_SECRET", str(text.call_args_list))

    def test_box_clamping_and_invalid_coordinates(self):
        self.assertEqual(renderer.drawing_box({"x1": -50, "y1": -20, "x2": 500, "y2": 400}, 320, 180), (0, 0, 319, 179))
        boxes = [{}, {"x1": "secret", "y1": 0, "x2": 10, "y2": 10},
                 {"x1": 10, "y1": 0, "x2": 10, "y2": 10},
                 {"x1": 0, "y1": 10, "x2": 10, "y2": 1},
                 {"x1": 400, "y1": 0, "x2": 500, "y2": 10},
                 {"x1": -50, "y1": 0, "x2": -10, "y2": 10}]
        boxes += [{"x1": value, "y1": 0, "x2": 10, "y2": 10}
                  for value in (float("nan"), float("inf"), -float("inf"), True)]
        for box in boxes:
            with self.subTest(box=box):
                self.assertIsNone(renderer.drawing_box(box, 320, 180))

    def test_save_directory_unique_names_and_dimensions(self):
        self.assertFalse((self.root / "evidence").exists())
        first = renderer.save_evidence(self.jpeg, [prediction()], one_frame.CLASSES)
        original_bytes = first.read_bytes()
        second = renderer.save_evidence(self.jpeg, [prediction()], one_frame.CLASSES)
        self.assertNotEqual(first, second)
        self.assertEqual(first.read_bytes(), original_bytes)
        decoded = cv2.imdecode(np.frombuffer(original_bytes, np.uint8), cv2.IMREAD_COLOR)
        self.assertEqual(decoded.shape, self.frame.shape)

    def test_no_file_for_zero_or_invalid_detections(self):
        for rows in ([], [prediction(box={})]):
            self.assertIsNone(renderer.save_evidence(self.jpeg, rows, one_frame.CLASSES))
        self.assertFalse((self.root / "evidence").exists())

    def test_invalid_jpeg_and_save_failure_are_sanitized(self):
        with self.assertRaises(renderer.EvidenceError):
            renderer.save_evidence(b"PRIVATE_SECRET", [prediction()], one_frame.CLASSES)
        with patch.object(Path, "mkdir", side_effect=OSError("PRIVATE_SECRET")):
            with self.assertRaises(renderer.EvidenceError) as error:
                renderer.save_evidence(self.jpeg, [prediction()], one_frame.CLASSES)
        self.assertNotIn("PRIVATE_SECRET", str(error.exception))

    def run_cli(self, flags, rows):
        output = io.StringIO()
        before_jpeg = bytes(self.jpeg)
        def infer(endpoint, key, jpeg, requests):
            self.assertIs(jpeg, self.jpeg)
            self.assertFalse((self.root / "evidence").exists())
            return rows, 12.5
        with patch.object(sys, "argv", ["one_frame.py", "--json"] + flags), \
                patch.dict(sys.modules, {"requests": types.ModuleType("requests")}), \
                patch.object(one_frame, "configuration", return_value=("PRIVATE_CAMERA", "PRIVATE_ENDPOINT", "PRIVATE_SECRET")), \
                patch.object(one_frame, "capture_one_frame", return_value=(self.jpeg, 320, 180)) as capture, \
                patch.object(one_frame, "predict", side_effect=infer) as infer_mock, \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            self.assertEqual(one_frame.main(), 0)
        capture.assert_called_once()
        infer_mock.assert_called_once()
        self.assertEqual(self.jpeg, before_jpeg)
        self.assertNotIn("PRIVATE_", output.getvalue())
        self.assertIn('"predictions"', output.getvalue())
        return output.getvalue()

    def test_no_flags(self):
        self.run_cli([], [prediction()])
        self.assertFalse((self.root / "debug").exists())
        self.assertFalse((self.root / "evidence").exists())

    def test_save_frame_only(self):
        self.run_cli(["--save-frame"], [prediction()])
        self.assertEqual(next((self.root / "debug").glob("*.jpg")).read_bytes(), self.jpeg)
        self.assertFalse((self.root / "evidence").exists())

    def test_evidence_only(self):
        self.run_cli(["--save-evidence"], [prediction()])
        self.assertFalse((self.root / "debug").exists())
        self.assertEqual(len(list((self.root / "evidence").glob("*.jpg"))), 1)

    def test_both_flags_original_separate(self):
        self.run_cli(["--save-frame", "--save-evidence"], [prediction()])
        self.assertEqual(next((self.root / "debug").glob("*.jpg")).read_bytes(), self.jpeg)
        self.assertNotEqual(next((self.root / "evidence").glob("*.jpg")).read_bytes(), self.jpeg)

    def test_cli_zero_detections(self):
        output = self.run_cli(["--save-evidence"], [])
        self.assertIn("No detections; evidence image not created.", output)
        self.assertFalse((self.root / "evidence").exists())


if __name__ == "__main__":
    unittest.main()

"""Offline segmentation parsing, rendering, CLI and continuous compatibility."""

import contextlib
import copy
import io
import json
import math
import sys
import types
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import cv2
import numpy as np

import one_frame
import continuous_detection
import evidence_renderer as renderer
from prediction_geometry import MAX_POLYGON_POINTS, validated_segments


def row(**changes):
    value = {"class": 0, "name": "Plastic", "confidence": 0.7832,
             "box": {"x1": 40, "y1": 50, "x2": 160, "y2": 170},
             "segments": {"x": [60, 140, 100], "y": [70, 70, 150]}}
    value.update(changes)
    return value


def payload(rows):
    return {"images": [{"shape": [200, 240], "results": rows}],
            "metadata": {"classNames": ["Plastic"]}}


class SegmentationTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch("socket.socket.connect", side_effect=AssertionError("No network")))
        self.stack.enter_context(patch.object(one_frame, "configuration", side_effect=AssertionError("No private config")))
        self.stack.enter_context(patch.object(one_frame.subprocess, "run", side_effect=AssertionError("No camera")))

    def test_documented_polygon_and_new_class_mapping(self):
        source = payload([row()])
        before = copy.deepcopy(source)
        predictions, _ = one_frame.safe_predictions(source)
        self.assertEqual(predictions, [row()])
        self.assertEqual(source, before)
        source["metadata"]["classNames"] = {"0": "Plastic"}
        self.assertEqual(one_frame.safe_predictions(source)[0], predictions)
        source["metadata"]["classNames"] = ["Other"]
        self.assertEqual(one_frame.safe_predictions(source)[0], [])

    def test_missing_metadata_legacy_detection(self):
        source = payload([row(name="bottle", segments=None)])
        source.pop("metadata")
        result, _ = one_frame.safe_predictions(source)
        self.assertEqual(result[0]["name"], "bottle")
        self.assertNotIn("segments", result[0])

    def test_bad_individual_detection_does_not_drop_neighbors(self):
        bad = [None, {}, row(confidence=float("nan")), row(box={}),
               row(box={"x1": 0, "y1": 0, "x2": float("inf"), "y2": 2})]
        result, _ = one_frame.safe_predictions(payload(bad + [row()]))
        self.assertEqual(result, [row()])

    def test_bad_polygons_degrade_to_bbox(self):
        bad = [None, {}, {"x": [0, 1], "y": [0, 1]},
               {"x": [0, 1, 2], "y": [0, 1]},
               {"x": [0, 1, 2], "y": [0, 1, 2]},
               {"x": [1, 1, 1], "y": [2, 2, 2]},
               {"x": [0, "bad", 5], "y": [0, 10, 20]}]
        bad += [{"x": [0, value, 5], "y": [0, 10, 20]}
                for value in (float("nan"), float("inf"), -float("inf"))]
        for segments in bad:
            with self.subTest(segments=segments):
                result, _ = one_frame.safe_predictions(payload([row(segments=segments)]))
                self.assertEqual(len(result), 1)
                self.assertNotIn("segments", result[0])

    def test_boundary_clamping(self):
        result, _ = one_frame.safe_predictions(payload([row(
            segments={"x": [-3, 245, 245, -3], "y": [-4, -4, 205, 205]},
            box={"x1": -3, "y1": -4, "x2": 245, "y2": 205})]))
        self.assertEqual(result[0]["segments"], {"x": [0, 239, 239, 0], "y": [0, 0, 199, 199]})
        self.assertEqual(result[0]["box"], {"x1": 0, "y1": 0, "x2": 240, "y2": 200})
        self.assertIsNone(validated_segments({"x": [-3, -2, -1], "y": [1, 5, 8]}, 240, 200))

    def test_translucent_polygon_not_bbox_and_original_unchanged(self):
        original = np.full((200, 240, 3), 100, np.uint8)
        before = original.copy()
        result, count = renderer.render_predictions(original, [row()])
        self.assertEqual(count, 1)
        # Interior of actual triangle is blended, not replaced by an opaque fill.
        self.assertTrue(np.allclose(result[90, 100], [65, 154, 154], atol=1))
        # Inside bbox but outside triangle stays untouched (away from label).
        self.assertTrue(np.array_equal(result[160, 150], before[160, 150]))
        self.assertTrue(np.array_equal(original, before))

    def test_multiple_segmented_objects_and_bbox_fallback(self):
        frame = np.zeros((200, 240, 3), np.uint8)
        with patch.object(cv2, "fillPoly", wraps=cv2.fillPoly) as fill, \
                patch.object(cv2, "polylines", wraps=cv2.polylines) as outline:
            _, count = renderer.render_predictions(frame, [row(), row(), row(segments=None)])
        self.assertEqual(count, 3)
        self.assertEqual(fill.call_count, 2)
        self.assertEqual(outline.call_count, 2)

    def test_evidence_jpeg_and_zero_predictions(self):
        jpeg = cv2.imencode(".jpg", np.full((200, 240, 3), 100, np.uint8))[1].tobytes()
        before = bytes(jpeg)
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(renderer, "__file__", str(Path(temp) / "evidence_renderer.py")):
            self.assertIsNone(renderer.save_evidence(jpeg, []))
            self.assertFalse((Path(temp) / "evidence").exists())
            path = renderer.save_evidence(jpeg, [row()])
            self.assertTrue(path.exists())
            self.assertEqual(cv2.imdecode(np.frombuffer(path.read_bytes(), np.uint8), 1).shape, (200, 240, 3))
        self.assertEqual(jpeg, before)

    def test_large_polygon_json_bounded_render_geometry_retained(self):
        angles = [2 * math.pi * i / 200 for i in range(200)]
        segments = {"x": [100 + 30 * math.cos(a) for a in angles],
                    "y": [100 + 30 * math.sin(a) for a in angles]}
        predictions, _ = one_frame.safe_predictions(payload([row(segments=segments)]))
        compact = one_frame.compact_predictions(predictions)
        self.assertNotIn("segments", compact[0])
        self.assertEqual(compact[0]["segmentation"]["pointCount"], 200)
        self.assertEqual(len(predictions[0]["segments"]["x"]), 200)
        self.assertLess(len(json.dumps(compact)), 500)
        self.assertIsNone(validated_segments({"x": [0] * (MAX_POLYGON_POINTS + 1),
                                             "y": [0] * (MAX_POLYGON_POINTS + 1)}, 240, 200))

    def test_safe_logs_and_continuous_point_counts(self):
        bad = row(name="SecretToken")
        source = payload([bad, row()])
        source.pop("metadata")
        predictions, _ = one_frame.safe_predictions(source, ("SecretToken",))
        output = io.StringIO()
        with patch.object(continuous_detection, "capture_one_frame", return_value=(b"jpeg", 240, 200)), \
                patch.object(continuous_detection, "predict", return_value=(predictions, 1)), \
                contextlib.redirect_stdout(output):
            continuous_detection.run_cycle("private", "private", "SecretToken", None)
        self.assertIn("segmentation: 3 points", output.getvalue())
        self.assertNotIn("SecretToken", output.getvalue())
        self.assertNotIn("'x': [", output.getvalue())

    def test_empty_and_invalid_envelope(self):
        self.assertEqual(one_frame.safe_predictions(payload([]))[0], [])
        with self.assertRaises(one_frame.BridgeError):
            one_frame.safe_predictions({"images": []})

    def test_segmented_one_frame_both_save_flags_exact_upload(self):
        jpeg = cv2.imencode(".jpg", np.full((200, 240, 3), 100, np.uint8))[1].tobytes()
        def cloud(endpoint, key, uploaded, requests):
            self.assertIs(uploaded, jpeg)
            return one_frame.safe_predictions(payload([row()]))
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(one_frame, "__file__", str(Path(temp) / "one_frame.py")), \
                patch.object(renderer, "__file__", str(Path(temp) / "evidence_renderer.py")), \
                patch.object(sys, "argv", ["one_frame.py", "--json", "--save-frame", "--save-evidence"]), \
                patch.dict(sys.modules, {"requests": types.ModuleType("requests")}), \
                patch.object(one_frame, "configuration", return_value=("PRIVATE_CAMERA", "PRIVATE_ENDPOINT", "PRIVATE_KEY")), \
                patch.object(one_frame, "capture_one_frame", return_value=(jpeg, 240, 200)) as capture, \
                patch.object(one_frame, "predict", side_effect=cloud) as request, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(one_frame.main(), 0)
            capture.assert_called_once()
            request.assert_called_once()
            self.assertEqual(next((Path(temp) / "debug").glob("*.jpg")).read_bytes(), jpeg)
            self.assertEqual(len(list((Path(temp) / "evidence").glob("*.jpg"))), 1)
            self.assertIn("segmentation: 3 points", output.getvalue())
            self.assertNotIn("PRIVATE_", output.getvalue())


if __name__ == "__main__":
    unittest.main()

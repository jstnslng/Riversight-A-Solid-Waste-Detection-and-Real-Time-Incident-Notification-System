"""Visualize cloud predictions on the exact uploaded JPEG; no inference here."""

from datetime import datetime
import math
from pathlib import Path
from uuid import uuid4

import cv2
import numpy as np

from prediction_geometry import safe_class_name, validated_segments


class EvidenceError(Exception):
    """Fixed safe error messages only."""


def drawing_box(box, width, height):
    try:
        coordinates = [box[key] for key in ("x1", "y1", "x2", "y2")]
        if any(type(value) not in (int, float) or not math.isfinite(value)
               for value in coordinates):
            return None
        x1, y1, x2, y2 = coordinates
        if x2 <= x1 or y2 <= y1 or x2 <= 0 or y2 <= 0 or x1 >= width or y1 >= height:
            return None
        x1, x2 = max(0, min(width - 1, x1)), max(0, min(width - 1, x2))
        y1, y2 = max(0, min(height - 1, y1)), max(0, min(height - 1, y2))
        result = (math.floor(x1), math.floor(y1), math.ceil(x2), math.ceil(y2))
        return result if result[2] > result[0] and result[3] > result[1] else None
    except (KeyError, TypeError, ValueError, OverflowError):
        return None


def render_predictions(frame, predictions, class_names=None):
    annotated = frame.copy()
    height, width = annotated.shape[:2]
    count = 0
    for prediction in predictions:
        try:
            class_id, confidence = prediction["class"], prediction["confidence"]
            if (type(class_id) is not int or not 0 <= class_id <= 10000
                    or not safe_class_name(prediction["name"])
                    or type(confidence) not in (int, float)
                    or not math.isfinite(confidence) or not 0 <= confidence <= 1):
                continue
            if class_names is not None and (class_id >= len(class_names) or prediction["name"] != class_names[class_id]):
                continue
            box = drawing_box(prediction["box"], width, height)
            if box is None:
                continue
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
        x1, y1, x2, y2 = box
        color = (0, 255, 255)
        segments = validated_segments(prediction.get("segments"), width, height)
        polygon = None
        if segments:
            polygon = np.rint(np.column_stack((segments["x"], segments["y"]))).astype(np.int32)
            if abs(cv2.contourArea(polygon)) < 0.5:
                polygon = None
        if polygon is not None:
            overlay = annotated.copy()
            cv2.fillPoly(overlay, [polygon], color)
            cv2.addWeighted(overlay, 0.35, annotated, 0.65, 0, dst=annotated)
            cv2.polylines(annotated, [polygon], True, color, 2)
        else:
            cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 2)
        label = f"{prediction['name']} {confidence * 100:.1f}%"
        font, scale = cv2.FONT_HERSHEY_SIMPLEX, 0.6
        (text_width, text_height), baseline = cv2.getTextSize(label, font, scale, 1)
        if text_width + 8 > width:
            scale *= max(0.01, (width - 8) / (text_width + 1))
            (text_width, text_height), baseline = cv2.getTextSize(label, font, scale, 1)
        left = max(0, min(x1, width - text_width - 8))
        top = max(0, min(y1 - text_height - baseline - 8,
                         height - text_height - baseline - 8))
        cv2.rectangle(annotated, (left, top),
                      (min(width - 1, left + text_width + 8),
                       min(height - 1, top + text_height + baseline + 8)), color, -1)
        cv2.putText(annotated, label,
                    (min(width - 1, left + 4), min(height - 1, top + text_height + 4)),
                    font, scale, (0, 0, 0), 1, cv2.LINE_AA)
        count += 1
    return annotated, count


def save_evidence(jpeg, predictions, class_names=None):
    """Return a saved path, or None when no valid detections can be drawn."""
    if not predictions:
        return None
    try:
        original = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
        if original is None:
            raise ValueError()
        annotated, count = render_predictions(original, predictions, class_names)
        if not count:
            return None
        ok, encoded = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 95])
        if not ok:
            raise ValueError()
        directory = Path(__file__).resolve().parent / "evidence"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"detection_{datetime.now():%Y%m%d_%H%M%S_%f}_{uuid4().hex}.jpg"
        with path.open("xb") as output:
            output.write(encoded.tobytes())
        return path
    except Exception:
        raise EvidenceError("Unable to create evidence image. Diagnostic details withheld.") from None

"""Bounded validation of cloud geometry; no inference or graphics dependencies."""

import math
import re

MAX_POLYGON_POINTS = 20000


def finite_number(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def safe_class_name(value, sensitive_values=()):
    return (isinstance(value, str)
            and re.fullmatch(r"[A-Za-z][A-Za-z0-9 ()-]{0,63}", value) is not None
            and not any(secret and secret in value for secret in sensitive_values))


def validated_box(box, width, height):
    try:
        x1, y1, x2, y2 = (box[k] for k in ("x1", "y1", "x2", "y2"))
        if not all(finite_number(v) for v in (x1, y1, x2, y2)):
            return None
        if x2 <= x1 or y2 <= y1:
            return None
        x1, x2 = max(0, min(width, x1)), max(0, min(width, x2))
        y1, y2 = max(0, min(height, y1)), max(0, min(height, y2))
        if x2 <= x1 or y2 <= y1:
            return None
        return dict(x1=x1, y1=y1, x2=x2, y2=y2)
    except (KeyError, TypeError, ValueError):
        return None


def validated_segments(segments, width, height):
    """Accept documented x/y arrays in original-image pixels; never infer masks."""
    try:
        xs, ys = segments["x"], segments["y"]
        if (not isinstance(xs, list) or not isinstance(ys, list)
                or len(xs) != len(ys) or not 3 <= len(xs) <= MAX_POLYGON_POINTS):
            return None
        if not all(finite_number(v) for v in xs + ys):
            return None
        points = []
        for x, y in zip(xs, ys):
            point = (max(0, min(width - 1, x)), max(0, min(height - 1, y)))
            if not points or point != points[-1]:
                points.append(point)
        if len(points) > 1 and points[0] == points[-1]:
            points.pop()
        if len(set(points)) < 3:
            return None
        area = sum(x * points[(i + 1) % len(points)][1]
                   - y * points[(i + 1) % len(points)][0]
                   for i, (x, y) in enumerate(points))
        if not math.isfinite(area) or abs(area) < 1e-6:
            return None
        return {"x": [p[0] for p in points], "y": [p[1] for p in points]}
    except (KeyError, TypeError, ValueError, OverflowError):
        return None

"""Bounded validation of cloud geometry; no inference or graphics dependencies."""

import math
import re

MAX_POLYGON_POINTS = 20000


def normalized_roi(config, width, height):
    """Strict simple polygon; never clamp or silently repair an approved ROI."""
    if not isinstance(config, dict) or config.get("state") != "approved":
        raise ValueError("roi_not_approved")
    version = config.get("version")
    source = config.get("imageDimensions", {})
    sw, sh = source.get("width"), source.get("height")
    if (type(version) is not int or version < 1 or type(sw) is not int
            or type(sh) is not int or min(sw, sh, width, height) < 2
            or sw * height != sh * width):
        raise ValueError("image_dimensions_mismatch")
    points = config.get("points")
    space = config.get("coordinateSpace")
    if not isinstance(points, list) or not 3 <= len(points) <= 256 or space not in ("normalized", "pixels"):
        raise ValueError("invalid_roi")
    polygon = []
    for point in points:
        # Maps are canonical Firestore storage; pairs remain readable for legacy
        # local configuration and in-memory cloud polygon validation.
        if isinstance(point, dict):
            if set(point) != {"x", "y"}:
                raise ValueError("invalid_roi")
            point = [point["x"], point["y"]]
        if not isinstance(point, list) or len(point) != 2 or not all(finite_number(v) for v in point):
            raise ValueError("invalid_roi")
        x, y = point
        if space == "pixels":
            x, y = x / (sw - 1), y / (sh - 1)
        if not 0 <= x <= 1 or not 0 <= y <= 1:
            raise ValueError("invalid_roi")
        polygon.append((x, y))
    if len(set(polygon)) != len(polygon):
        raise ValueError("invalid_roi")
    def cross(a, b, c):
        return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
    def on(a, b, c):
        return cross(a, b, c) == 0 and min(a[0], b[0]) <= c[0] <= max(a[0], b[0]) and min(a[1], b[1]) <= c[1] <= max(a[1], b[1])
    for i, a in enumerate(polygon):
        b = polygon[(i+1) % len(polygon)]
        for j in range(i+1, len(polygon)):
            if j == i+1 or (i == 0 and j == len(polygon)-1):
                continue
            c, d = polygon[j], polygon[(j+1) % len(polygon)]
            if (cross(a,b,c)*cross(a,b,d) < 0 and cross(c,d,a)*cross(c,d,b) < 0
                    or on(a,b,c) or on(a,b,d) or on(c,d,a) or on(c,d,b)):
                raise ValueError("invalid_roi")
    if abs(sum(a[0]*polygon[(i+1)%len(polygon)][1]-a[1]*polygon[(i+1)%len(polygon)][0]
               for i,a in enumerate(polygon))) < 1e-9:
        raise ValueError("invalid_roi")
    return polygon


def finite_number(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def safe_class_name(value, sensitive_values=()):
    return (isinstance(value, str)
            and re.fullmatch(r"[A-Za-z][A-Za-z0-9_ ()-]{0,63}", value) is not None
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

"""Bounded CPU optical-flow visualization. No classification or neural model."""

from collections import deque
from copy import deepcopy
import math
import threading
import time

import cv2
import numpy as np

from evidence_renderer import render_predictions
from prediction_geometry import validated_box, validated_segments

MAX_TRACKS = 12
MIN_POINTS = 6
MAX_POINTS = 40


def gray_frame(frame):
    height, width = frame.shape[:2]
    scale = min(1, 640 / max(width, height))
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return cv2.resize(gray, (max(1, round(width * scale)), max(1, round(height * scale))))


def overlap(a, b):
    intersection = max(0, min(a['x2'], b['x2']) - max(a['x1'], b['x1'])) * max(
        0, min(a['y2'], b['y2']) - max(a['y1'], b['y1']))
    area = lambda box: (box['x2'] - box['x1']) * (box['y2'] - box['y1'])
    return intersection / max(1, area(a) + area(b) - intersection)


class VisualTracker:
    def __init__(self, max_age=3, fps=10):
        self.max_age = max_age
        self.max_gap = max(0.35, 1.5 / fps)
        self.history = deque(maxlen=math.ceil(max_age * 15) + 2)
        self.tracks = []
        self.shape = None
        self.next_id = 1

    def reset(self):
        self.history.clear()
        self.tracks.clear()
        self.shape = None

    def _row(self, track):
        height, width = self.shape
        row = deepcopy(track['reference'])
        dx, dy = track['shift'] / track['ratio']
        box = row['box']
        moved = {key: float(value + (dx if key.startswith('x') else dy)) for key, value in box.items()}
        clipped = validated_box(moved, width, height)
        if clipped is None:
            return None
        area = (moved['x2'] - moved['x1']) * (moved['y2'] - moved['y1'])
        visible = (clipped['x2'] - clipped['x1']) * (clipped['y2'] - clipped['y1'])
        if visible < area * 0.5 or min(clipped['x2'] - clipped['x1'], clipped['y2'] - clipped['y1']) < 4:
            return None
        row['box'] = clipped
        if 'segments' in row:
            moved_polygon = {'x': [float(x + dx) for x in row['segments']['x']],
                             'y': [float(y + dy) for y in row['segments']['y']]}
            polygon = validated_segments(moved_polygon, width, height)
            if polygon is None:
                return None
            row['segments'] = polygon
        return row

    def _alive(self, track, stamp):
        return stamp - track['yolo_at'] < self.max_age and stamp < track['miss_deadline']

    def _move(self, tracks, previous, current, before, stamp):
        tracks = [track for track in tracks if self._alive(track, stamp)]
        if not tracks or not 0 < stamp - before <= self.max_gap or previous.shape != current.shape:
            return []
        points = np.concatenate([track['points'] for track in tracks]).astype(np.float32).reshape(-1, 1, 2)
        params = dict(winSize=(21, 21), maxLevel=2,
                      criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 20, 0.03))
        forward, status, error = cv2.calcOpticalFlowPyrLK(previous, current, points, None, **params)
        if forward is None or status is None or error is None or not np.isfinite(forward).all():
            return []
        backward, back_status, _ = cv2.calcOpticalFlowPyrLK(current, previous, forward, None, **params)
        if backward is None or back_status is None:
            return []
        original, moved = points.reshape(-1, 2), forward.reshape(-1, 2)
        fb_error = np.linalg.norm(backward.reshape(-1, 2) - original, axis=1)
        good = ((status.ravel() == 1) & (back_status.ravel() == 1) & (error.ravel() < 25)
                & (fb_error < 1.0) & np.isfinite(fb_error)
                & (moved[:, 0] >= 0) & (moved[:, 0] < current.shape[1])
                & (moved[:, 1] >= 0) & (moved[:, 1] < current.shape[0]))
        output, start = [], 0
        for track in tracks:
            end = start + len(track['points'])
            valid = good[start:end].copy()
            delta = moved[start:end] - original[start:end]
            if valid.sum() >= MIN_POINTS:
                translation = np.median(delta[valid], axis=0)
                valid &= np.linalg.norm(delta - translation, axis=1) < 2.5
                box = track['reference']['box']
                diagonal = np.linalg.norm(np.array([box['x2'] - box['x1'], box['y2'] - box['y1']]) * track['ratio'])
                limit = min(30, 0.35 * diagonal + 2, 100 * (stamp - before) + 2)
                if valid.sum() >= max(MIN_POINTS, math.ceil(len(valid) * 0.6)) and np.linalg.norm(translation) <= limit:
                    track['points'] = moved[start:end][valid].copy()
                    track['shift'] += translation
                    track['last_tracking_at'] = stamp
                    track['quality'] = float(valid.mean())
                    if self._row(track) is not None:
                        output.append(track)
            start = end
        return output

    def advance(self, frame, stamp):
        shape = frame.shape[:2]
        if self.shape is not None and shape != self.shape:
            self.reset()
        self.shape = shape
        gray = gray_frame(frame)
        if self.history:
            before, previous = self.history[-1]
            if stamp <= before:
                return  # Never move tracking or presentation back in time.
            self.tracks = self._move(self.tracks, previous, gray, before, stamp)
        self.history.append((stamp, gray))
        while self.history and stamp - self.history[0][0] > self.max_age:
            self.history.popleft()

    def _seed(self, source, predictions, stamp):
        height, width = self.shape
        ratio = np.array([source.shape[1] / width, source.shape[0] / height], dtype=np.float32)
        tracks = []
        for prediction in sorted(predictions, key=lambda row: row['confidence'], reverse=True)[:MAX_TRACKS]:
            box = prediction['box']
            mask = np.zeros(source.shape, np.uint8)
            if prediction.get('segments'):
                polygon = np.column_stack((prediction['segments']['x'], prediction['segments']['y'])) * ratio
                cv2.fillPoly(mask, [np.rint(polygon).astype(np.int32)], 255)
            else:
                first = tuple(np.rint([box['x1'] * ratio[0], box['y1'] * ratio[1]]).astype(int))
                last = tuple(np.rint([box['x2'] * ratio[0], box['y2'] * ratio[1]]).astype(int))
                cv2.rectangle(mask, first, last, 255, -1)
            mask = cv2.erode(mask, np.ones((3, 3), np.uint8))
            points = cv2.goodFeaturesToTrack(source, MAX_POINTS, 0.02, 4, mask=mask)
            if points is None or len(points) < MIN_POINTS:
                continue
            tracks.append(dict(id=None, reference=deepcopy(prediction), points=points.reshape(-1, 2),
                               ratio=ratio.copy(), shift=np.zeros(2, np.float32), yolo_at=stamp,
                               last_tracking_at=stamp, quality=1.0, miss_deadline=math.inf))
        return tracks

    def correct(self, source_frame, predictions, source_stamp, now):
        # A delayed cloud result must be visually aligned through the bounded
        # history. Never seed old coordinates directly on the current image.
        if (not self.history or source_frame.shape[:2] != self.shape
                or not 0 <= now - source_stamp < self.max_age
                or source_stamp > self.history[-1][0]):
            return
        source = gray_frame(source_frame)
        candidates = self._seed(source, predictions, source_stamp)
        before = source_stamp
        for stamp, gray in self.history:
            if stamp > source_stamp:
                if stamp - before > self.max_gap:
                    return  # Missing history: reject this correction entirely.
                candidates = self._move(candidates, source, gray, before, stamp)
                source, before = gray, stamp
        unused = list(self.tracks)
        old_rows = {id(track): self._row(track) for track in unused}
        candidate_rows = [(track, self._row(track)) for track in candidates]
        for candidate, row in candidate_rows:
            if row is None:
                continue
            matches = []
            for old in unused:
                old_row = old_rows[id(old)]
                if old_row and old_row['class'] == row['class']:
                    score = overlap(row['box'], old_row['box'])
                    box, old_box = row['box'], old_row['box']
                    distance = math.hypot((box['x1'] + box['x2'] - old_box['x1'] - old_box['x2']) / 2,
                                          (box['y1'] + box['y2'] - old_box['y1'] - old_box['y2']) / 2)
                    diagonal = math.hypot(old_box['x2'] - old_box['x1'], old_box['y2'] - old_box['y1'])
                    if score >= 0.3 and distance <= diagonal * 0.5:
                        matches.append((score, old))
            if matches:
                old = max(matches, key=lambda match: match[0])[1]
                candidate['id'] = old['id']
                unused = [track for track in unused if track is not old]
            else:
                candidate['id'] = self.next_id
                self.next_id += 1
        # One miss gets at most 0.5 seconds grace, never resetting max YOLO age.
        supported_boxes = [row['box'] for candidate, row in candidate_rows if candidate['id'] is not None]
        unused = [old for old in unused if old_rows[id(old)] is not None and not any(
            overlap(old_rows[id(old)]['box'], box) >= 0.3 for box in supported_boxes)]
        for old in unused:
            old['miss_deadline'] = min(old['miss_deadline'], now + 0.5)
        self.tracks = ([track for track in candidates if track['id'] is not None]
                       + [track for track in unused if self._alive(track, now)])[:MAX_TRACKS]

    def rows(self, now):
        self.tracks = [track for track in self.tracks if self._alive(track, now)]
        return [row for track in self.tracks if (row := self._row(track)) is not None]


class TrackingWorker:
    """Single owner of optical-flow history; readers see only immutable JPEGs."""

    def __init__(self, state):
        self.state = state
        self.tracker = VisualTracker(state.track_max_age, state.fps)
        self.epoch = None
        self.worker = None

    def start(self):
        self.worker = threading.Thread(target=self.run, daemon=True)
        self.worker.start()

    def close(self):
        self.state.frame_ready.set()
        if self.worker is not None:
            self.worker.join(timeout=5)

    def tick(self):
        raw, stamp, epoch, correction = self.state.tracking_input()
        if epoch != self.epoch:
            self.tracker.reset()
            self.epoch = epoch
        if raw is None or time.monotonic() - stamp >= 3:
            self.tracker.reset()
            return
        frame = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            raise ValueError('Invalid tracking frame.')
        self.tracker.advance(frame, stamp)
        if correction is not None:
            source, predictions, source_stamp, source_epoch = correction
            if source_epoch == epoch:
                decoded = cv2.imdecode(np.frombuffer(source, np.uint8), cv2.IMREAD_COLOR)
                if decoded is not None:
                    self.tracker.correct(decoded, predictions, source_stamp, time.monotonic())
        rows = self.tracker.rows(time.monotonic())
        output = raw
        if rows:
            display, _ = render_predictions(frame, rows)
            label = 'TRACKED ESTIMATE | labels: last YOLO confidence'
            scale = max(0.25, min(0.6, display.shape[1] / 1000))
            cv2.rectangle(display, (0, 0), (display.shape[1], 28), (0, 0, 0), -1)
            cv2.putText(display, label, (4, 19), cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 255), 1, cv2.LINE_AA)
            ok, jpeg = cv2.imencode('.jpg', display, [cv2.IMWRITE_JPEG_QUALITY, 95])
            if not ok:
                raise ValueError('Could not encode tracking frame.')
            output = jpeg.tobytes()
        expiry = min((min(track['yolo_at'] + self.tracker.max_age, track['miss_deadline'])
                      for track in self.tracker.tracks), default=stamp + 3)
        self.state.publish_tracked(output, stamp, epoch, len(rows), expiry)

    def run(self):
        while not self.state.stop.is_set():
            self.state.frame_ready.wait(0.2)
            if self.state.stop.is_set():
                break
            if not self.state.frame_ready.is_set():
                continue
            self.state.frame_ready.clear()
            try:
                self.tick()
            except Exception:
                self.tracker.reset()
                self.state.tracking_failed()
                # No raw OpenCV errors, images, URLs or exception messages logged.

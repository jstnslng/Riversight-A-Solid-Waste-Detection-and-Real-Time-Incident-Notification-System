"""Asynchronous, lifecycle-based Firestore recording for validated YOLO rows."""

from collections import deque
import math
import os
import queue
import re
import threading
import time
import uuid


CAMERA_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")


def _overlap(first, second):
    intersection = max(0, min(first["x2"], second["x2"]) - max(first["x1"], second["x1"])) * max(
        0, min(first["y2"], second["y2"]) - max(first["y1"], second["y1"]))
    first_area = max(1, (first["x2"] - first["x1"]) * (first["y2"] - first["y1"]))
    second_area = max(1, (second["x2"] - second["x1"]) * (second["y2"] - second["y1"]))
    return intersection / max(1, first_area + second_area - intersection)


def _center_distance(first, second):
    return math.hypot(
        (first["x1"] + first["x2"] - second["x1"] - second["x2"]) / 2,
        (first["y1"] + first["y2"] - second["y1"] - second["y2"]) / 2,
    )


class DetectionRecorder:
    """Track validated YOLO observations and write bounded, idempotent updates."""

    SHUTDOWN_TIMEOUT_SECONDS = 2

    def __init__(self, camera_doc_id, write, server_timestamp, resolve_active=None,
                 timeout=None, write_interval=None, session_id=None):
        if not isinstance(camera_doc_id, str) or not CAMERA_ID.fullmatch(camera_doc_id):
            raise ValueError("Invalid detection camera identifier.")
        self.camera_doc_id = camera_doc_id
        self.write = write
        self.server_timestamp = server_timestamp
        self.resolve_active = resolve_active
        self.timeout = self._setting(timeout, "SEGMENTATION_DETECTION_LIFETIME_SECONDS", 5, 1, 120)
        self.write_interval = self._setting(
            write_interval, "SEGMENTATION_DETECTION_WRITE_INTERVAL_SECONDS", 2, 1, 60)
        self.session_id = session_id or uuid.uuid4().hex
        if not re.fullmatch(r"[A-Za-z0-9]{16,64}", self.session_id):
            raise ValueError("Invalid detection session identifier.")
        self.next_track = 0
        self.tracks = {}
        self.lock = threading.Lock()
        self.work = queue.Queue(maxsize=256)
        self.failures = deque(maxlen=20)
        self.stop = threading.Event()
        self.worker = threading.Thread(target=self._run, name="detection-firestore-writer", daemon=True)
        self.worker.start()
        if self.resolve_active is not None:
            self._enqueue(("restart", None, None))

    @staticmethod
    def _setting(value, name, environment, minimum, maximum):
        raw = value if value is not None else os.environ.get(name, str(environment))
        try:
            parsed = float(raw)
        except (TypeError, ValueError):
            raise ValueError(f"{name} must be a finite number from {minimum} to {maximum}.") from None
        if not math.isfinite(parsed) or not minimum <= parsed <= maximum:
            raise ValueError(f"{name} must be a finite number from {minimum} to {maximum}.")
        return parsed

    def _enqueue(self, action):
        try:
            self.work.put_nowait(action)
        except queue.Full:
            self.failures.append("queue_full")

    def _run(self):
        while not self.stop.is_set():
            try:
                action = self.work.get(timeout=0.1)
            except queue.Empty:
                continue
            try:
                kind, detection_id, payload = action
                if kind == "restart":
                    self.resolve_active(self.camera_doc_id)
                else:
                    self.write(detection_id, payload)
            except Exception:
                self.failures.append("firestore_write_failed")
                print("Detection recording failed; live inference continues.", flush=True)
            finally:
                self.work.task_done()
        while True:
            try:
                self.work.get_nowait()
            except queue.Empty:
                return
            self.work.task_done()

    def _match(self, row):
        matches = []
        for track_id, track in self.tracks.items():
            if track["classId"] != row["class"]:
                continue
            score = _overlap(track["box"], row["box"])
            distance = _center_distance(track["box"], row["box"])
            diagonal = math.hypot(track["box"]["x2"] - track["box"]["x1"],
                                  track["box"]["y2"] - track["box"]["y1"])
            if score >= 0.3 and distance <= diagonal * 0.5:
                matches.append((score, track_id))
        return max(matches, default=(0, None))[1]

    def _payload(self, row, camera_id, tracking_id, initial=False):
        payload = {
            "cameraDocId": self.camera_doc_id,
            "wasteClass": row["name"],
            "classId": row["class"],
            "confidenceScore": row["confidence"] * 100,
            "confidence": row["confidence"],
            "lastSeenAt": self.server_timestamp(),
            "trackingId": tracking_id,
            "status": "active",
            "boundingBox": dict(row["box"]),
        }
        if camera_id is not None:
            payload["cameraId"] = camera_id
        if initial:
            payload["timestamp"] = self.server_timestamp()
        return payload

    def observe(self, predictions, camera_id=None, now=None):
        """Record one successful inference without waiting for Firestore."""
        now = time.monotonic() if now is None else now
        valid_camera = camera_id if isinstance(camera_id, str) and CAMERA_ID.fullmatch(camera_id) else None
        observations = [row for row in predictions if isinstance(row, dict)
                        and isinstance(row.get("class"), int)
                        and isinstance(row.get("name"), str)
                        and isinstance(row.get("confidence"), (int, float))
                        and math.isfinite(row["confidence"]) and 0 <= row["confidence"] <= 1
                        and isinstance(row.get("box"), dict)]
        with self.lock:
            seen = set()
            for row in observations:
                track_id = self._match(row)
                if track_id is None:
                    self.next_track += 1
                    track_id = f"{self.session_id}:{self.next_track}"
                    self.tracks[track_id] = {
                        "classId": row["class"], "box": dict(row["box"]),
                        "last_seen": now, "last_write": now,
                    }
                    self._enqueue(("write", track_id, self._payload(row, valid_camera, track_id, True)))
                else:
                    track = self.tracks[track_id]
                    track.update(classId=row["class"], box=dict(row["box"]), last_seen=now)
                    if now - track["last_write"] >= self.write_interval:
                        track["last_write"] = now
                        self._enqueue(("write", track_id, self._payload(row, valid_camera, track_id)))
                seen.add(track_id)
            for track_id, track in list(self.tracks.items()):
                if track_id in seen or now - track["last_seen"] < self.timeout:
                    continue
                self._enqueue(("write", track_id, {
                    "cameraDocId": self.camera_doc_id,
                    "trackingId": track_id,
                    "status": "resolved",
                    "lastSeenAt": self.server_timestamp(),
                    "resolvedAt": self.server_timestamp(),
                }))
                del self.tracks[track_id]

    def flush(self):
        self.work.join()

    def close(self):
        self.stop.set()
        self.worker.join(timeout=self.SHUTDOWN_TIMEOUT_SECONDS)
        if self.worker.is_alive():
            self.failures.append("shutdown_timeout")

"""Shared live MJPEG with sequential cloud inference and exact-frame snapshots."""

from datetime import datetime, timedelta, timezone
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import math
import os
import re
import threading
import time
from urllib.parse import parse_qs, urlsplit

import cv2
import numpy as np

from one_frame import configuration, capture_one_frame, predict
from evidence_renderer import render_predictions
from live_capture import LiveCapture
from visual_tracking import MAX_TRACKS, TrackingWorker


def tracking_configuration():
    try:
        enabled = os.environ.get("SEGMENTATION_TRACKING_ENABLED", "true").lower().strip()
        age = float(os.environ.get("SEGMENTATION_TRACK_MAX_AGE_SECONDS", "3"))
        if enabled not in ("true", "false") or not math.isfinite(age) or not 0.5 <= age <= 10:
            raise ValueError()
        return enabled == "true", age
    except (TypeError, ValueError):
        raise ValueError("Invalid tracking settings. Use true/false and max age 0.5 to 10 seconds.") from None


def stream_configuration():
    try:
        fps = float(os.environ.get("SEGMENTATION_STREAM_FPS", "10"))
        if not math.isfinite(fps) or (fps != 0 and not 1 <= fps <= 15):
            raise ValueError()
        return fps
    except (TypeError, ValueError):
        raise ValueError("Invalid stream FPS. Use 0 for snapshots or 1 to 15 for streaming.") from None


def feed_configuration():
    try:
        interval = float(os.environ.get("SEGMENTATION_INTERVAL_SECONDS", "2"))
        port = int(os.environ.get("SEGMENTATION_FEED_PORT", "5001"))
        host = os.environ.get("SEGMENTATION_FEED_HOST", "127.0.0.1")
        if not math.isfinite(interval) or not 1 <= interval <= 86400 or not 1 <= port <= 65535:
            raise ValueError()
        if ipaddress.ip_address(host).version != 4:
            raise ValueError()
        origins = tuple(value.strip() for value in os.environ.get(
            "SEGMENTATION_ALLOWED_ORIGINS",
            "http://127.0.0.1:5500,http://localhost:5500,http://127.0.0.1:8000,http://localhost:8000"
        ).split(",") if value.strip())
        for origin in origins:
            url = urlsplit(origin)
            if (url.scheme not in ("http", "https") or not url.hostname or url.username
                    or url.password or url.path or url.query or url.fragment):
                raise ValueError()
            url.port
        return host, port, interval, origins
    except (ValueError, TypeError):
        raise ValueError("Invalid feed settings. Check interval, IPv4 host, port and exact allowed origins.") from None


class LatestFrame:
    def __init__(self, camera_doc_id=""):
        if not re.fullmatch(r"[A-Za-z0-9_-]{0,128}", camera_doc_id):
            raise ValueError("Invalid public camera document identifier.")
        self.camera_doc_id = camera_doc_id
        self.lock = threading.Lock()
        self.jpeg = None
        self.at = None
        self.count = 0
        self.failed = False
        self.latencies = deque(maxlen=60)
        self.timing = dict(lastInferenceCapturedAt=None, lastCloudRequestAt=None, lastCloudResponseAt=None,
                           latestInferenceLatencyMs=None, averageInferenceLatencyMs=None, inferenceFrameAgeMs=None)

    def record_timing(self, captured_at, captured_mono, started_at, started, ended_at, ended):
        with self.lock:
            latency = max(0, (ended - started) * 1000)
            self.latencies.append(latency)
            self.timing.update(lastInferenceCapturedAt=captured_at, lastCloudRequestAt=started_at,
                               lastCloudResponseAt=ended_at, latestInferenceLatencyMs=round(latency, 2),
                               averageInferenceLatencyMs=round(sum(self.latencies) / len(self.latencies), 2),
                               inferenceFrameAgeMs=round(max(0, (ended - captured_mono) * 1000), 2))

    def publish(self, jpeg, count):
        # JPEG and matching metadata become visible in one locked operation.
        with self.lock:
            self.jpeg, self.count = bytes(jpeg), count
            self.at = datetime.now(timezone.utc).isoformat()
            self.failed = False

    def failure(self):
        with self.lock:
            self.failed = True

    def snapshot(self):
        with self.lock:
            return self.jpeg, {"status": "degraded" if self.failed else "ok" if self.jpeg else "waiting",
                               "model": "YOLOv8n-seg", "latestFrameAvailable": self.jpeg is not None,
                               "lastInferenceAt": self.at, "lastPredictionCount": self.count,
                               "cameraDocId": self.camera_doc_id, **self.timing}


class StreamingFrame(LatestFrame):
    """Latest-only publication; history/tracking belong to one visualization worker."""

    def __init__(self, camera_doc_id, fps, interval, stop, tracking_enabled=True, track_max_age=3):
        super().__init__(camera_doc_id)
        self.lock = threading.RLock()
        self.fps, self.interval, self.stop = fps, interval, stop
        self.raw = None
        self.raw_at = None
        self.raw_mono = 0
        self.result_mono = 0
        self.tracking_enabled, self.track_max_age = tracking_enabled, track_max_age
        self.frame_ready = threading.Event()
        self.epoch = 0
        self.pending = None
        self.rendered = None
        self.rendered_mono = 0
        self.rendered_expiry = 0
        self.active_tracks = 0
        self.tracking_at = None
        self.clients = threading.BoundedSemaphore(8)
        self.sessions = set()  # At most one entry per admitted viewer (max eight).

    def client_active(self, session):
        with self.lock:
            return session in self.sessions

    def publish_raw(self, jpeg, captured):
        with self.lock:
            if captured <= self.raw_mono:
                return
            self.raw, self.raw_mono = bytes(jpeg), captured
            self.raw_at = (datetime.now(timezone.utc)
                           - timedelta(seconds=max(0, time.monotonic() - captured))).isoformat()
        if self.tracking_enabled:
            self.frame_ready.set()

    def raw_time(self):
        with self.lock:
            return self.raw_mono

    def capture_failed(self):
        with self.lock:
            self.raw = None
            self.epoch += 1
            self.pending = None
            self.rendered = None
            self.active_tracks = 0
        self.frame_ready.set()

    def inference_frame(self):
        with self.lock:
            if self.raw is None or time.monotonic() - self.raw_mono >= 3:
                raise ValueError("No fresh camera frame.")
            return self.raw, self.raw_at, self.raw_mono, self.epoch

    def publish_result(self, jpeg, count, captured_at, correction=None):
        if correction is not None:
            source, predictions, stamp, epoch = correction
            correction = (source, tuple(sorted(predictions, key=lambda row: row['confidence'], reverse=True)[:MAX_TRACKS]), stamp, epoch)
        with self.lock:
            super().publish(jpeg, count)
            self.result_mono = time.monotonic()
            if self.tracking_enabled and correction is not None and correction[3] == self.epoch:
                self.pending = correction  # Single latest-result mailbox, not a queue.
        self.frame_ready.set()

    def tracking_input(self):
        with self.lock:
            pending, self.pending = self.pending, None
            return self.raw, self.raw_mono, self.epoch, pending

    def publish_tracked(self, jpeg, stamp, epoch, count, expiry):
        with self.lock:
            if epoch != self.epoch or stamp != self.raw_mono or self.raw is None:
                return  # Capture advanced during rendering: never publish an older frame.
            self.rendered, self.rendered_mono, self.rendered_expiry = jpeg, stamp, expiry
            self.active_tracks = count
            self.tracking_at = datetime.now(timezone.utc).isoformat()

    def tracking_failed(self):
        with self.lock:
            self.rendered = None
            self.active_tracks = 0

    def snapshot(self):
        with self.lock:
            jpeg, health = super().snapshot()
            capture_active = self.raw is not None and time.monotonic() - self.raw_mono < 3
            healthy = (capture_active and not self.failed and self.jpeg is not None
                       and time.monotonic() - self.result_mono < 15 and not self.stop.is_set())
            health.update(streamEnabled=True, streamAvailable=healthy,
                          captureActive=capture_active, lastFrameAt=self.raw_at,
                          inferenceIntervalSeconds=self.interval, streamTargetFps=self.fps,
                          trackingEnabled=self.tracking_enabled,
                          activeTrackCount=self.active_tracks if capture_active and self.rendered is not None and self.rendered_mono == self.raw_mono and time.monotonic() < self.rendered_expiry else 0,
                          lastTrackingUpdateAt=self.tracking_at, trackMaxAgeSeconds=self.track_max_age)
            return jpeg, health

    def stream_frame(self):
        with self.lock:
            _, health = self.snapshot()
            if not health["streamAvailable"]:
                return None
            # Output always belongs to the most recent raw frame. If processing
            # lags or tracking expires, show current raw motion, never rewind.
            if (self.tracking_enabled and self.rendered is not None and self.rendered_mono == self.raw_mono
                    and time.monotonic() < self.rendered_expiry):
                return self.rendered
            return self.raw


def processed_jpeg(jpeg, predictions):
    if not predictions:
        return jpeg, 0
    frame = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError("Invalid inference JPEG.")
    annotated, count = render_predictions(frame, predictions)
    if not count:
        return jpeg, 0
    ok, encoded = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 95])
    if not ok:
        raise ValueError("Could not encode processed frame.")
    return encoded.tobytes(), count


def sample_cycle(state, rtsp, endpoint, key, requests):
    if isinstance(state, StreamingFrame):
        jpeg, captured_at, captured_mono, epoch = state.inference_frame()
    else:
        jpeg, _, _ = capture_one_frame(rtsp)
        captured_at, captured_mono = datetime.now(timezone.utc).isoformat(), time.monotonic()
    started_at, started = datetime.now(timezone.utc).isoformat(), time.monotonic()
    predictions, _ = predict(endpoint, key, jpeg, requests)
    ended_at, ended = datetime.now(timezone.utc).isoformat(), time.monotonic()
    state.record_timing(captured_at, captured_mono, started_at, started, ended_at, ended)
    processed, count = processed_jpeg(jpeg, predictions)
    if isinstance(state, StreamingFrame):
        state.publish_result(processed, count, captured_at, (jpeg, predictions, captured_mono, epoch))
    else:
        state.publish(processed, count)


def sampling_loop(state, interval, stop, settings, requests):
    while not stop.is_set():
        started = time.monotonic()
        try:
            sample_cycle(state, *settings, requests)
            print("Processed frame published.", flush=True)
        except Exception:
            state.failure()
            print("Segmentation cycle failed; will try the next cycle.", flush=True)
        stop.wait(max(0, interval - (time.monotonic() - started)))


def response_for(state, path):
    jpeg, health = state.snapshot()
    if path == "/health":
        return 200, "application/json", json.dumps(health).encode(), health
    if path == "/latest-segmentation.jpg":
        if jpeg is not None:
            return 200, "image/jpeg", jpeg, health
        return 503, "application/json", b'{"status":"waiting"}', health
    return 404, "application/json", b'{"status":"not_found"}', health


def handler_for(state, origins, host, port):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # Never log request URLs, headers or arbitrary client input.

        def do_GET(self):
            self.respond(False)

        def do_OPTIONS(self):
            self.respond(True)

        def respond(self, preflight):
            origin = self.headers.get("Origin")
            allowed_hosts = {f"{host}:{port}", f"localhost:{port}", f"127.0.0.1:{port}"}
            allowed = self.headers.get("Host") in allowed_hosts and (origin is None or origin in origins)
            if not origin and self.headers.get("Sec-Fetch-Site") == "cross-site":
                allowed = False
            if not allowed:
                code, content_type, body, health = 403, "application/json", b'{"status":"forbidden"}', {}
            elif preflight:
                code, content_type, body, health = 204, "text/plain", b"", {}
            elif urlsplit(self.path).path == "/segmentation-stream.mjpg":
                self.stream(origin)
                return
            else:
                code, content_type, body, health = response_for(state, urlsplit(self.path).path)
                session = parse_qs(urlsplit(self.path).query).get("streamId")
                if urlsplit(self.path).path == "/health" and session and isinstance(state, StreamingFrame):
                    health["streamClientActive"] = state.client_active(session[0])
                    body = json.dumps(health).encode()
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Vary", "Origin")
            if allowed and origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
                self.send_header("Access-Control-Allow-Private-Network", "true")
                self.send_header("Access-Control-Expose-Headers", "X-Inference-At, X-Feed-Status, X-Camera-Doc-Id")
            if health.get("lastInferenceAt"):
                self.send_header("X-Inference-At", health["lastInferenceAt"])
                self.send_header("X-Feed-Status", health["status"])
                self.send_header("X-Camera-Doc-Id", health["cameraDocId"])
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def stream(self, origin):
            # The identity in the URL prevents a health/stream restart race.
            expected = parse_qs(urlsplit(self.path).query, keep_blank_values=True).get("cameraDocId")
            if expected is not None and expected != [state.camera_doc_id]:
                self.send_response(409)
                self.end_headers()
                return
            if not isinstance(state, StreamingFrame) or state.stream_frame() is None:
                self.send_response(503)
                self.end_headers()
                return
            if not state.clients.acquire(blocking=False):
                self.send_response(503)
                self.end_headers()
                return
            session = parse_qs(urlsplit(self.path).query).get("streamId", [None])[0]
            registered = False
            try:
                if session is not None:
                    with state.lock:
                        if re.fullmatch(r"[A-Za-z0-9_-]{1,64}", session) and session not in state.sessions:
                            state.sessions.add(session)
                            registered = True
                    if not registered:
                        self.send_response(409)
                        self.end_headers()
                        return
                self.connection.settimeout(5)
                self.send_response(200)
                self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
                self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("X-Camera-Doc-Id", state.camera_doc_id)
                self.send_header("Vary", "Origin")
                if origin:
                    self.send_header("Access-Control-Allow-Origin", origin)
                    self.send_header("Access-Control-Expose-Headers", "X-Camera-Doc-Id")
                self.end_headers()
                while not state.stop.is_set():
                    started = time.monotonic()
                    jpeg = state.stream_frame()
                    if jpeg is None:
                        break
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                     + str(len(jpeg)).encode("ascii") + b"\r\n\r\n" + jpeg + b"\r\n")
                    self.wfile.flush()
                    state.stop.wait(max(0, 1 / state.fps - (time.monotonic() - started)))
                self.wfile.write(b"--frame--\r\n")
            except (OSError, TimeoutError):
                pass  # Slow/disconnected viewers never affect the shared pipeline.
            finally:
                if registered:
                    with state.lock:
                        state.sessions.discard(session)
                self.close_connection = True
                state.clients.release()
    return Handler


def main():
    server = None
    worker = None
    capture = None
    tracking = None
    stop = threading.Event()
    try:
        settings = configuration()
        host, port, interval, origins = feed_configuration()
        import requests
        fps = stream_configuration()
        tracking_enabled, track_max_age = tracking_configuration()
        camera_id = os.environ.get("SEGMENTATION_CAMERA_DOC_ID", "").strip()
        state = StreamingFrame(camera_id, fps, interval, stop, tracking_enabled, track_max_age) if fps else LatestFrame(camera_id)
        if not state.camera_doc_id:
            print("Camera document ID is not configured; frontend AI camera matching will be unavailable. "
                  "Set SEGMENTATION_CAMERA_DOC_ID and restart the bridge.", flush=True)
        server = ThreadingHTTPServer((host, port), handler_for(state, origins, host, port))
        server.daemon_threads = True
        if fps:
            if tracking_enabled:
                tracking = TrackingWorker(state)
                tracking.start()
            capture = LiveCapture(state, settings[0], fps, stop)
            capture.start()
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        print("Local segmentation feed started. Ctrl+C to stop.", flush=True)
        sampling_loop(state, interval, stop, settings, requests)
    except KeyboardInterrupt:
        print("Segmentation feed stopped.", flush=True)
    except Exception:
        print("Feed could not start. Check private configuration, dependencies and port availability.", flush=True)
        return 1
    finally:
        stop.set()
        if capture is not None:
            capture.close()
        if tracking is not None:
            tracking.close()
        if server is not None:
            if worker is not None and worker.is_alive():
                server.shutdown()
                worker.join()
            server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

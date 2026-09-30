"""One supervised persistent OpenCV capture; bounded binary IPC, no public logs."""

import math
import os
from pathlib import Path
import struct
import subprocess
import sys
import threading
import time

HEADER = struct.Struct("!Id")  # JPEG length and capture monotonic timestamp
MAX_JPEG_BYTES = 20 * 1024 * 1024


def read_exact(pipe, size):
    data = bytearray()
    while len(data) < size:
        chunk = pipe.read(size - len(data))
        if not chunk:
            raise EOFError()
        data.extend(chunk)
    return bytes(data)


class LiveCapture:
    def __init__(self, state, rtsp, fps, stop):
        self.state, self.rtsp, self.fps, self.stop = state, rtsp, fps, stop
        self.worker = None

    def start(self):
        if self.worker is not None:
            raise RuntimeError("Capture already started.")
        self.worker = threading.Thread(target=self.run, daemon=True)
        self.worker.start()

    def close(self):
        self.stop.set()
        if self.worker is not None:
            self.worker.join(timeout=8)

    def receive(self, process, ended):
        try:
            while not self.stop.is_set():
                size, captured = HEADER.unpack(read_exact(process.stdout, HEADER.size))
                if not 0 < size <= MAX_JPEG_BYTES or not math.isfinite(captured):
                    break
                jpeg = read_exact(process.stdout, size)
                if not jpeg.startswith(b'\xff\xd8') or not jpeg.endswith(b'\xff\xd9'):
                    break
                # Drop delayed IPC frames rather than presenting them as live.
                if not 0 <= time.monotonic() - captured < 3:
                    continue
                self.state.publish_raw(jpeg, captured)
        except (EOFError, OSError, ValueError, struct.error):
            pass
        finally:
            ended.set()

    def run(self):
        while not self.stop.is_set():
            process, reader = None, None
            ended = threading.Event()
            try:
                environment = os.environ.copy()
                environment.pop("ULTRALYTICS_API_KEY", None)
                environment.pop("ULTRALYTICS_ENDPOINT", None)
                environment["CAMERA_RTSP_URL"] = self.rtsp
                environment["SEGMENTATION_STREAM_FPS"] = str(self.fps)
                process = subprocess.Popen(
                    [sys.executable, str(Path(__file__).resolve()), "--worker"],
                    env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                )
                started = time.monotonic()
                reader = threading.Thread(target=self.receive, args=(process, ended), daemon=True)
                reader.start()
                while not self.stop.wait(0.25) and not ended.is_set():
                    if process.poll() is not None or time.monotonic() - max(started, self.state.raw_time()) > 15:
                        break
            except (OSError, ValueError):
                pass  # Never forward native diagnostics or credential-bearing errors.
            finally:
                if process is not None:
                    try:
                        if process.poll() is None:
                            process.kill()
                        process.wait(timeout=5)
                    except (OSError, subprocess.TimeoutExpired):
                        # Fail closed rather than start a second connection when
                        # the OS cannot confirm the old camera process has exited.
                        self.state.capture_failed()
                        return
                    if reader is not None:
                        reader.join(timeout=2)
                    process.stdout.close()
                self.state.capture_failed()
            # One reconnect path, shared by all viewers; no per-client camera work.
            self.stop.wait(2)


def capture_worker():
    # Native camera errors may contain credentials: stderr is discarded by parent.
    os.environ["OPENCV_LOG_LEVEL"] = "SILENT"
    os.environ["OPENCV_FFMPEG_DEBUG"] = "0"
    os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"
    import cv2
    camera = cv2.VideoCapture()
    try:
        if not camera.open(os.environ["CAMERA_RTSP_URL"], cv2.CAP_FFMPEG, [
            cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 10000,
            cv2.CAP_PROP_READ_TIMEOUT_MSEC, 10000,
        ]):
            return
        fps = float(os.environ["SEGMENTATION_STREAM_FPS"])
        next_encode = 0
        while True:
            ok, frame = camera.read()
            captured = time.monotonic()
            if not ok or frame is None or frame.size == 0:
                return
            # Drain the camera continuously but encode only at the output cadence.
            if captured < next_encode:
                continue
            next_encode = captured + 1 / fps
            ok, jpeg = cv2.imencode(".jpg", frame)  # Preserve existing capture quality.
            if not ok or not 0 < jpeg.size <= MAX_JPEG_BYTES:
                return
            sys.stdout.buffer.write(HEADER.pack(jpeg.size, captured))
            sys.stdout.buffer.write(jpeg.tobytes())
            sys.stdout.buffer.flush()
    finally:
        camera.release()


if __name__ == "__main__" and sys.argv[1:] == ["--worker"]:
    try:
        capture_worker()
    except Exception:
        pass

"""Interactive camera image collection only; no inference or persistence service."""

import base64
from datetime import datetime
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit
from uuid import uuid4


BRIDGE_DIRECTORY = Path(__file__).resolve().parent
OUTPUT_DIRECTORY = BRIDGE_DIRECTORY / "dataset-captures" / "images"

# Isolate native OpenCV/FFmpeg diagnostics, which may contain RTSP credentials.
# Receive the camera URL on private stdin, never in command-line arguments.
CAPTURE_WORKER = r'''
import base64, json, os, sys
os.environ["OPENCV_LOG_LEVEL"] = "SILENT"
os.environ["OPENCV_FFMPEG_DEBUG"] = "0"
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"
try:
    import cv2
    url = sys.stdin.read()
    camera = cv2.VideoCapture()
    try:
        if not camera.open(url, cv2.CAP_FFMPEG, [
            cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 10000,
            cv2.CAP_PROP_READ_TIMEOUT_MSEC, 10000,
        ]):
            raise ValueError()
        ok, frame = camera.read()
        if not ok or frame is None or frame.size == 0:
            raise ValueError()
    finally:
        camera.release()
    ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
    if not ok:
        raise ValueError()
    print(json.dumps({"width": int(frame.shape[1]), "height": int(frame.shape[0]),
                      "jpeg": base64.b64encode(encoded.tobytes()).decode("ascii")}))
except Exception:
    raise SystemExit(1)
'''


class CollectorError(Exception):
    """Fixed safe messages only."""


def camera_configuration():
    value = os.environ.get("CAMERA_RTSP_URL")
    if value is None:
        from dotenv import dotenv_values
        try:
            # Do not load the whole dotenv into the environment or parse cloud
            # credentials. A URL must be a single-line dotenv assignment.
            with (BRIDGE_DIRECTORY / ".env").open(encoding="utf-8-sig") as source:
                for line in source:
                    if re.match(r"^\s*(?:export\s+)?CAMERA_RTSP_URL\s*=", line):
                        value = dotenv_values(stream=io.StringIO(line), interpolate=False).get("CAMERA_RTSP_URL")
        except OSError:
            raise CollectorError("Cannot read camera configuration. Set CAMERA_RTSP_URL privately.") from None
    try:
        value = (value or "").strip()
        parsed = urlsplit(value)
        if parsed.scheme != "rtsp" or not parsed.hostname or any(c.isspace() for c in value):
            raise ValueError()
        parsed.port
    except (ValueError, TypeError):
        raise CollectorError("Set a valid CAMERA_RTSP_URL in the private environment or bridge .env.") from None
    return value


def capture_image(rtsp):
    # Only OS runtime variables are passed to the child; no cloud configuration.
    environment = {name: os.environ[name] for name in
                   ("SystemRoot", "WINDIR", "PATH", "TEMP", "TMP", "HOME", "LANG")
                   if name in os.environ}
    try:
        result = subprocess.run(
            [sys.executable, "-c", CAPTURE_WORKER], input=rtsp.encode("utf-8"),
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env=environment, timeout=30, check=False,
        )
        if result.returncode:
            raise ValueError()
        payload = json.loads(result.stdout)
        jpeg = base64.b64decode(payload["jpeg"], validate=True)
        width, height = payload["width"], payload["height"]
        if (not jpeg or type(width) is not int or type(height) is not int
                or min(width, height) <= 0):
            raise ValueError()
        return jpeg, width, height
    except subprocess.TimeoutExpired:
        raise CollectorError("Camera capture timed out. Press Enter to try again.") from None
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        raise CollectorError("Capture failed. Check camera access and installed OpenCV; press Enter to try again.") from None


def save_image(jpeg):
    filename = f"riversight_{datetime.now():%Y%m%d_%H%M%S_%f}_{uuid4().hex}.jpg"
    path = OUTPUT_DIRECTORY / filename
    try:
        OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
        # Exclusive creation prevents overwriting even in the event of collision.
        with path.open("xb") as destination:
            destination.write(jpeg)
    except OSError:
        raise CollectorError("Image could not be saved. Check output directory permissions and free space.") from None
    return filename


def main():
    try:
        rtsp = camera_configuration()
        print("RiverSight Camera Dataset Collector\n\nCommands:\n[Enter] Capture image\nq       Quit")
        count = 0
        while True:
            print(f"\nCaptured images: {count}")
            command = input("> ")
            if command.strip().lower() == "q":
                break
            if command != "":
                print("Press Enter to capture, or q to quit.")
                continue
            try:
                jpeg, width, height = capture_image(rtsp)
                filename = save_image(jpeg)
                count += 1
                print(f"Saved {filename} ({width} x {height})")
            except CollectorError as error:
                print(f"Error: {error}")
            except Exception:
                print("Capture failed; diagnostic details withheld. Press Enter to try again.")
    except (KeyboardInterrupt, EOFError):
        pass
    except CollectorError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    except Exception:
        print("Collector could not start. Check camera configuration and installed dependencies.", file=sys.stderr)
        return 1
    print("Dataset collector stopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Capture one RTSP frame and request cloud inference; never load an ML model."""

import argparse
import base64
from datetime import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import unquote, urlsplit

from prediction_geometry import finite_number, safe_class_name, validated_box, validated_segments


# Legacy test/consumer compatibility only; deployed class names come from JSON.
CLASSES = ("bottle", "grass", "branch", "milk-box", "plastic-bag",
           "plastic-garbage", "ball", "leaf")

# Native OpenCV/FFmpeg errors can contain credential-bearing URLs. Capture all
# child stdout privately and discard stderr, including native-library output.
# Credentials travel only through the inherited environment, never argv.
CAPTURE_WORKER = r'''
import base64, json, os
os.environ["OPENCV_LOG_LEVEL"] = "SILENT"
os.environ["OPENCV_FFMPEG_DEBUG"] = "0"
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"
try:
    import cv2
except Exception:
    print(json.dumps({"error": "dependency"}))
    raise SystemExit(1)
camera = None
try:
    camera = cv2.VideoCapture()
    opened = camera.open(os.environ["CAMERA_RTSP_URL"], cv2.CAP_FFMPEG, [
        cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 10000,
        cv2.CAP_PROP_READ_TIMEOUT_MSEC, 10000,
    ])
    if not opened:
        raise ValueError("camera")
    ok, frame = camera.read()
    if not ok or frame is None or frame.size == 0:
        raise ValueError("frame")
except Exception:
    print(json.dumps({"error": "frame" if camera is not None and camera.isOpened() else "camera"}))
    raise SystemExit(1)
finally:
    if camera is not None:
        camera.release()
try:
    ok, jpeg = cv2.imencode(".jpg", frame)
    if not ok:
        raise ValueError()
    print(json.dumps({"width": int(frame.shape[1]), "height": int(frame.shape[0]),
                      "jpeg": base64.b64encode(jpeg.tobytes()).decode("ascii")}))
except Exception:
    print(json.dumps({"error": "jpeg"}))
    raise SystemExit(1)
'''


class BridgeError(Exception):
    """Only fixed, credential-free messages may be passed to this exception."""


def configuration():
    try:
        from dotenv import load_dotenv
    except ImportError:
        raise BridgeError("Dependencies missing. Install requirements.txt in the bridge virtual environment.") from None
    # No interpolation: passwords containing '$' must remain literal.
    load_dotenv(Path(__file__).with_name(".env"), override=False, interpolate=False)
    names = ("CAMERA_RTSP_URL", "ULTRALYTICS_ENDPOINT", "ULTRALYTICS_API_KEY")
    values = [os.environ.get(name, "").strip() for name in names]
    if not all(values):
        raise BridgeError("Set CAMERA_RTSP_URL, ULTRALYTICS_ENDPOINT and ULTRALYTICS_API_KEY.")
    rtsp, endpoint, key = values
    try:
        camera_url, cloud_url = urlsplit(rtsp), urlsplit(endpoint)
        valid = (camera_url.scheme == "rtsp" and bool(camera_url.hostname)
                 and cloud_url.scheme == "https" and bool(cloud_url.hostname)
                 and not cloud_url.username and not cloud_url.password
                 and not cloud_url.query and not cloud_url.fragment
                 and not any(ord(c) < 33 or ord(c) > 126 for c in key)
                 and not any(c.isspace() for c in rtsp + endpoint))
        # Also validate malformed port values without displaying their contents.
        camera_url.port
        cloud_url.port
    except ValueError:
        valid = False
    if not valid:
        raise BridgeError("Invalid configuration. Use a direct RTSP URL, an HTTPS deployment URL, and a valid token.")
    endpoint = endpoint.rstrip("/")
    if endpoint.endswith("/predict"):
        endpoint = endpoint[:-8]
    return rtsp, endpoint + "/predict", key


def capture_one_frame(rtsp):
    environment = os.environ.copy()
    environment["CAMERA_RTSP_URL"] = rtsp
    # The capture process does not need cloud credentials.
    environment.pop("ULTRALYTICS_API_KEY", None)
    try:
        result = subprocess.run(
            [sys.executable, "-c", CAPTURE_WORKER], env=environment,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=30, check=False,
        )
    except subprocess.TimeoutExpired:
        raise BridgeError("Camera capture timed out; capture process stopped. No request sent.") from None
    except OSError:
        raise BridgeError("Unable to start camera capture. No request sent.") from None
    try:
        payload = json.loads(result.stdout)
        error = payload.get("error")
        messages = {
            "dependency": "OpenCV unavailable. Install requirements.txt in the bridge virtual environment.",
            "camera": "Camera connection failed. Check LAN access and private RTSP configuration.",
            "frame": "Camera connected, but reading one frame failed.",
            "jpeg": "Camera disconnected, but JPEG encoding failed.",
        }
        if error in messages:
            raise BridgeError(messages[error])
        if result.returncode != 0:
            raise ValueError()
        jpeg = base64.b64decode(payload["jpeg"], validate=True)
        width, height = payload["width"], payload["height"]
        if not jpeg or type(width) is not int or type(height) is not int or min(width, height) <= 0:
            raise ValueError()
        return jpeg, width, height
    except (ValueError, KeyError, TypeError, AttributeError):
        raise BridgeError("Capture returned an invalid result. Native diagnostic output was suppressed.") from None


def save_debug_frame(jpeg):
    """Save the inference JPEG bytes without recapturing or re-encoding."""
    directory = Path(__file__).resolve().parent / "debug"
    path = directory / f"frame_{datetime.now():%Y%m%d_%H%M%S_%f}.jpg"
    try:
        directory.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as output:
            output.write(jpeg)
    except OSError:
        raise BridgeError("Unable to save debug frame. No inference request sent.") from None
    print(f"Saved frame: {path}")


def safe_predictions(payload, sensitive_values=()):
    """Whitelist documented detection fields; never print server text/metadata."""
    try:
        images = payload["images"]
        if not isinstance(images, list) or len(images) != 1:
            raise ValueError()
        entry = images[0]
        rows = entry["results"]
        shape = entry["shape"]
        if (not isinstance(rows, list) or not isinstance(shape, list) or len(shape) != 2
                or any(type(n) is not int or n <= 0 for n in shape)):
            raise ValueError()
        metadata = payload.get("metadata", {})
        class_names = metadata.get("classNames") if isinstance(metadata, dict) else None
        predictions = []
        for row in rows:
            try:
                class_id, confidence, name = row["class"], row["confidence"], row["name"]
                if type(class_id) is not int or not 0 <= class_id <= 10000:
                    continue
                if not safe_class_name(name, sensitive_values):
                    continue
                if isinstance(class_names, list):
                    if class_id >= len(class_names) or class_names[class_id] != name:
                        continue
                elif isinstance(class_names, dict):
                    if class_names.get(str(class_id), class_names.get(class_id)) != name:
                        continue
                if not finite_number(confidence) or not 0 <= confidence <= 1:
                    continue
                box = validated_box(row.get("box"), shape[1], shape[0])
                if box is None:
                    continue
                item = {"class": class_id, "name": name, "confidence": confidence, "box": box}
                segments = validated_segments(row.get("segments"), shape[1], shape[0])
                if segments is not None:
                    item["segments"] = segments
                predictions.append(item)
            except (KeyError, TypeError, ValueError, AttributeError, OverflowError):
                continue
        speed = entry.get("speed", {})
        duration = speed.get("inference") if isinstance(speed, dict) else None
        return predictions, duration if finite_number(duration) and duration >= 0 else None
    except (KeyError, TypeError, ValueError, AttributeError, OverflowError):
        raise BridgeError("Unexpected prediction schema or invalid detection fields. Check the deployment response contract; raw response withheld.") from None


def print_prediction(item):
    print(f"  {item['name']} (class {item['class']}), confidence {item['confidence']:.4f}, box {item['box']}", flush=True)
    segments = item.get("segments")
    print(f"    segmentation: {len(segments['x'])} points" if segments else "    segmentation: unavailable (bbox fallback)", flush=True)


def compact_predictions(predictions):
    """Bound JSON polygon output without simplifying the geometry used to render."""
    output = []
    for item in predictions:
        entry = dict(item)
        segments = item.get("segments")
        if segments and len(segments["x"]) > 64:
            entry.pop("segments")
            entry["segmentation"] = {"pointCount": len(segments["x"]),
                                     "coordinates": "pixels", "pointsOmitted": True}
        output.append(entry)
    return output


def predict(endpoint, key, jpeg, requests):
    try:
        # Disable ambient proxies/.netrc and redirects so the configured bearer
        # token is sent only to the configured HTTPS destination. TLS stays on.
        with requests.Session() as session:
            session.trust_env = False
            with session.post(
                endpoint, headers={"Authorization": "Bearer " + key},
                files={"file": ("frame.jpg", jpeg, "image/jpeg")},
                data={"conf": "0.25", "iou": "0.70", "imgsz": "640"},
                timeout=(10, 60), allow_redirects=False,
            ) as response:
                print(f"HTTP status: {response.status_code}")
                if response.status_code in (401, 403):
                    raise BridgeError("Inference authorization failed. Check the private API key and deployment access.")
                if 400 <= response.status_code < 500:
                    raise BridgeError("Inference request rejected (4xx). Check endpoint, quota and request configuration. No retry performed.")
                if response.status_code >= 500:
                    raise BridgeError("Inference service failed (5xx). No retry performed.")
                if not 200 <= response.status_code < 300:
                    raise BridgeError("Unexpected HTTP status; redirects are not followed.")
                try:
                    camera = urlsplit(os.environ.get("CAMERA_RTSP_URL", ""))
                    sensitive = (key, camera.username, camera.password,
                                 unquote(camera.username or ""), unquote(camera.password or ""))
                    return safe_predictions(response.json(), sensitive)
                except ValueError:
                    raise BridgeError("Inference response was not valid JSON. Response body withheld.") from None
    except requests.exceptions.Timeout:
        raise BridgeError("Inference request timed out. No retry performed.") from None
    except requests.exceptions.ConnectionError:
        raise BridgeError("HTTPS connection failed. Check network, TLS and endpoint configuration.") from None
    except requests.exceptions.RequestException:
        raise BridgeError("HTTPS request failed. Details withheld to protect credentials.") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="Also print validated prediction JSON (never the raw response).")
    parser.add_argument("--save-frame", action="store_true", help="Save the inference JPEG in the bridge debug directory.")
    parser.add_argument("--save-evidence", action="store_true", help="Save cloud segmentation (or bbox fallback) on a copy of the exact inference JPEG.")
    args = parser.parse_args()
    try:
        rtsp, endpoint, key = configuration()
        try:
            import requests
        except ImportError:
            raise BridgeError("Requests unavailable. Install requirements.txt in the bridge virtual environment.") from None
        jpeg, width, height = capture_one_frame(rtsp)
        print("Camera connection succeeded; one frame captured and camera disconnected.")
        storage = "debug copy enabled" if args.save_frame else "memory only"
        print(f"Frame: {width} x {height}; JPEG: {len(jpeg)} bytes ({storage})")
        if args.save_frame:
            save_debug_frame(jpeg)
        started = time.monotonic()
        predictions, duration = predict(endpoint, key, jpeg, requests)
        print(f"HTTPS request duration: {time.monotonic() - started:.2f} s")
        if duration is not None:
            print(f"Cloud inference duration: {duration:.2f} ms")
        print(f"Predictions: {len(predictions)}")
        for item in predictions:
            print_prediction(item)
        if not predictions:
            print("No objects returned. Request succeeded; this alone does not validate model accuracy.")
        if args.json:
            print(json.dumps({"predictions": compact_predictions(predictions)}, indent=2, allow_nan=False))
        if args.save_evidence:
            if not predictions:
                print("No detections; evidence image not created.")
            else:
                from evidence_renderer import EvidenceError, save_evidence
                try:
                    evidence_path = save_evidence(jpeg, predictions)
                except EvidenceError:
                    raise BridgeError("Unable to create evidence image. Diagnostic details withheld.") from None
                if evidence_path is None:
                    print("No valid detections to draw; evidence image not created.")
                else:
                    print(f"Saved evidence: {evidence_path}")
        return 0
    except BridgeError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Cancelled.", file=sys.stderr)
        return 130
    except Exception:
        print("Error: Bridge failed. Diagnostic details withheld to protect credentials.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

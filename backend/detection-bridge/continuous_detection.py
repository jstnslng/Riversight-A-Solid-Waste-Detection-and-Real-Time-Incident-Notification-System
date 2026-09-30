"""Sequential RTSP sampling with inference performed only in Ultralytics Cloud."""

import math
import os
import sys
import time

from one_frame import BridgeError, capture_one_frame, configuration, predict, print_prediction


def detection_interval():
    """Use a bounded, finite interval; never echo invalid configuration."""
    try:
        interval = float(os.environ.get("DETECTION_INTERVAL_SECONDS", "5"))
    except (ValueError, TypeError):
        raise BridgeError("DETECTION_INTERVAL_SECONDS must be a number from 1 to 86400 seconds.") from None
    if not math.isfinite(interval) or not 1 <= interval <= 86400:
        raise BridgeError("DETECTION_INTERVAL_SECONDS must be a number from 1 to 86400 seconds.")
    return interval


def run_cycle(rtsp, endpoint, key, requests):
    jpeg, width, height = capture_one_frame(rtsp)
    print("Capture succeeded; camera disconnected.", flush=True)
    print(f"Frame: {width} x {height}; JPEG: {len(jpeg)} bytes (memory only)", flush=True)
    started = time.monotonic()
    try:
        predictions, duration = predict(endpoint, key, jpeg, requests)
    finally:
        print(f"HTTPS request duration: {time.monotonic() - started:.2f} s", flush=True)
    if duration is not None:
        print(f"Cloud inference duration: {duration:.2f} ms", flush=True)
    print(f"Predictions: {len(predictions)}", flush=True)
    for item in predictions:
        print_prediction(item)
    if not predictions:
        print("No objects returned.", flush=True)


def monitor(rtsp, endpoint, key, interval, requests):
    cycle = 0
    while True:
        started = time.monotonic()
        cycle += 1
        print(f"Cycle {cycle}", flush=True)
        try:
            run_cycle(rtsp, endpoint, key, requests)
        except BridgeError as error:
            # Shared helpers only construct fixed, credential-free messages.
            print(f"Cycle failed: {error}", flush=True)
        except Exception:
            print("Cycle failed; diagnostic details withheld to protect credentials.", flush=True)
        # No queue, catch-up schedule, parallel request, or retry within a cycle.
        remaining = max(0.0, interval - (time.monotonic() - started))
        time.sleep(remaining)


def main():
    try:
        rtsp, endpoint, key = configuration()  # Loads the existing private .env.
        interval = detection_interval()
        try:
            import requests
        except ImportError:
            raise BridgeError("Requests unavailable. Install requirements.txt in the bridge virtual environment.") from None
        print(f"Continuous cloud sampling started; minimum cycle interval: {interval:g} seconds. Ctrl+C to stop.", flush=True)
        monitor(rtsp, endpoint, key, interval, requests)
    except KeyboardInterrupt:
        print("Monitoring stopped.", flush=True)
        return 0
    except BridgeError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    except Exception:
        print("Error: Monitor failed. Diagnostic details withheld to protect credentials.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

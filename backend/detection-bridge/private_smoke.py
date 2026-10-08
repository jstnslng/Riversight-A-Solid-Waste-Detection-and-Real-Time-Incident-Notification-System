"""One-shot Railway-private checks. No dotenv, SDK credentials or raw logging."""
from datetime import datetime
import http.client
import json
import os
import re
import time
from urllib.parse import urlencode, urlsplit

MAX_BODY = 20 * 1024 * 1024


def configuration(environment):
    url = urlsplit(environment.get("SMOKE_PRIVATE_URL", ""))
    host = environment.get("SMOKE_ALLOWED_HOST", "")
    origin = environment.get("SMOKE_ALLOWED_ORIGIN", "")
    camera = environment.get("SMOKE_CAMERA_DOC_ID", "")
    parsed_origin = urlsplit(origin)
    if (url.scheme != "http" or not url.hostname or not url.hostname.endswith(".railway.internal")
            or url.username or url.password or url.path not in ("", "/") or url.query or url.fragment
            or url.port is None or not 1 <= url.port <= 65535
            or not re.fullmatch(r"[A-Za-z0-9.-]+(?::[0-9]{1,5})?", host)
            or parsed_origin.scheme != "https" or not parsed_origin.hostname
            or parsed_origin.username or parsed_origin.password or parsed_origin.path
            or parsed_origin.query or parsed_origin.fragment
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", camera)):
        raise ValueError()
    for name in ("SMOKE_FIREBASE_ID_TOKEN", "SMOKE_DENIED_ID_TOKEN"):
        token = environment.get(name, "")
        if len(token) > 8192 or any(c.isspace() for c in token):
            raise ValueError()
    return url.hostname, url.port, host, origin, camera


class Client:
    def __init__(self, settings):
        self.hostname, self.port, self.host, self.origin, self.camera = settings

    def request(self, path, token=None, method="GET", ticket=None, stream=False, host=None, origin=None):
        connection = http.client.HTTPConnection(self.hostname, self.port, timeout=8)
        query = {"cameraDocId": self.camera}
        if ticket:
            query["ticket"] = ticket
        headers = {"Host": host or self.host, "Origin": origin or self.origin}
        if token:
            headers["Authorization"] = "Bearer " + token
        if method == "OPTIONS":
            headers.update({"Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization"})
        try:
            connection.request(method, path + "?" + urlencode(query), body=b"" if method == "POST" else None, headers=headers)
            response = connection.getresponse()
            response_headers = {key.lower(): value for key, value in response.getheaders()}
            if stream and response.status == 200:
                # Read a single bounded JPEG part, then disconnect; never save it.
                if response.readline(512) != b"--frame\r\n":
                    raise ValueError()
                length = None
                for _ in range(8):
                    line = response.readline(512)
                    if line == b"\r\n":
                        break
                    if line.lower().startswith(b"content-length:"):
                        length = int(line.split(b":", 1)[1])
                if length is None or not 4 <= length <= MAX_BODY:
                    raise ValueError()
                first, last, remaining = b"", b"", length
                while remaining:
                    chunk = response.read(min(65536, remaining))
                    if not chunk:
                        raise ValueError()
                    if not first:
                        first = chunk[:2]
                    last = (last + chunk)[-2:]
                    remaining -= len(chunk)
                if first != b"\xff\xd8" or last != b"\xff\xd9":
                    raise ValueError()
                return response.status, response_headers, b""
            body = response.read(MAX_BODY + 1)
            if len(body) > MAX_BODY:
                raise ValueError()
            return response.status, response_headers, body
        finally:
            connection.close()


def fresh(stamp):
    try:
        age = time.time() - datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
        return -5 <= age < 15
    except (TypeError, ValueError, AttributeError):
        return False


def run(client, token="", denied_token="", expiry=False, sleep=time.sleep, emit=print):
    failed = 0

    def check(label, operation):
        nonlocal failed
        try:
            passed = operation()
        except Exception:
            passed = False
        failed += not passed
        emit(("PASS " if passed else "FAIL ") + label)
        return passed

    def status(path, expected, **kwargs):
        return client.request(path, **kwargs)[0] == expected

    def public_health():
        code, _, body = client.request("/health")
        return code == 200 and json.loads(body) == {"status": "alive"}

    check("minimal_health", public_health)
    for path, label in (("/feed-health", "health"), ("/latest-segmentation.jpg", "evidence"),
                        ("/segmentation-stream.mjpg", "stream")):
        check("unauthenticated_" + label, lambda path=path: status(path, 401))
    check("invalid_token", lambda: status("/feed-health", 403, token="not-a-firebase-id-token"))
    check("disallowed_host", lambda: status("/health", 403, host="smoke-rejected.invalid"))
    check("disallowed_origin", lambda: status("/health", 403, origin="https://smoke-rejected.invalid"))

    def preflight():
        code, headers, _ = client.request("/stream-ticket", method="OPTIONS")
        return code == 200 and headers.get("access-control-allow-origin") == client.origin and "authorization" in headers.get("access-control-allow-headers", "").lower()
    check("allowed_preflight", preflight)
    if denied_token:
        check("known_ungranted_user", lambda: status("/feed-health", 403, token=denied_token))
    else:
        emit("SKIP known_ungranted_user: no dedicated token supplied")
    if not token:
        emit("SKIP authorized_checks: no ID token supplied")
        return 1 if failed else 0

    def health():
        code, _, body = client.request("/feed-health", token=token)
        row = json.loads(body)
        if (code != 200 or row.get("cameraDocId") != client.camera or row.get("status") != "ok"
                or not row.get("latestFrameAvailable") or not fresh(row.get("lastInferenceAt"))):
            raise ValueError()
        return row

    initial = {}
    def authorized_health():
        initial.update(health())
        return True
    if not check("authorized_grant_and_fresh_health", authorized_health):
        emit("SKIP remaining_authorized_checks: initial authorization/readiness failed")
        return 1

    def evidence():
        code, headers, body = client.request("/latest-segmentation.jpg", token=token)
        return (code == 200 and headers.get("x-camera-doc-id") == client.camera
                and headers.get("x-feed-status") == "ok" and fresh(headers.get("x-inference-at"))
                and headers.get("content-type", "").startswith("image/jpeg")
                and body.startswith(b"\xff\xd8") and body.endswith(b"\xff\xd9"))
    check("authorized_fresh_evidence", evidence)

    def ticket():
        code, _, body = client.request("/stream-ticket", token=token, method="POST")
        row = json.loads(body)
        if code != 200 or not re.fullmatch(r"[A-Za-z0-9_-]{40,64}", row.get("ticket", "")) or row.get("expiresIn") != 30:
            raise ValueError()
        return row["ticket"]

    if initial.get("streamEnabled"):
        def stream_and_replay():
            value = ticket()
            code, headers, _ = client.request("/segmentation-stream.mjpg", ticket=value, stream=True)
            if code != 200 or headers.get("x-camera-doc-id") != client.camera or not headers.get("content-type", "").startswith("multipart/x-mixed-replace"):
                return False
            return status("/segmentation-stream.mjpg", 401, ticket=value)
        check("authorized_stream_and_ticket_replay", stream_and_replay)
        def advancing_capture():
            sleep(1)
            row = health()
            return (row.get("streamAvailable") is True and row.get("captureActive") is True
                    and fresh(row.get("lastFrameAt"))
                    and datetime.fromisoformat(row["lastFrameAt"].replace("Z", "+00:00")).timestamp()
                    > datetime.fromisoformat(initial["lastFrameAt"].replace("Z", "+00:00")).timestamp())
        check("fresh_advancing_capture", advancing_capture)
    else:
        emit("SKIP stream_checks: snapshot-only backend")
    if expiry:
        def expired_ticket():
            value = ticket()
            sleep(32)
            # Still-authorized control prevents misattributing a token/grant
            # failure to ticket TTL enforcement.
            health()
            return status("/segmentation-stream.mjpg", 401, ticket=value)
        check("expired_ticket_with_authorized_control", expired_ticket)
    else:
        emit("SKIP ticket_expiry: enable SMOKE_TEST_EXPIRY=true")
    return 1 if failed else 0


def main():
    try:
        client = Client(configuration(os.environ))
        return run(client, os.environ.get("SMOKE_FIREBASE_ID_TOKEN", ""),
                   os.environ.get("SMOKE_DENIED_ID_TOKEN", ""), os.environ.get("SMOKE_TEST_EXPIRY") == "true")
    except KeyboardInterrupt:
        print("FAIL smoke_interrupted")
        return 130
    except Exception:
        print("FAIL smoke_configuration_or_execution: values and errors suppressed")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

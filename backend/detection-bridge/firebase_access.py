"""Production Firebase authentication and explicit, server-owned camera grants."""
import hashlib
import json
import math
import os
import re
import secrets
import threading
import time
from urllib.parse import parse_qs


class AccessDenied(Exception):
    pass


class FirebaseAccess:
    def __init__(self, verify, read):
        self.verify, self.read = verify, read

    @classmethod
    def from_environment(cls):
        import firebase_admin
        from firebase_admin import auth, credentials, firestore
        project = os.environ.get("FIREBASE_PROJECT_ID", "").strip()
        if not project or os.environ.get("FIREBASE_AUTH_EMULATOR_HOST") or os.environ.get("FIRESTORE_EMULATOR_HOST"):
            raise ValueError("Firebase production configuration rejected.")
        raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
        credential = credentials.Certificate(json.loads(raw)) if raw else credentials.ApplicationDefault()
        app = firebase_admin.initialize_app(credential, {"projectId": project, "httpTimeout": 5}, name="segmentation-bridge")
        database = firestore.client(app=app)
        return cls(lambda token: auth.verify_id_token(token, app=app, check_revoked=True),
                   lambda path: database.document(path).get(timeout=5, retry=None).to_dict())

    def authorize(self, token, camera):
        try:
            claims = self.verify(token)
            uid, expiry = claims["uid"], claims["exp"]
            if not isinstance(uid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", uid):
                raise AccessDenied()
            if not isinstance(expiry, (int, float)) or not math.isfinite(expiry) or expiry <= time.time():
                raise AccessDenied()
            user = self.read(f"users/{uid}") or {}
            # Status absence preserves existing legacy Active default; explicit
            # pending/inactive accounts are denied, including administrators.
            if (user.get("role") not in ("Administrator", "Monitoring", "Monitoring Personnel")
                    or user.get("status", "Active") not in ("active", "Active")):
                raise AccessDenied()
            grant = self.read(f"bridge_camera_access/{camera}/viewers/{uid}") or {}
            if grant.get("enabled") is not True:
                raise AccessDenied()
            return expiry
        except Exception:
            raise AccessDenied() from None


class GuardedStream:
    def __init__(self, source, access, token, camera, expiry):
        self.source, self.access, self.token, self.camera = source, access, token, camera
        self.deadline = min(time.monotonic() + 60, time.monotonic() + expiry - time.time())
        self.check_at = 0

    def __iter__(self):
        return self

    def __next__(self):
        now = time.monotonic()
        if now >= self.deadline:
            self.close()
            raise StopIteration
        if now >= self.check_at:
            try:
                self.access.authorize(self.token, self.camera)
            except AccessDenied:
                self.close()
                raise StopIteration from None
            self.check_at = now + 15
        try:
            # Verification and source iteration can block. Recheck before
            # publishing too, so a completed slow check cannot extend access.
            if time.monotonic() >= self.deadline:
                self.close()
                raise StopIteration
            frame = next(self.source)
            if time.monotonic() >= self.deadline:
                self.close()
                raise StopIteration
            return frame
        except BaseException:
            self.close()
            raise

    def close(self):
        self.token = ""
        self.source.close()


def secure_application(application, access, camera, origins, hosts):
    tickets, lock = {}, threading.Lock()

    def respond(start, status, payload, origin=None, preflight=False):
        body = json.dumps(payload).encode()
        headers = [("Content-Type", "application/json"), ("Content-Length", str(len(body))),
                   ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff"),
                   ("Referrer-Policy", "no-referrer"), ("Vary", "Origin")]
        if origin in origins:
            headers.append(("Access-Control-Allow-Origin", origin))
            if preflight:
                headers.extend([("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
                                ("Access-Control-Allow-Headers", "Authorization")])
        start(status, headers)
        return [body]

    def secured(environ, start):
        origin = environ.get("HTTP_ORIGIN")
        path, method = environ.get("PATH_INFO", "/"), environ.get("REQUEST_METHOD", "GET")
        if environ.get("HTTP_HOST") not in hosts or (origin is not None and origin not in origins):
            return respond(start, "403 Forbidden", {"status": "forbidden"})
        if origin is None and environ.get("HTTP_SEC_FETCH_SITE") == "cross-site":
            return respond(start, "403 Forbidden", {"status": "forbidden"})
        if method == "OPTIONS":
            return respond(start, "200 OK", {}, origin, True)
        if path == "/health" and method == "GET":
            return respond(start, "200 OK", {"status": "alive"}, origin)
        if path not in ("/feed-health", "/latest-segmentation.jpg", "/stream-ticket", "/segmentation-stream.mjpg"):
            return respond(start, "404 Not Found", {"status": "not_found"}, origin)
        if method != ("POST" if path == "/stream-ticket" else "GET"):
            return respond(start, "405 Method Not Allowed", {"status": "method_not_allowed"}, origin)
        query = parse_qs(environ.get("QUERY_STRING", ""), keep_blank_values=True)
        if query.get("cameraDocId") != [camera]:
            return respond(start, "403 Forbidden", {"status": "forbidden"}, origin)
        token = None
        if path == "/segmentation-stream.mjpg":
            key = query.get("ticket", [""])
            if len(key) == 1 and re.fullmatch(r"[A-Za-z0-9_-]{40,64}", key[0]):
                with lock:
                    row = tickets.pop(hashlib.sha256(key[0].encode()).digest(), None)
                if row and row[1] == origin and row[2] > time.monotonic():
                    token = row[0]
        else:
            header = environ.get("HTTP_AUTHORIZATION", "")
            if header.startswith("Bearer ") and 0 < len(header) <= 8192:
                token = header[7:]
        if not token:
            return respond(start, "401 Unauthorized", {"status": "unauthorized"}, origin)
        try:
            expiry = access.authorize(token, camera)
        except AccessDenied:
            return respond(start, "403 Forbidden", {"status": "forbidden"}, origin)
        if path == "/stream-ticket":
            if origin not in origins:
                return respond(start, "403 Forbidden", {"status": "forbidden"})
            ticket = secrets.token_urlsafe(32)
            with lock:
                now = time.monotonic()
                for key in list(tickets):
                    if tickets[key][2] <= now:
                        del tickets[key]
                if len(tickets) >= 256:
                    return respond(start, "503 Service Unavailable", {"status": "busy"}, origin)
                tickets[hashlib.sha256(ticket.encode()).digest()] = (token, origin, min(now + 30, now + expiry - time.time()))
            return respond(start, "200 OK", {"ticket": ticket, "expiresIn": 30, "streamMaxSeconds": 60}, origin)
        forwarded = dict(environ)
        forwarded.pop("HTTP_AUTHORIZATION", None)
        if path == "/feed-health":
            forwarded["PATH_INFO"] = "/health"
        # Never forward the bearer ticket into the HTTP handler/query parser.
        if path == "/segmentation-stream.mjpg":
            forwarded["QUERY_STRING"] = "cameraDocId=" + camera
            session = query.get("streamId", [""])
            if len(session) == 1 and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", session[0]):
                forwarded["QUERY_STRING"] += "&streamId=" + session[0]
        result = application(forwarded, start)
        if path == "/segmentation-stream.mjpg" and hasattr(result, "close"):
            return GuardedStream(result, access, token, camera, expiry)
        return result
    return secured

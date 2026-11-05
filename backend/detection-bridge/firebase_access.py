"""Production Firebase authentication and explicit, server-owned camera grants."""
import hashlib
import hmac
import base64
import json
import math
import os
import re
import secrets
import threading
import time
from urllib.parse import parse_qs


FIRESTORE_WRITE_TIMEOUT_SECONDS = 5
AUTHORIZATION_LEASE_MAX_SECONDS = 60
AUTHORIZATION_LEASE_MIN_SECRET_BYTES = 32


def _log(event, **fields):
    details = " ".join(f"{key}={value}" for key, value in fields.items())
    print(f"firebase event={event}" + (f" {details}" if details else ""), flush=True)


class AccessDenied(Exception):
    pass


class AuthenticationFailed(Exception):
    pass


class AccessDependencyError(Exception):
    pass


class UnavailableFirebaseAccess:
    """Fail closed for protected routes while non-Firebase inference continues."""

    write_detection = None
    resolve_active_detections = None
    server_timestamp = staticmethod(lambda: None)

    def authorize(self, token, camera):
        raise AccessDependencyError()

    def read(self, path):
        raise AccessDependencyError()

    def issue_lease(self, token, camera, expiry):
        raise AccessDependencyError()

    def validate_lease(self, lease, camera, expected_uid=None):
        raise AccessDependencyError()


class FirebaseAccess:
    def __init__(self, verify, read, write=None, resolve_active=None, server_timestamp=None,
                 authorization_cache_seconds=0, lease_secret=None, lease_seconds=30):
        self.verify, self.read = verify, read
        self.write_detection, self.resolve_active_detections = write, resolve_active
        self.server_timestamp = server_timestamp or (lambda: None)
        self.authorization_cache_seconds = max(0, float(authorization_cache_seconds))
        self._authorization_cache = {}
        self._authorization_cache_lock = threading.Lock()
        self.lease_secret = lease_secret
        self.lease_seconds = min(AUTHORIZATION_LEASE_MAX_SECONDS, max(0, float(lease_seconds)))

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

        def verify(token):
            return auth.verify_id_token(token, app=app, check_revoked=True)

        def read(path):
            return database.document(path).get(timeout=5, retry=None).to_dict()

        def write_detection(detection_id, data):
            database.collection("detections").document(detection_id).set(
                data, merge=True, timeout=FIRESTORE_WRITE_TIMEOUT_SECONDS)

        def resolve_active(camera):
            for document in (database.collection("detections")
                             .where("cameraDocId", "==", camera)
                             .where("status", "==", "active")
                             .stream(timeout=FIRESTORE_WRITE_TIMEOUT_SECONDS)):
                document.reference.set(
                    {"status": "resolved", "resolvedAt": firestore.SERVER_TIMESTAMP},
                    merge=True,
                    timeout=FIRESTORE_WRITE_TIMEOUT_SECONDS,
                )

        _log("admin_initialized", project_id=project,
             credential_source="service_account_json" if raw else "application_default")
        cache_seconds = os.environ.get("SEGMENTATION_AUTHORIZATION_CACHE_SECONDS", "10")
        try:
            cache_seconds = float(cache_seconds)
        except ValueError:
            raise ValueError("SEGMENTATION_AUTHORIZATION_CACHE_SECONDS must be numeric.") from None
        if not math.isfinite(cache_seconds) or not 0 <= cache_seconds <= 60:
            raise ValueError("SEGMENTATION_AUTHORIZATION_CACHE_SECONDS must be between 0 and 60.")
        lease_secret = os.environ.get("SEGMENTATION_AUTHORIZATION_LEASE_SECRET", "").strip()
        if lease_secret and len(lease_secret.encode("utf-8")) < AUTHORIZATION_LEASE_MIN_SECRET_BYTES:
            raise ValueError(
                "SEGMENTATION_AUTHORIZATION_LEASE_SECRET must contain at least "
                f"{AUTHORIZATION_LEASE_MIN_SECRET_BYTES} UTF-8 bytes."
            )
        lease_seconds = os.environ.get("SEGMENTATION_AUTHORIZATION_LEASE_SECONDS", "30")
        try:
            lease_seconds = float(lease_seconds)
        except ValueError:
            raise ValueError("SEGMENTATION_AUTHORIZATION_LEASE_SECONDS must be numeric.") from None
        if not math.isfinite(lease_seconds) or not 0 < lease_seconds <= AUTHORIZATION_LEASE_MAX_SECONDS:
            raise ValueError("SEGMENTATION_AUTHORIZATION_LEASE_SECONDS must be between 0 and 60.") from None
        if not lease_secret:
            _log("authorization_lease_disabled", reason="missing_secret")
        return cls(verify, read, write_detection, resolve_active,
                   lambda: firestore.SERVER_TIMESTAMP, cache_seconds,
                   lease_secret.encode("utf-8") if lease_secret else None, lease_seconds)

    def authorize(self, token, camera):
        cache_key = (hashlib.sha256(token.encode()).digest(), camera)
        now = time.monotonic()
        with self._authorization_cache_lock:
            cached = self._authorization_cache.get(cache_key)
            if cached and cached[0] > now:
                return cached[1]
        try:
            claims = self.verify(token)
        except Exception as error:
            _log("token_verification_failed", error_type=type(error).__name__)
            raise AuthenticationFailed() from None

        uid, expiry = claims.get("uid"), claims.get("exp")
        if (not isinstance(uid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", uid)
                or not isinstance(expiry, (int, float))
                or not math.isfinite(expiry) or expiry <= time.time()):
            _log("token_claims_invalid")
            raise AuthenticationFailed()
        try:
            user = self.read(f"users/{uid}") or {}
            grant = self.read(f"bridge_camera_access/{camera}/viewers/{uid}") or {}
        except Exception as error:
            _log("authorization_dependency_failed", error_type=type(error).__name__)
            raise AccessDependencyError() from None

        # Status absence preserves existing legacy Active default; explicit
        # pending/inactive accounts are denied, including administrators.
        if (user.get("role") not in ("Administrator", "Monitoring", "Monitoring Personnel")
                or user.get("status", "Active") not in ("active", "Active")
                or grant.get("enabled") is not True):
            _log("authorization_denied", uid=uid, camera_doc_id=camera)
            raise AccessDenied()

        if self.authorization_cache_seconds:
            expiry_at = min(
                now + self.authorization_cache_seconds,
                time.monotonic() + max(0, expiry - time.time()),
            )
            with self._authorization_cache_lock:
                self._authorization_cache[cache_key] = (expiry_at, expiry)
        return expiry

    def issue_lease(self, token, camera, expiry):
        if not self.lease_secret:
            raise AccessDependencyError()
        claims = self.verify(token)
        uid = claims.get("uid")
        now = int(time.time())
        lease_expiry = min(now + int(self.lease_seconds), int(expiry))
        payload = f"{uid}.{camera}.{now}.{lease_expiry}".encode()
        signature = hmac.new(self.lease_secret, payload, hashlib.sha256).digest()
        encoded = base64.urlsafe_b64encode(payload + b"." + signature).decode().rstrip("=")
        return encoded

    def validate_lease(self, lease, camera, expected_uid=None):
        if not self.lease_secret or not isinstance(lease, str):
            raise AccessDependencyError()
        try:
            raw = base64.urlsafe_b64decode(lease + "=" * (-len(lease) % 4))
            uid, lease_camera, issued, expiry, signature = raw.split(b".", 4)
            payload = b".".join((uid, lease_camera, issued, expiry))
            expected = hmac.new(self.lease_secret, payload, hashlib.sha256).digest()
            if not secrets.compare_digest(signature, expected):
                raise AccessDenied()
            now = int(time.time())
            if lease_camera.decode() != camera or int(issued) > now or int(expiry) <= now:
                raise AccessDenied()
            if expected_uid is not None and uid.decode() != expected_uid:
                raise AccessDenied()
            return int(expiry)
        except (ValueError, TypeError, UnicodeDecodeError, base64.binascii.Error):
            raise AccessDenied() from None


class GuardedStream:
    def __init__(self, source, access, token, camera, expiry, lease=False):
        self.source, self.access, self.token, self.camera = source, access, token, camera
        self.lease = lease
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
                if self.lease:
                    self.access.validate_lease(self.token, self.camera)
                else:
                    self.access.authorize(self.token, self.camera)
            except (AccessDenied, AuthenticationFailed, AccessDependencyError):
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

    def respond(start, status, payload, origin=None, preflight=False, lease=None):
        body = json.dumps(payload).encode()
        headers = [("Content-Type", "application/json"), ("Content-Length", str(len(body))),
                   ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff"),
                   ("Referrer-Policy", "no-referrer"), ("Vary", "Origin")]
        if origin in origins:
            headers.append(("Access-Control-Allow-Origin", origin))
            if lease:
                headers.append(("X-RiverSight-Authorization-Lease", lease))
                headers.append(("Access-Control-Expose-Headers", "X-RiverSight-Authorization-Lease"))
            if preflight:
                headers.extend([("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
                                ("Access-Control-Allow-Headers",
                                 "Authorization, X-RiverSight-Authorization-Lease")])
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
        lease = None
        lease_mode = False
        if path == "/segmentation-stream.mjpg":
            key = query.get("ticket", [""])
            if len(key) == 1 and re.fullmatch(r"[A-Za-z0-9_-]{40,64}", key[0]):
                with lock:
                    row = tickets.pop(hashlib.sha256(key[0].encode()).digest(), None)
                if row and row[1] == origin and row[2] > time.monotonic():
                    token, lease_mode = row[0], row[3]
        else:
            header = environ.get("HTTP_AUTHORIZATION", "")
            if header.startswith("Bearer ") and 0 < len(header) <= 8192:
                token = header[7:]
            lease = environ.get("HTTP_X_RIVERSIGHT_AUTHORIZATION_LEASE")
            if lease and len(lease) > 1024:
                lease = None
            if not token and lease:
                token, lease_mode = lease, True
        if not token:
            return respond(start, "401 Unauthorized", {"status": "unauthorized"}, origin)
        try:
            if lease_mode:
                expiry = access.validate_lease(token, camera)
            else:
                expiry = access.authorize(token, camera)
        except AuthenticationFailed:
            return respond(start, "401 Unauthorized", {"status": "unauthorized"}, origin)
        except AccessDependencyError:
            if lease_mode:
                return respond(start, "503 Service Unavailable",
                               {"status": "dependency_unavailable"}, origin)
            try:
                lease = environ.get("HTTP_X_RIVERSIGHT_AUTHORIZATION_LEASE")
                try:
                    claims = access.verify(token)
                except Exception:
                    return respond(start, "401 Unauthorized",
                                   {"status": "unauthorized"}, origin)
                uid = claims.get("uid") if isinstance(claims, dict) else None
                if not isinstance(uid, str):
                    return respond(start, "401 Unauthorized",
                                   {"status": "unauthorized"}, origin)
                expiry = access.validate_lease(lease, camera, expected_uid=uid)
                token, lease_mode = lease, True
            except AccessDenied:
                return respond(start, "403 Forbidden", {"status": "forbidden"}, origin)
            except AccessDependencyError:
                return respond(start, "503 Service Unavailable",
                               {"status": "dependency_unavailable"}, origin)
        except AccessDenied:
            return respond(start, "403 Forbidden", {"status": "forbidden"}, origin)
        if path == "/stream-ticket":
            if origin not in origins:
                return respond(start, "403 Forbidden", {"status": "forbidden"})
            ticket = secrets.token_urlsafe(32)
            lease_header = None
            if not lease_mode:
                try:
                    lease_header = access.issue_lease(token, camera, expiry)
                except AccessDependencyError:
                    pass
            ticket_credential = lease_header if lease_header else token
            ticket_lease_mode = bool(lease_header) or lease_mode
            with lock:
                now = time.monotonic()
                for key in list(tickets):
                    if tickets[key][2] <= now:
                        del tickets[key]
                if len(tickets) >= 256:
                    return respond(start, "503 Service Unavailable", {"status": "busy"}, origin)
                tickets[hashlib.sha256(ticket.encode()).digest()] = (
                    ticket_credential, origin, min(now + 30, now + expiry - time.time()),
                    ticket_lease_mode)
            return respond(start, "200 OK", {"ticket": ticket, "expiresIn": 30,
                                              "streamMaxSeconds": 60}, origin, lease=lease_header)
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
            return GuardedStream(result, access, token, camera, expiry, lease=lease_mode)
        return result
    return secured

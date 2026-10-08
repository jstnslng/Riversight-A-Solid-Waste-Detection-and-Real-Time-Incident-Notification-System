"""Bounded Waitress serving; one shared capture/inference pipeline per process."""

from email.message import Message
from http import HTTPStatus
import io
import os
import re
import threading
import time
from urllib.parse import parse_qs, urlsplit

import segmentation_feed as feed


def application_for(state, origins, host, port, allowed_hosts):
    base = feed.handler_for(state, origins, host, port, allowed_hosts)

    class Response(base):
        # Adapt the existing policy and finite endpoints, without a second socket
        # server or a second copy of camera/inference/health logic.
        def send_response(self, code, message=None):
            self.code = code

        def send_header(self, name, value):
            self.response_headers.append((name, value))

        def end_headers(self):
            pass

        def stream(self, origin):
            query = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
            expected = query.get("cameraDocId")
            session = query.get("streamId", [None])[0]
            if expected is not None and expected != [state.camera_doc_id]:
                self.send_response(409)
                return
            if not isinstance(state, feed.StreamingFrame) or state.stream_frame() is None:
                self.send_response(503)
                return
            if not state.clients.acquire(blocking=False):
                self.send_response(503)
                return
            registered = False
            if session is not None:
                with state.lock:
                    if re.fullmatch(r"[A-Za-z0-9_-]{1,64}", session) and session not in state.sessions:
                        state.sessions.add(session)
                        registered = True
                if not registered:
                    state.clients.release()
                    self.send_response(409)
                    return
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Camera-Doc-Id", state.camera_doc_id)
            self.send_header("Vary", "Origin")
            if origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Expose-Headers", "X-Camera-Doc-Id")
            self.send_header("X-Accel-Buffering", "no")
            self.iterator = Stream(state, session, registered)

    def application(environ, start_response):
        response = object.__new__(Response)
        response.response_headers = []
        response.iterator = None
        response.wfile = io.BytesIO()
        response.headers = Message()
        for key, name in (("HTTP_HOST", "Host"), ("HTTP_ORIGIN", "Origin"),
                          ("HTTP_SEC_FETCH_SITE", "Sec-Fetch-Site")):
            if key in environ:
                response.headers[name] = environ[key]
        response.path = environ.get("PATH_INFO", "/") + "?" + environ.get("QUERY_STRING", "")
        method = environ.get("REQUEST_METHOD", "GET")
        if method not in ("GET", "OPTIONS"):
            response.send_response(405)
            response.send_header("Allow", "GET, OPTIONS")
        else:
            response.respond(method == "OPTIONS")
        try:
            start_response(f"{response.code} {HTTPStatus(response.code).phrase}", response.response_headers)
        except BaseException:
            if response.iterator is not None:
                response.iterator.close()
            raise
        return response.iterator if response.iterator is not None else [response.wfile.getvalue()]
    return application


class Stream:
    """Explicit close releases admission even if WSGI closes before first next()."""
    def __init__(self, state, session, registered):
        self.state, self.session, self.registered = state, session, registered
        self.closed = False
        self.next_at = 0

    def __iter__(self):
        return self

    def __next__(self):
        if self.closed or self.state.stop.wait(max(0, self.next_at - time.monotonic())):
            self.close()
            raise StopIteration
        jpeg = self.state.stream_frame()
        if jpeg is None:
            self.close()
            raise StopIteration
        self.next_at = time.monotonic() + 1 / self.state.fps
        return (b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                + str(len(jpeg)).encode("ascii") + b"\r\n\r\n" + jpeg + b"\r\n")

    def close(self):
        if not self.closed:
            self.closed = True
            if self.registered:
                with self.state.lock:
                    self.state.sessions.discard(self.session)
            self.state.clients.release()


class ProductionServer:
    daemon_threads = True

    def __init__(self, state, origins, host, port, allowed_hosts):
        from waitress import create_server
        # No implicit dev allowlists when using the production entry point.
        if (not os.environ.get("SEGMENTATION_ALLOWED_HOSTS", "").strip()
                or not os.environ.get("SEGMENTATION_ALLOWED_ORIGINS", "").strip()
                or not state.camera_doc_id):
            raise ValueError("Production requires hosts, origins and camera identity.")
        if any(not origin.startswith("https://") for origin in origins):
            raise ValueError("Production origins must use HTTPS.")
        self.socket_map = {}
        self.ended = threading.Event()
        self.server = create_server(
            application_for(state, origins, host, port, allowed_hosts), host=host, port=port,
            map=self.socket_map,
            threads=16, connection_limit=32, backlog=32, channel_timeout=10,
            cleanup_interval=1, max_request_header_size=8192, max_request_body_size=0,
            outbuf_high_watermark=262144, outbuf_overflow=262144,
            channel_request_lookahead=1, log_socket_errors=False, expose_tracebacks=False,
            clear_untrusted_proxy_headers=True,
        )

    def serve_forever(self):
        from waitress import wasyncore
        try:
            while not self.ended.is_set():
                wasyncore.loop(timeout=1, count=1, map=self.socket_map)
        finally:
            # Close channels on the event-loop thread too, including idle and
            # backpressured viewers. Closing only the listening socket leaves
            # keep-alive channels alive and can prevent process shutdown.
            for channel in list(self.socket_map.values()):
                channel.close()

    def shutdown(self):
        self.ended.set()

    def server_close(self):
        for channel in list(self.socket_map.values()):
            channel.close()
        self.server.task_dispatcher.shutdown(timeout=5)


if __name__ == "__main__":
    raise SystemExit(feed.main(ProductionServer))

"""Offline production policy and bounded WSGI stream lifecycle checks."""

import json
import os
import threading
import time
import unittest
from unittest.mock import patch

import segmentation_feed as feed
import production_server as production


class ProductionTests(unittest.TestCase):
    def setUp(self):
        self.state = feed.StreamingFrame("camera-1", 10, 2, threading.Event())
        self.state.publish_raw(b"jpeg", time.monotonic())
        self.state.publish_result(b"evidence", 0, "now")
        self.app = production.application_for(self.state, ("https://frontend.invalid",),
                                             "127.0.0.1", 5001, ("backend.invalid",))

    def request(self, path="/health", **values):
        environ = dict(PATH_INFO=path, REQUEST_METHOD="GET", HTTP_HOST="backend.invalid",
                       HTTP_ORIGIN="https://frontend.invalid")
        environ.update(values)
        result = []
        body = self.app(environ, lambda status, headers: result.append((status, dict(headers))))
        return result[0], body

    def test_shared_health_evidence_and_host_origin_policy(self):
        (status, headers), body = self.request()
        self.assertEqual(status, "200 OK")
        self.assertEqual(json.loads(b"".join(body))["cameraDocId"], "camera-1")
        self.assertEqual(headers["Access-Control-Allow-Origin"], "https://frontend.invalid")
        self.assertEqual(b"".join(self.request("/latest-segmentation.jpg")[1]), b"evidence")
        self.assertEqual(self.request(HTTP_HOST="evil.invalid")[0][0], "403 Forbidden")
        self.assertEqual(self.request(HTTP_ORIGIN="null")[0][0], "403 Forbidden")
        self.assertEqual(self.request(HTTP_ORIGIN="https://evil.invalid")[0][0], "403 Forbidden")
        self.assertEqual(self.request(REQUEST_METHOD="POST")[0][0], "405 Method Not Allowed")
        self.assertEqual(self.request(REQUEST_METHOD="OPTIONS")[0][0], "204 No Content")
        self.assertEqual(self.request("/.env")[0][0], "404 Not Found")

    def test_stream_exact_identity_current_frame_and_close(self):
        (status, _), stream = self.request("/segmentation-stream.mjpg",
                                         QUERY_STRING="cameraDocId=camera-1&streamId=viewer")
        self.assertEqual(status, "200 OK")
        self.assertTrue(self.state.client_active("viewer"))
        self.assertTrue(next(stream).endswith(b"jpeg\r\n"))
        stream.close()
        stream.close()
        self.assertFalse(self.state.client_active("viewer"))
        self.assertEqual(self.request("/segmentation-stream.mjpg",
                                     QUERY_STRING="cameraDocId=other")[0][0], "409 Conflict")

    def test_bounded_viewers_and_close_before_first_iteration(self):
        streams = [self.request("/segmentation-stream.mjpg")[1] for _ in range(8)]
        self.assertEqual(self.request("/segmentation-stream.mjpg")[0][0], "503 Service Unavailable")
        for stream in streams:
            stream.close()
        (status, _), stream = self.request("/segmentation-stream.mjpg")
        self.assertEqual(status, "200 OK")
        self.state.stop.set()
        with self.assertRaises(StopIteration):
            next(stream)
        self.assertTrue(stream.closed)

    def test_host_configuration_rejects_wildcards_urls_and_bad_ports(self):
        for value in ("*", "https://backend.invalid", "backend.invalid/path", "backend.invalid:99999", ""):
            with patch.dict(os.environ, {"SEGMENTATION_ALLOWED_HOSTS": value}, clear=True):
                with self.assertRaises(ValueError):
                    feed.allowed_hosts_configuration("127.0.0.1", 5001)

    def test_real_waitress_health_and_shutdown_without_camera(self):
        # A real loopback socket tests production serving, never camera/cloud calls.
        try:
            import waitress
        except ImportError:
            self.skipTest("Waitress absent in legacy local venv; run with fresh requirements")
        from urllib.request import Request, urlopen
        import socket
        with patch.dict(os.environ, {"SEGMENTATION_ALLOWED_HOSTS": "backend.invalid",
                                   "SEGMENTATION_ALLOWED_ORIGINS": "https://frontend.invalid"}, clear=True):
            server = production.ProductionServer(self.state, ("https://frontend.invalid",),
                                                 "127.0.0.1", 0, ("backend.invalid",))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        idle = socket.create_connection(("127.0.0.1", server.server.effective_port), timeout=3)
        try:
            request = Request(f"http://127.0.0.1:{server.server.effective_port}/health",
                              headers={"Host": "backend.invalid"})
            with urlopen(request, timeout=3) as response:
                self.assertEqual(json.load(response)["cameraDocId"], "camera-1")
        finally:
            self.state.stop.set()
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()
            idle.close()
        self.assertFalse(thread.is_alive(), "Production event loop must terminate on shutdown")


if __name__ == "__main__":
    unittest.main()

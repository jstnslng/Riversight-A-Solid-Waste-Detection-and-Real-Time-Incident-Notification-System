"""Offline production policy and bounded WSGI stream lifecycle checks."""

import contextlib
import errno
import io
import json
import os
import threading
import time
import unittest
from unittest.mock import Mock, patch

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

    def test_platform_port_and_production_bind_preserve_local_defaults(self):
        with patch.dict(os.environ, {"PORT": "8080"}, clear=True):
            self.assertEqual(feed.feed_configuration()[:2], ("127.0.0.1", 5001))
            self.assertEqual(feed.feed_configuration(production=True)[:2], ("0.0.0.0", 8080))
        with patch.dict(os.environ, {"PORT": "8080", "SEGMENTATION_FEED_PORT": "5002",
                                   "SEGMENTATION_FEED_HOST": "127.0.0.1"}, clear=True):
            self.assertEqual(feed.feed_configuration(production=True)[:2], ("127.0.0.1", 5002))
        with patch.dict(os.environ, {"PORT": "sensitive-invalid-value"}, clear=True):
            with self.assertRaises(ValueError):
                feed.feed_configuration(production=True)

    def test_stage_diagnostics_do_not_print_sensitive_exception_or_environment(self):
        cases = (("configuration", "cloud_camera_configuration", RuntimeError("PRIVATE")),
                 ("feed_configuration", "feed_configuration", ValueError("PRIVATE")),
                 ("stream_configuration", "stream_configuration", ValueError("PRIVATE")),
                 ("tracking_configuration", "tracking_configuration", ValueError("PRIVATE")),
                 ("allowed_hosts_configuration", "host_allowlist", ValueError("PRIVATE")))
        for function, stage, error in cases:
            with self.subTest(stage=stage), patch.dict(os.environ, {}, clear=True), \
                    patch.object(feed, "configuration", return_value=("PRIVATE",) * 3), \
                    patch.object(feed, "feed_configuration", return_value=("127.0.0.1", 5001, 2, ())), \
                    patch.object(feed, "stream_configuration", return_value=0), \
                    patch.object(feed, function, side_effect=error), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(feed.main(Mock()), 1)
            self.assertIn(f"Startup failed: stage={stage}", output.getvalue())
            self.assertNotIn("PRIVATE", output.getvalue())
        with contextlib.redirect_stdout(io.StringIO()) as output:
            feed.startup_failure("http_server_initialization", OSError(errno.EADDRINUSE, "PRIVATE"))
            feed.startup_failure("http_dependencies", ImportError("PRIVATE"))
        self.assertIn("code=address_in_use", output.getvalue())
        self.assertIn("code=dependency_unavailable", output.getvalue())
        self.assertNotIn("PRIVATE", output.getvalue())

    def test_production_rejections_are_specific_and_keep_security_enabled(self):
        # Fake only the dependency import, so policy tests also run in legacy venv.
        import types
        dependency = types.ModuleType("waitress")
        dependency.create_server = Mock()
        valid = {"SEGMENTATION_ALLOWED_HOSTS": "backend.invalid",
                 "SEGMENTATION_ALLOWED_ORIGINS": "https://frontend.invalid"}
        cases = (({"SEGMENTATION_ALLOWED_ORIGINS": valid["SEGMENTATION_ALLOWED_ORIGINS"]},
                  "camera-1", ("https://frontend.invalid",), "missing_allowed_hosts"),
                 ({"SEGMENTATION_ALLOWED_HOSTS": "backend.invalid"},
                  "camera-1", ("https://frontend.invalid",), "missing_allowed_origins"),
                 (valid, "", ("https://frontend.invalid",), "missing_camera_identity"),
                 (valid, "camera-1", ("http://frontend.invalid",), "https_origins_required"))
        for environment, identity, origins, code in cases:
            with patch.dict(os.environ, environment, clear=True), \
                    patch.dict("sys.modules", {"waitress": dependency}), \
                    self.assertRaises(feed.StartupError) as caught:
                production.ProductionServer(feed.LatestFrame(identity), origins,
                                            "127.0.0.1", 5001, ("backend.invalid",))
            self.assertEqual(caught.exception.code, code)
        dependency.create_server.assert_not_called()

    def test_factory_failure_is_reported_without_opening_camera(self):
        factory = Mock(side_effect=feed.StartupError("missing_allowed_origins"))
        with patch.dict(os.environ, {}, clear=True), \
                patch.object(feed, "configuration", return_value=("PRIVATE",) * 3), \
                patch.object(feed, "LiveCapture") as capture, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(feed.main(factory), 1)
        self.assertIn("stage=http_server_initialization code=missing_allowed_origins", output.getvalue())
        self.assertNotIn("PRIVATE", output.getvalue())
        capture.assert_not_called()

    def test_worker_start_failure_is_reported_and_resources_closed(self):
        for dependency, stage in (("TrackingWorker", "tracking_worker_start"),
                                  ("LiveCapture", "capture_worker_start")):
            server = Mock()
            tracking, capture = Mock(), Mock()
            failing = tracking if dependency == "TrackingWorker" else capture
            failing.start.side_effect = RuntimeError("PRIVATE")
            with self.subTest(stage=stage), patch.dict(os.environ, {}, clear=True), \
                    patch.object(feed, "configuration", return_value=("PRIVATE",) * 3), \
                    patch.object(feed, "TrackingWorker", return_value=tracking), \
                    patch.object(feed, "LiveCapture", return_value=capture), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(feed.main(Mock(return_value=server)), 1)
            self.assertIn(f"stage={stage} code=initialization_failed", output.getvalue())
            self.assertNotIn("PRIVATE", output.getvalue())
            failing.close.assert_called_once()
            server.server_close.assert_called_once()

    def test_real_waitress_health_and_shutdown_without_camera(self):
        # A real loopback socket tests production serving, never camera/cloud calls.
        try:
            import waitress
        except ImportError:
            self.skipTest("Waitress absent in legacy local venv; run with fresh requirements")
        from urllib.request import Request, urlopen
        import socket
        with patch.dict(os.environ, {"SEGMENTATION_ALLOWED_HOSTS": "backend.invalid",
                                   "SEGMENTATION_ALLOWED_ORIGINS": "https://frontend.invalid"}, clear=True), \
                patch.object(production.FirebaseAccess, "from_environment", return_value=Mock()):
            server = production.ProductionServer(self.state, ("https://frontend.invalid",),
                                                 "127.0.0.1", 0, ("backend.invalid",))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        idle = socket.create_connection(("127.0.0.1", server.server.effective_port), timeout=3)
        try:
            request = Request(f"http://127.0.0.1:{server.server.effective_port}/health",
                              headers={"Host": "backend.invalid"})
            with urlopen(request, timeout=3) as response:
                self.assertEqual(json.load(response), {"status": "alive"})
        finally:
            self.state.stop.set()
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()
            idle.close()
        self.assertFalse(thread.is_alive(), "Production event loop must terminate on shutdown")

    def test_real_waitress_preflight_empty_post_and_protected_routes(self):
        try:
            import waitress
        except ImportError:
            self.skipTest("Waitress absent in legacy local venv")
        import http.client
        access = Mock()
        access.authorize.return_value = time.time() + 300
        with patch.dict(os.environ, {"SEGMENTATION_ALLOWED_HOSTS": "backend.invalid",
                                   "SEGMENTATION_ALLOWED_ORIGINS": "https://frontend.invalid"}, clear=True), \
                patch.object(production.FirebaseAccess, "from_environment", return_value=access):
            server = production.ProductionServer(self.state, ("https://frontend.invalid",),
                                                 "127.0.0.1", 0, ("backend.invalid",))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", server.server.effective_port, timeout=3)
        headers = {"Host": "backend.invalid", "Origin": "https://frontend.invalid"}
        try:
            connection.request("OPTIONS", "/stream-ticket?cameraDocId=camera-1", headers={
                **headers, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization"})
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader("Access-Control-Allow-Headers"), "Authorization")
            response.read()
            access.authorize.assert_not_called()
            connection.request("GET", "/latest-segmentation.jpg?cameraDocId=camera-1", headers=headers)
            response = connection.getresponse()
            self.assertEqual(response.status, 401)
            response.read()
            connection.request("POST", "/stream-ticket?cameraDocId=camera-1", body=b"", headers={
                **headers, "Authorization": "Bearer offline-test-token"})
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertTrue(json.loads(response.read())["ticket"])
            access.authorize.assert_called_once_with("offline-test-token", "camera-1")
        finally:
            connection.close()
            self.state.stop.set()
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()
        self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    unittest.main()

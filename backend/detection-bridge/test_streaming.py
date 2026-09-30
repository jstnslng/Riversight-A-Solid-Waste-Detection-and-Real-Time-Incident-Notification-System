"""Offline streaming coverage: synthetic JPEGs, fake camera/process/socket only."""

from email.message import Message
import io
import json
import os
import threading
import time
import unittest
from unittest.mock import Mock, patch

import cv2
import numpy as np

import live_capture as capture
import segmentation_feed as feed


class StreamingTests(unittest.TestCase):
    def setUp(self):
        self.stop = threading.Event()
        self.state = feed.StreamingFrame('fixture-doc', 10, 2, self.stop)
        self.jpeg = cv2.imencode('.jpg', np.full((80, 320, 3), 50, np.uint8))[1].tobytes()
        self.newer = cv2.imencode('.jpg', np.full((80, 320, 3), 200, np.uint8))[1].tobytes()

    def healthy(self):
        self.state.publish_raw(self.jpeg, time.monotonic())
        self.state.publish_result(self.jpeg, 0, '2026-01-01T12:00:00+00:00')

    def handler(self, path='/segmentation-stream.mjpg?cameraDocId=fixture-doc', origin='http://127.0.0.1:8000'):
        handler = object.__new__(feed.handler_for(self.state, (origin,), '127.0.0.1', 5001))
        handler.path = path
        handler.headers = Message()
        handler.headers['Host'] = '127.0.0.1:5001'
        handler.headers['Origin'] = origin
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler.connection = Mock()
        handler.wfile = io.BytesIO()
        return handler

    def test_multipart_boundary_identity_cors_and_no_content_length_for_stream(self):
        self.healthy()
        handler = self.handler()
        with patch.object(self.state.stop, 'wait', side_effect=lambda _: self.stop.set()):
            handler.respond(False)
        handler.send_response.assert_called_once_with(200)
        headers = dict(call.args for call in handler.send_header.call_args_list)
        self.assertEqual(headers['Content-Type'], 'multipart/x-mixed-replace; boundary=frame')
        self.assertEqual(headers['Access-Control-Allow-Origin'], 'http://127.0.0.1:8000')
        self.assertEqual(headers['X-Camera-Doc-Id'], 'fixture-doc')
        self.assertNotIn('Content-Length', headers)
        part = (b'--frame\r\nContent-Type: image/jpeg\r\nContent-Length: '
                + str(len(self.jpeg)).encode() + b'\r\n\r\n' + self.jpeg + b'\r\n--frame--\r\n')
        self.assertEqual(handler.wfile.getvalue(), part)

    def test_unavailable_mismatch_and_untrusted_origin(self):
        handler = self.handler()
        handler.respond(False)
        handler.send_response.assert_called_once_with(503)
        self.healthy()
        handler = self.handler('/segmentation-stream.mjpg?cameraDocId=fixture')
        handler.respond(False)
        handler.send_response.assert_called_once_with(409)
        handler = self.handler()
        handler.headers.replace_header('Origin', 'null')
        handler.respond(False)
        handler.send_response.assert_called_once_with(403)

    def test_viewer_connection_health_is_removed_after_disconnect(self):
        self.healthy()
        handler = self.handler('/segmentation-stream.mjpg?cameraDocId=fixture-doc&streamId=viewer-1')
        handler.wfile = Mock()
        def disconnect(_):
            health_request = self.handler('/health?streamId=viewer-1')
            health_request.respond(False)
            health = json.loads(health_request.wfile.getvalue())
            self.assertTrue(health['streamClientActive'])
            self.assertNotIn('viewer-1', json.dumps(health))
            raise BrokenPipeError()
        handler.wfile.write.side_effect = disconnect
        handler.respond(False)
        health_request = self.handler('/health?streamId=viewer-1')
        health_request.respond(False)
        self.assertFalse(json.loads(health_request.wfile.getvalue())['streamClientActive'])
        self.assertEqual(self.state.sessions, set())

    def test_disconnected_and_multiple_viewers_do_not_start_pipeline_workers(self):
        self.healthy()
        with patch.object(feed, 'LiveCapture') as worker, patch.object(feed, 'predict') as predict, \
                patch.object(feed, 'TrackingWorker') as tracker, \
                patch.object(feed, 'capture_one_frame') as one_frame:
            for exception in (BrokenPipeError, ConnectionResetError, TimeoutError):
                handler = self.handler()
                handler.wfile = Mock()
                handler.wfile.write.side_effect = exception
                handler.respond(False)
                self.assertTrue(handler.close_connection)
            worker.assert_not_called()
            predict.assert_not_called()
            one_frame.assert_not_called()
            tracker.assert_not_called()
        self.assertFalse(self.stop.is_set())
        self.assertTrue(self.state.snapshot()[1]['streamAvailable'])
        # Client slots are returned even on write failures.
        for _ in range(8):
            self.assertTrue(self.state.clients.acquire(blocking=False))
        handler = self.handler()
        handler.respond(False)
        handler.send_response.assert_called_once_with(503)

    def test_exact_inference_snapshot_never_replaces_current_live_frame(self):
        self.state.publish_raw(self.jpeg, time.monotonic() - 0.1)
        def infer(*args):
            self.assertIs(args[2], self.jpeg)
            self.state.publish_raw(self.newer, time.monotonic())
            return [], 0
        with patch.object(feed, 'predict', side_effect=infer), \
                patch.object(feed, 'capture_one_frame') as one_frame:
            feed.sample_cycle(self.state, 'PRIVATE', 'PRIVATE', 'PRIVATE', None)
        one_frame.assert_not_called()
        self.assertEqual(self.state.snapshot()[0], self.jpeg)
        self.assertEqual(self.state.stream_frame(), self.newer)
        self.assertEqual(feed.response_for(self.state, '/latest-segmentation.jpg')[2], self.jpeg)

    def test_capture_failure_stale_result_and_recovery(self):
        self.healthy()
        self.state.raw_mono -= 4
        self.assertIsNone(self.state.stream_frame())
        self.state.publish_raw(self.newer, time.monotonic())
        self.state.result_mono -= 16
        self.assertIsNone(self.state.stream_frame())
        self.healthy()
        self.assertIsNotNone(self.state.stream_frame())
        self.state.capture_failed()
        self.assertIsNone(self.state.stream_frame())
        self.healthy()
        self.state.failure()
        self.assertIsNone(self.state.stream_frame())
        self.healthy()
        self.stop.set()
        self.assertIsNone(self.state.stream_frame())

    def test_health_zero_predictions_safe_fields_and_bounded_latest_state(self):
        self.healthy()
        self.state.raw_mono -= 0.1
        for _ in range(100):
            self.state.publish_raw(self.newer, time.monotonic())
        _, health = self.state.snapshot()
        self.assertTrue(health['captureActive'])
        self.assertTrue(health['streamAvailable'])
        self.assertEqual(health['lastPredictionCount'], 0)
        self.assertEqual(set(health), {'status', 'model', 'latestFrameAvailable', 'lastInferenceAt',
            'lastPredictionCount', 'cameraDocId', 'streamEnabled', 'streamAvailable',
            'captureActive', 'lastFrameAt', 'inferenceIntervalSeconds', 'streamTargetFps',
            'trackingEnabled', 'activeTrackCount', 'lastTrackingUpdateAt', 'trackMaxAgeSeconds',
            'lastInferenceCapturedAt', 'lastCloudRequestAt', 'lastCloudResponseAt',
            'latestInferenceLatencyMs', 'averageInferenceLatencyMs', 'inferenceFrameAgeMs'})
        self.assertNotIn('PRIVATE', json.dumps(health))
        self.assertIs(self.state.raw, self.newer)
        self.assertEqual(self.state.latencies.maxlen, 60)
        self.assertIsNone(self.state.pending)

    def test_stream_config_and_snapshot_rollback(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(feed.stream_configuration(), 10)
        for value in ('nan', 'inf', '-1', '16', 'PRIVATE', '0.5'):
            with patch.dict(os.environ, {'SEGMENTATION_STREAM_FPS': value}, clear=True):
                with self.assertRaisesRegex(ValueError, '^Invalid stream FPS'):
                    feed.stream_configuration()
        with patch.dict(os.environ, {'SEGMENTATION_STREAM_FPS': '0'}, clear=True):
            self.assertEqual(feed.stream_configuration(), 0)
        self.state = feed.LatestFrame('fixture-doc')
        self.state.publish(self.jpeg, 0)
        handler = self.handler()
        handler.respond(False)
        handler.send_response.assert_called_once_with(503)
        self.assertEqual(feed.response_for(self.state, '/latest-segmentation.jpg')[2], self.jpeg)

    def test_capture_reader_bounded_protocol_and_stale_drop(self):
        worker = capture.LiveCapture(self.state, 'PRIVATE', 10, self.stop)
        packet = capture.HEADER.pack(len(self.jpeg), time.monotonic()) + self.jpeg
        ended = threading.Event()
        worker.receive(Mock(stdout=io.BytesIO(packet)), ended)
        self.assertTrue(ended.is_set())
        self.assertEqual(self.state.raw, self.jpeg)
        for packet in (capture.HEADER.pack(capture.MAX_JPEG_BYTES + 1, time.monotonic()),
                       capture.HEADER.pack(len(self.newer), time.monotonic() - 5) + self.newer,
                       b'native diagnostic PRIVATE'):
            worker.receive(Mock(stdout=io.BytesIO(packet)), threading.Event())
            self.assertEqual(self.state.raw, self.jpeg)

    def test_supervisor_reconnects_with_one_process_and_no_secret_arguments(self):
        worker = capture.LiveCapture(self.state, 'PRIVATE', 10, self.stop)
        process = Mock(stdout=io.BytesIO())
        process.poll.return_value = None
        waits = iter([False, False, True, True])
        # First watchdog tick detects stale capture; reconnect delay then a second
        # process, whose watchdog tick requests shutdown.
        def wait(_):
            result = next(waits)
            if result:
                self.stop.set()
            return result
        with patch.object(capture.subprocess, 'Popen', return_value=process) as popen, \
                patch.object(capture.threading, 'Thread') as reader, \
                patch.object(self.stop, 'wait', side_effect=wait), \
                patch.object(capture.time, 'monotonic', side_effect=[0, 20, 30]), \
                patch.dict(os.environ, {'ULTRALYTICS_API_KEY': 'PRIVATE'}, clear=True):
            worker.run()
        self.assertEqual(popen.call_count, 2)
        self.assertEqual(process.kill.call_count, 2)
        self.assertEqual(reader.call_count, 2)
        args, kwargs = popen.call_args
        self.assertNotIn('PRIVATE', str(args))
        self.assertNotIn('ULTRALYTICS_API_KEY', kwargs['env'])
        self.assertEqual(kwargs['stderr'], capture.subprocess.DEVNULL)

    def test_main_owns_one_capture_and_one_inference_scheduler(self):
        with patch.object(feed, 'configuration', return_value=('PRIVATE',) * 3), \
                patch.object(feed, 'feed_configuration', return_value=('127.0.0.1', 5001, 2, ())), \
                patch.object(feed, 'stream_configuration', return_value=10), \
                patch.object(feed, 'LiveCapture') as capture_class, \
                patch.object(feed, 'TrackingWorker') as tracking_class, \
                patch.object(feed, 'ThreadingHTTPServer'), \
                patch.object(feed.threading, 'Thread'), \
                patch.object(feed, 'sampling_loop', side_effect=KeyboardInterrupt) as loop:
            self.assertEqual(feed.main(), 0)
        capture_class.assert_called_once()
        capture_class.return_value.start.assert_called_once()
        capture_class.return_value.close.assert_called_once()
        loop.assert_called_once()
        tracking_class.assert_called_once()
        tracking_class.return_value.start.assert_called_once()
        tracking_class.return_value.close.assert_called_once()

    def test_persistent_camera_worker_reads_many_frames_with_one_open(self):
        camera = Mock()
        frame = np.zeros((20, 20, 3), np.uint8)
        camera.read.side_effect = [(True, frame), (True, frame), (True, frame), (False, None)]
        output = io.BytesIO()
        with patch.dict(os.environ, {'CAMERA_RTSP_URL': 'PRIVATE', 'SEGMENTATION_STREAM_FPS': '10'}), \
                patch.object(cv2, 'VideoCapture', return_value=camera), \
                patch.object(cv2, 'imencode', wraps=cv2.imencode) as encode, \
                patch.object(capture.time, 'monotonic', side_effect=[1, 1.01, 1.2, 1.3]), \
                patch.object(capture.sys, 'stdout', Mock(buffer=output)):
            capture.capture_worker()
        camera.open.assert_called_once()
        camera.release.assert_called_once()
        self.assertEqual(camera.read.call_count, 4)
        self.assertEqual(encode.call_count, 2)
        self.assertNotIn(b'PRIVATE', output.getvalue())


if __name__ == '__main__':
    unittest.main()

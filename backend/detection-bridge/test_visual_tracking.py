"""Deterministic synthetic motion; no camera, cloud, private env or sockets."""

from copy import deepcopy
import contextlib
import io
import os
import threading
import time
import unittest
from unittest.mock import Mock, patch

import cv2
import numpy as np

import segmentation_feed as feed
from visual_tracking import MAX_TRACKS, TrackingWorker, VisualTracker


def frame_at(x=80, second=None):
    image = np.full((200, 320, 3), 15, np.uint8)
    texture = np.random.default_rng(42).integers(40, 240, (48, 48, 3), dtype=np.uint8)
    image[70:118, x:x + 48] = texture
    if second is not None:
        image[135:183, second:second + 48] = texture[::-1]
    return image


def prediction(x=80, y=70, confidence=0.82, name='Plastic', class_id=0):
    return dict(name=name, confidence=confidence, **{'class': class_id},
                box=dict(x1=x, y1=y, x2=x + 48, y2=y + 48),
                segments=dict(x=[x, x + 48, x + 48, x], y=[y, y, y + 48, y + 48]))


def jpeg(frame):
    return cv2.imencode('.jpg', frame)[1].tobytes()


class TrackingTests(unittest.TestCase):
    def initialized(self, frame=None, predictions=None):
        tracker = VisualTracker()
        frame = frame_at() if frame is None else frame
        tracker.advance(frame, 10)
        tracker.correct(frame, [prediction()] if predictions is None else predictions, 10, 10)
        return tracker

    def test_real_optical_flow_moves_polygon_and_retains_yolo_confidence(self):
        reference = prediction()
        original = deepcopy(reference)
        tracker = self.initialized(predictions=[reference])
        self.assertEqual(len(tracker.tracks), 1)
        tracker.advance(frame_at(90), 10.1)
        rows = tracker.rows(10.1)
        self.assertEqual(len(rows), 1)
        self.assertAlmostEqual(rows[0]['segments']['x'][0], 90, delta=0.7)
        self.assertAlmostEqual(rows[0]['segments']['y'][0], 70, delta=0.7)
        self.assertEqual(rows[0]['confidence'], 0.82)
        self.assertEqual(reference, original)

    def test_delayed_result_is_aligned_through_history_not_initialized_on_new_frame(self):
        tracker = VisualTracker()
        for step in range(4):
            tracker.advance(frame_at(80 + step * 5), 10 + step * 0.1)
        tracker.correct(frame_at(), [prediction()], 10, 10.3)
        row = tracker.rows(10.3)[0]
        self.assertAlmostEqual(row['segments']['x'][0], 95, delta=1)
        self.assertEqual(tracker.tracks[0]['yolo_at'], 10)

    def test_missing_history_old_results_and_frame_size_changes_fail_closed(self):
        tracker = VisualTracker()
        tracker.advance(frame_at(100), 11)
        tracker.correct(frame_at(), [prediction()], 10, 11)
        self.assertEqual(tracker.rows(11), [])
        tracker.correct(frame_at(100), [prediction(100)], 11, 15)
        self.assertEqual(tracker.rows(15), [])
        tracker = self.initialized()
        tracker.advance(np.zeros((100, 160, 3), np.uint8), 10.1)
        self.assertEqual(tracker.rows(10.1), [])

    def test_new_yolo_corrects_same_class_track_and_confidence_authoritatively(self):
        tracker = self.initialized()
        track_id = tracker.tracks[0]['id']
        tracker.advance(frame_at(90), 10.1)
        tracker.correct(frame_at(90), [prediction(90, confidence=0.76)], 10.1, 10.1)
        self.assertEqual(tracker.tracks[0]['id'], track_id)
        self.assertEqual(tracker.rows(10.1)[0]['confidence'], 0.76)
        self.assertEqual(tracker.rows(10.1)[0]['segments']['x'][0], 90)
        tracker.correct(frame_at(90), [prediction(90, name='Bottle', class_id=1)], 10.1, 10.1)
        self.assertNotEqual(tracker.tracks[0]['id'], track_id)
        self.assertEqual(len(tracker.tracks), 1)  # No stale class label over the new class.

    def test_failed_tracking_textureless_initialization_and_excessive_motion(self):
        tracker = self.initialized()
        tracker.advance(np.zeros((200, 320, 3), np.uint8), 10.1)
        self.assertEqual(tracker.rows(10.1), [])
        self.assertEqual(self.initialized(np.zeros((200, 320, 3), np.uint8)).rows(10), [])
        tracker = self.initialized()
        tracker.advance(frame_at(120), 10.1)
        self.assertEqual(tracker.rows(10.1), [])

    def test_expiry_from_source_time_and_zero_detection_grace_never_extend_age(self):
        tracker = self.initialized()
        self.assertEqual(tracker.rows(13.001), [])
        tracker = self.initialized()
        tracker.correct(frame_at(), [], 10, 10.1)
        self.assertEqual(len(tracker.rows(10.2)), 1)
        tracker.correct(frame_at(), [], 10, 10.4)
        self.assertEqual(tracker.rows(10.61), [])  # Second miss did not extend grace.

    def test_polygon_clamps_and_object_exit_removes_geometry(self):
        tracker = self.initialized(frame_at(270), [prediction(270)])
        tracker.tracks[0]['shift'][:] = [5, 0]
        row = tracker.rows(10)[0]
        self.assertLessEqual(max(row['segments']['x']), 319)
        self.assertGreaterEqual(min(row['segments']['x']), 0)
        tracker.tracks[0]['shift'][:] = [320, 0]
        self.assertEqual(tracker.rows(10), [])

    def test_multiple_independent_objects_and_visualization_cap(self):
        tracker = self.initialized(frame_at(40, 180), [prediction(40), prediction(180, 135)])
        tracker.advance(frame_at(50, 175), 10.1)
        rows = tracker.rows(10.1)
        self.assertEqual(len(rows), 2)
        self.assertAlmostEqual(rows[0]['box']['x1'], 50, delta=1)
        self.assertAlmostEqual(rows[1]['box']['x1'], 175, delta=1)
        tracker = self.initialized(predictions=[prediction() for _ in range(100)])
        self.assertEqual(len(tracker.tracks), MAX_TRACKS)

    def test_gray_history_is_bounded_and_backwards_frames_ignored(self):
        tracker = VisualTracker()
        for step in range(500):
            tracker.advance(frame_at(), 10 + step * 0.01)
        self.assertLessEqual(len(tracker.history), 47)
        self.assertLessEqual(tracker.history[-1][1].size, 640 * 640)
        last = tracker.history[-1][0]
        tracker.advance(frame_at(90), 10)
        self.assertEqual(tracker.history[-1][0], last)

    def test_worker_renders_current_frame_only_and_evidence_is_separate(self):
        state = feed.StreamingFrame('fixture', 10, 2, threading.Event())
        worker = TrackingWorker(state)
        source = jpeg(frame_at())
        with patch.object(time, 'monotonic', return_value=10.2):
            state.publish_raw(source, 10)
            worker.tick()
            current = jpeg(frame_at(90))
            state.publish_raw(current, 10.1)
            worker.tick()
            exact, count = feed.processed_jpeg(source, [prediction()])
            state.publish_result(exact, count, 'safe-timestamp', (source, [prediction()], 10, 0))
            worker.tick()
            self.assertEqual(state.snapshot()[0], exact)
            self.assertEqual(state.rendered_mono, 10.1)
            self.assertEqual(state.snapshot()[1]['activeTrackCount'], 1)
            self.assertEqual(state.stream_frame(), state.rendered)
            newest = jpeg(frame_at(100))
            state.publish_raw(newest, 10.2)
            self.assertEqual(state.stream_frame(), newest)  # No older tracked frame while worker lags.
            state.publish_tracked(b'old', 10.1, 0, 1, 13)
            self.assertEqual(state.stream_frame(), newest)
            state.publish_raw(source, 10)
            self.assertEqual(state.stream_frame(), newest)

    def test_disabled_tracking_continues_current_stream_without_result_replay(self):
        state = feed.StreamingFrame('fixture', 10, 2, threading.Event(), tracking_enabled=False)
        raw, old = jpeg(frame_at(100)), jpeg(frame_at())
        state.publish_raw(raw, time.monotonic())
        state.publish_result(old, 1, 'safe', (old, [prediction()], time.monotonic(), 0))
        self.assertEqual(state.stream_frame(), raw)
        self.assertIsNone(state.pending)
        self.assertFalse(state.snapshot()[1]['trackingEnabled'])
        self.assertEqual(feed.response_for(state, '/latest-segmentation.jpg')[2], old)

    def test_expired_overlay_and_tracking_error_keep_current_raw_video(self):
        state = feed.StreamingFrame('fixture', 10, 2, threading.Event())
        raw = jpeg(frame_at())
        with patch.object(time, 'monotonic', return_value=10):
            state.publish_raw(raw, 10)
            state.publish_result(raw, 0, 'safe')
            state.publish_tracked(b'estimate', 10, 0, 1, 10.5)
            self.assertEqual(state.stream_frame(), b'estimate')
        with patch.object(time, 'monotonic', return_value=10.6):
            self.assertEqual(state.stream_frame(), raw)
            self.assertEqual(state.snapshot()[1]['activeTrackCount'], 0)
            state.tracking_failed()
            self.assertEqual(state.stream_frame(), raw)

    def test_latest_result_mailbox_is_bounded_and_consumed_once(self):
        state = feed.StreamingFrame('fixture', 10, 2, threading.Event())
        raw = jpeg(frame_at())
        state.publish_raw(raw, time.monotonic())
        for _ in range(100):
            state.publish_result(raw, 100, 'safe', (raw, [prediction()] * 100, state.raw_mono, 0))
        self.assertEqual(len(state.pending[1]), MAX_TRACKS)
        self.assertIsNotNone(state.tracking_input()[3])
        self.assertIsNone(state.tracking_input()[3])

    def test_capture_reconnect_invalidates_pending_and_late_render(self):
        state = feed.StreamingFrame('fixture', 10, 2, threading.Event())
        worker = TrackingWorker(state)
        with patch.object(time, 'monotonic', return_value=10.2):
            raw = jpeg(frame_at())
            state.publish_raw(raw, 10)
            worker.tick()
            state.capture_failed()
            state.publish_raw(raw, 10.1)
            state.publish_result(raw, 1, 'safe', (raw, [prediction()], 10, 0))
            self.assertIsNone(state.pending)
            state.publish_tracked(b'old', 10.1, 0, 1, 13)
            self.assertEqual(state.stream_frame(), raw)
            worker.tick()
            self.assertEqual(worker.tracker.tracks, [])

    def test_latency_measurements_and_history_bound(self):
        state = feed.LatestFrame()
        for _ in range(100):
            state.record_timing('capture', 10, 'start', 10.1, 'response', 10.55)
        health = state.snapshot()[1]
        self.assertEqual(health['latestInferenceLatencyMs'], 450)
        self.assertEqual(health['averageInferenceLatencyMs'], 450)
        self.assertEqual(health['inferenceFrameAgeMs'], 550)
        self.assertEqual(len(state.latencies), 60)
        self.assertEqual(health['lastInferenceCapturedAt'], 'capture')
        self.assertEqual(health['lastCloudRequestAt'], 'start')
        self.assertEqual(health['lastCloudResponseAt'], 'response')

    def test_tracking_exception_is_sanitized_and_does_not_stop_capture(self):
        state = feed.StreamingFrame('fixture', 10, 2, threading.Event())
        worker = TrackingWorker(state)
        state.stop = Mock()
        state.stop.is_set.side_effect = [False, False, True]
        state.frame_ready.set()
        with patch.object(worker, 'tick', side_effect=RuntimeError('PRIVATE')), \
                patch.object(state, 'tracking_failed') as failed, \
                contextlib.redirect_stdout(io.StringIO()) as output, \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            worker.run()
        failed.assert_called_once()
        state.stop.set.assert_not_called()
        self.assertNotIn('PRIVATE', output.getvalue() + errors.getvalue())

    def test_sample_instrumentation_surrounds_only_one_cloud_request(self):
        state = feed.StreamingFrame('fixture', 10, 2, threading.Event())
        raw = jpeg(frame_at())
        with patch.object(time, 'monotonic', return_value=10):
            state.publish_raw(raw, 10)
        with patch.object(feed, 'predict', return_value=([], None)) as predict, \
                patch.object(time, 'monotonic', side_effect=[10.1, 10.1, 10.55, 10.56]):
            feed.sample_cycle(state, 'PRIVATE', 'PRIVATE', 'PRIVATE', Mock())
        predict.assert_called_once()
        self.assertIs(predict.call_args.args[2], raw)
        self.assertEqual(state.snapshot()[1]['latestInferenceLatencyMs'], 450)
        self.assertEqual(state.snapshot()[0], raw)

    def test_configuration_defaults_and_safe_validation(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(feed.tracking_configuration(), (True, 3))
            self.assertEqual(feed.feed_configuration()[2], 2)
        with patch.dict(os.environ, {'SEGMENTATION_TRACKING_ENABLED': 'false'}, clear=True):
            self.assertEqual(feed.tracking_configuration(), (False, 3))
        for name, value in [('SEGMENTATION_TRACKING_ENABLED', 'PRIVATE'),
                            ('SEGMENTATION_TRACK_MAX_AGE_SECONDS', 'nan'),
                            ('SEGMENTATION_TRACK_MAX_AGE_SECONDS', '0'),
                            ('SEGMENTATION_TRACK_MAX_AGE_SECONDS', '11')]:
            with patch.dict(os.environ, {name: value}, clear=True):
                with self.assertRaises(ValueError) as error:
                    feed.tracking_configuration()
                self.assertNotIn('PRIVATE', str(error.exception))


if __name__ == '__main__':
    unittest.main()

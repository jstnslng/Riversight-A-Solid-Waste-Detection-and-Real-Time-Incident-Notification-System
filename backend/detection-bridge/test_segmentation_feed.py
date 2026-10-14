"""Offline feed tests: HTTP handlers use memory streams, not listening sockets."""

import contextlib
from email.message import Message
import io
import json
import os
import threading
import unittest
from unittest.mock import Mock, patch

import cv2
import numpy as np

import segmentation_feed as feed


class FeedTests(unittest.TestCase):
    def test_configuration_cache_expiry_camera_binding_failures_and_slow_reads(self):
        cache=feed.CameraConfigurationCache('camera',Mock(return_value=dict(waterwayRoi=dict(state='approved'),wasteCoverageClasses={})))
        self.addCleanup(cache.close)
        with patch.object(feed.time,'monotonic',return_value=10):
            cache._refresh()
            self.assertIsNotNone(cache.snapshot('camera')[0])
            self.assertIsNone(cache.snapshot('other')[0])
        with patch.object(feed.time,'monotonic',return_value=15):
            self.assertIsNone(cache.snapshot('camera')[0])
        cache.read.side_effect=RuntimeError('private detail')
        cache._refresh();self.assertIsNone(cache.snapshot('camera')[0])
        cache.read.side_effect=None
        with patch.object(feed.time,'monotonic',side_effect=[10,16]):
            cache._refresh()
        self.assertIsNone(cache.snapshot('camera')[0])

    def test_blocked_firestore_refresh_does_not_block_inference_publication(self):
        import time
        entered,release=threading.Event(),threading.Event()
        def slow_read(path):
            entered.set();release.wait(3);return {}
        cache=feed.CameraConfigurationCache('camera',slow_read)
        self.addCleanup(release.set);self.addCleanup(cache.close)
        cache.start();self.assertTrue(entered.wait(1))
        self.state.camera_doc_id='camera';self.state.coverage_cache=cache
        with patch.object(feed,'capture_one_frame',return_value=(self.jpeg,200,100)), \
                patch.object(feed,'predict',return_value=([],None)):
            started=time.monotonic()
            feed.sample_cycle(self.state,'unused','unused','unused',Mock())
            self.assertLess(time.monotonic()-started,1)
        self.assertFalse(release.is_set())
        jpeg,health=self.state.snapshot()
        self.assertTrue(jpeg);self.assertEqual(health['status'],'ok')
        self.assertFalse(health['waterwayCoverage']['available'])
        release.set();cache.close()

    def test_coverage_configuration_expiry_invalidates_already_published_measurement(self):
        self.state.publish(self.jpeg,1,dict(available=True,percentage=1),10,config_expires=15)
        with patch.object(feed.time,'monotonic',return_value=14):
            self.assertTrue(self.state.snapshot()[1]['waterwayCoverage']['available'])
        with patch.object(feed.time,'monotonic',return_value=15):
            self.assertEqual(self.state.snapshot()[1]['waterwayCoverage']['reason'],'configuration_expired')

    def test_cache_failure_and_draft_invalidate_published_coverage(self):
        import time
        document=dict(waterwayRoi=dict(state='approved',version=1),wasteCoverageClasses=dict(state='approved',version=1))
        reader=Mock(return_value=document)
        cache=feed.CameraConfigurationCache('camera',reader);self.addCleanup(cache.close)
        cache._refresh();self.state.camera_doc_id='camera';self.state.coverage_cache=cache
        self.state.publish(self.jpeg,1,dict(available=True,percentage=1,roiVersion=1,classPolicyVersion=1),time.monotonic(),config_expires=cache.expires)
        self.assertTrue(self.state.snapshot()[1]['waterwayCoverage']['available'])
        document['waterwayRoi']['state']='draft';cache._refresh()
        self.assertEqual(self.state.snapshot()[1]['waterwayCoverage']['reason'],'configuration_changed')
        reader.side_effect=RuntimeError('private error');cache._refresh()
        self.assertFalse(self.state.snapshot()[1]['waterwayCoverage']['available'])

    def test_canonical_roi_maps_normalize_and_serialize_without_nested_arrays(self):
        from prediction_geometry import normalized_roi
        from google.cloud.firestore_v1._helpers import encode_dict
        config=dict(state='approved',version=1,coordinateSpace='normalized',imageDimensions=dict(width=10,height=10),
                    points=[dict(x=0,y=0),dict(x=1,y=0),dict(x=1,y=1),dict(x=0,y=1)])
        self.assertEqual(normalized_roi(config,20,20),[(0,0),(1,0),(1,1),(0,1)])
        encoded=encode_dict(dict(waterwayRoi=config))
        vertices=encoded['waterwayRoi'].map_value.fields['points'].array_value.values
        self.assertTrue(all(vertex._pb.WhichOneof('value_type')=='map_value' for vertex in vertices))
        for malformed in [dict(x=True,y=0),dict(x='0',y=0),dict(x=float('nan'),y=0),dict(x=2,y=0),dict(x=0),dict(x=0,y=0,z=1)]:
            with self.subTest(malformed=malformed), self.assertRaises(ValueError):
                normalized_roi({**config,'points':[malformed,*config['points'][1:]]},10,10)
        predictions=[dict(name='Test',confidence=.9,segments=dict(x=[0,4,4,0],y=[0,0,9,9]))]
        doc=dict(waterwayRoi=config,wasteCoverageClasses=dict(state='approved',version=1,names=['Test']))
        self.assertEqual(feed.waterway_coverage(doc,predictions,10,10)['percentage'],50)

    def setUp(self):
        self.state = feed.LatestFrame()
        self.jpeg = cv2.imencode(".jpg", np.full((100, 200, 3), 100, np.uint8))[1].tobytes()

    def request(self, path, origin="http://localhost:5500", host="127.0.0.1:5001", preflight=False, origins=("http://localhost:5500",)):
        handler = object.__new__(feed.handler_for(self.state, origins, "127.0.0.1", 5001))
        handler.path = path
        handler.headers = Message()
        handler.headers["Host"] = host
        if origin:
            handler.headers["Origin"] = origin
        handler.wfile = io.BytesIO()
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler.respond(preflight)
        return handler.send_response.call_args.args[0], dict(call.args for call in handler.send_header.call_args_list), handler.wfile.getvalue()

    def test_no_frame_health_and_cache_headers(self):
        code, headers, body = self.request("/health")
        self.assertEqual(code, 200)
        self.assertFalse(json.loads(body)["latestFrameAvailable"])
        self.assertEqual(self.request("/latest-segmentation.jpg?t=1")[0], 503)
        self.assertIn("no-store", headers["Cache-Control"])
        self.assertEqual(headers["Access-Control-Allow-Origin"], "http://localhost:5500")
        self.assertEqual(self.request("/.env")[0], 404)

    def test_latest_frame_and_degraded_status(self):
        self.state.publish(self.jpeg, 2)
        code, headers, body = self.request("/latest-segmentation.jpg?t=2")
        self.assertEqual((code, body), (200, self.jpeg))
        self.assertEqual(headers["Content-Type"], "image/jpeg")
        self.assertIn("X-Inference-At", headers)
        self.state.failure()
        health = json.loads(self.request("/health")[2])
        self.assertEqual(health["status"], "degraded")
        self.assertEqual(health["lastPredictionCount"], 2)
        self.assertEqual(set(health), {"status", "model", "latestFrameAvailable", "lastInferenceAt", "lastPredictionCount", "cameraDocId",
            "lastInferenceCapturedAt", "lastCloudRequestAt", "lastCloudResponseAt", "latestInferenceLatencyMs",
            "averageInferenceLatencyMs", "inferenceFrameAgeMs", "waterwayCoverage"})

    def test_coverage_union_intersection_and_dimensions(self):
        document = dict(waterwayRoi=dict(state="approved", version=2, coordinateSpace="normalized",
                        imageDimensions=dict(width=10, height=10), points=[[0,0],[1,0],[1,1],[0,1]]),
                        wasteCoverageClasses=dict(state="approved", version=1, names=["test-waste"]))
        prediction = dict(name="test-waste", confidence=.9, segments=dict(x=[0,4,4,0], y=[0,0,9,9]))
        value = feed.waterway_coverage(document, [prediction, prediction], 10, 10)
        self.assertEqual((value['wastePixels'],value['waterwayPixels'],value['percentage']), (50,100,50))
        self.assertTrue(feed.waterway_coverage(document, [prediction], 20,20)['available'])
        self.assertFalse(feed.waterway_coverage(document, [prediction], 20,10)['available'])
        document['waterwayRoi']['points'] = [[0,0],[4/9,0],[4/9,1],[0,1]]
        outside = dict(name="test-waste", confidence=.9, segments=dict(x=[6,9,9,6],y=[0,0,9,9]))
        self.assertEqual(feed.waterway_coverage(document,[outside],10,10)['percentage'],0)
        document['waterwayRoi'].update(coordinateSpace='pixels', points=[[0,0],[4,0],[4,9],[0,9]])
        self.assertEqual(feed.waterway_coverage(document,[prediction],10,10)['percentage'],100)

    def test_coverage_missing_invalid_and_stale_are_unavailable(self):
        document = dict(waterwayRoi=dict(state="approved", version=1, coordinateSpace="normalized",
                        imageDimensions=dict(width=10,height=10), points=[[0,0],[1,0],[1,1],[0,1]]),
                        wasteCoverageClasses=dict(state="approved", version=1,names=['test-waste']))
        for config, predictions in [(None,[]), ({},[]), (document,[]),
                                    (document,[dict(name='test-waste',confidence=.9,box={})])]:
            result=feed.waterway_coverage(config,predictions,10,10)
            self.assertFalse(result['available'])
            self.assertIsNone(result['percentage'])
        for status in ['unconfigured','draft','needs_recalibration']:
            document['waterwayRoi']['state']=status
            self.assertFalse(feed.waterway_coverage(document,[],10,10)['available'])
        document['waterwayRoi']['state']='approved'
        for points in [[[0,0],[1,1],[0,1],[1,0]], [[0,0],[0,0],[1,1]], [[0,0],[2,0],[1,1]]]:
            document['waterwayRoi']['points']=points
            self.assertFalse(feed.waterway_coverage(document,[],10,10)['available'])
        self.state.publish(self.jpeg,1,dict(available=True,percentage=1),1)
        self.assertEqual(self.state.snapshot()[1]['waterwayCoverage']['reason'],'stale_prediction')
        self.state.failure()
        self.assertEqual(self.state.snapshot()[1]['waterwayCoverage']['reason'],'inference_unavailable')

    def test_coverage_cloud_provenance_and_partial_masks_fail_closed(self):
        from one_frame import safe_predictions
        document=dict(waterwayRoi=dict(state='approved',version=1,coordinateSpace='normalized',
                      imageDimensions=dict(width=10,height=10),points=[[0,0],[1,0],[1,1],[0,1]]),
                      wasteCoverageClasses=dict(state='approved',version=1,names=['Test']))
        row=dict(name='Test',class_=0,confidence=.9,box=dict(x1=0,y1=0,x2=5,y2=5),
                 segments=dict(x=[0,4,4,0],y=[0,0,4,4]))
        row['class']=row.pop('class_')
        predictions,_=safe_predictions(dict(images=[dict(shape=[10,10],results=[row])],metadata=dict(classNames=['Test'])))
        self.assertTrue(feed.waterway_coverage(document,predictions,10,10)['available'])
        self.assertFalse(feed.waterway_coverage(document,predictions,20,20)['available'])
        row['segments']['x'][0]=-1
        predictions,_=safe_predictions(dict(images=[dict(shape=[10,10],results=[row])]))
        self.assertFalse(feed.waterway_coverage(document,predictions,10,10)['available'])
        document['wasteCoverageClasses']['state']='draft'
        self.assertFalse(feed.waterway_coverage(document,predictions,10,10)['available'])

    def test_coverage_read_failure_does_not_break_evidence(self):
        self.state.coverage_reader=Mock(side_effect=RuntimeError('private details'))
        with patch.object(feed,'capture_one_frame',return_value=(self.jpeg,200,100)), \
                patch.object(feed,'predict',return_value=([],None)):
            feed.sample_cycle(self.state,'unused','unused','unused',Mock())
        jpeg,health=self.state.snapshot()
        self.assertTrue(jpeg)
        self.assertEqual(health['status'],'ok')
        self.assertEqual(health['waterwayCoverage']['reason'],'configuration_unavailable')

    def test_safe_explicit_camera_identity(self):
        self.state = feed.LatestFrame("camera-document-1")
        self.state.publish(self.jpeg, 0)
        self.assertEqual(json.loads(self.request("/health")[2])["cameraDocId"], "camera-document-1")
        _, headers, _ = self.request("/latest-segmentation.jpg")
        self.assertEqual(headers["X-Camera-Doc-Id"], "camera-document-1")
        self.assertIn("X-Camera-Doc-Id", headers["Access-Control-Expose-Headers"])
        self.assertEqual(feed.LatestFrame().snapshot()[1]["cameraDocId"], "")
        with self.assertRaises(ValueError):
            feed.LatestFrame("rtsp://private:private@camera/")

    def test_cors_host_and_preflight(self):
        self.assertEqual(self.request("/health", origin="https://untrusted.invalid")[0], 403)
        self.assertEqual(self.request("/health", host="attacker.invalid:5001")[0], 403)
        self.assertEqual(self.request("/health", origin="null")[0], 403)
        self.assertEqual(self.request("/health", origin=None)[0], 200)
        code, headers, _ = self.request("/health", preflight=True)
        self.assertEqual(code, 204)
        self.assertEqual(headers["Access-Control-Allow-Private-Network"], "true")

    def test_atomic_snapshot_replacement(self):
        self.state.publish(b"old", 0)
        old, _ = self.state.snapshot()
        def producer():
            for number in range(1, 500):
                self.state.publish(str(number).encode(), number)
        thread = threading.Thread(target=producer)
        thread.start()
        for _ in range(500):
            jpeg, health = self.state.snapshot()
            if jpeg != b"old":
                self.assertEqual(int(jpeg), health["lastPredictionCount"])
        thread.join()
        self.assertEqual(old, b"old")

    def test_default_web_origins_allowed_and_filesystem_origins_rejected(self):
        with patch.dict(os.environ, {}, clear=True):
            host, port, _, origins = feed.feed_configuration()
        self.assertEqual((host, port), ("127.0.0.1", 5001))
        self.assertNotIn("*", origins)
        self.state.publish(self.jpeg, 0)
        for origin in ("http://127.0.0.1:8000", "http://localhost:8000"):
            for path in ("/health", "/latest-segmentation.jpg"):
                code, headers, _ = self.request(path, origin=origin, origins=origins)
                self.assertEqual(code, 200)
                self.assertEqual(headers["Access-Control-Allow-Origin"], origin)
        for origin in ("null", "file://", "http://untrusted.invalid:8000"):
            code, headers, _ = self.request("/health", origin=origin, origins=origins)
            self.assertEqual(code, 403)
            self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_zero_predictions_preserve_exact_jpeg(self):
        result, count = feed.processed_jpeg(self.jpeg, [])
        self.assertIs(result, self.jpeg)
        self.assertEqual(count, 0)

    def test_segmented_publication_reuses_renderer(self):
        row = {"class": 0, "name": "Plastic", "confidence": 0.8,
               "box": {"x1": 30, "y1": 30, "x2": 80, "y2": 90},
               "segments": {"x": [30, 80, 50], "y": [30, 30, 90]}}
        original = bytes(self.jpeg)
        with patch.object(feed, "capture_one_frame", return_value=(self.jpeg, 200, 100)) as capture, \
                patch.object(feed, "predict", return_value=([row, {"box": {}}], 1)) as predict, \
                patch.object(feed, "render_predictions", wraps=feed.render_predictions) as render:
            feed.sample_cycle(self.state, "PRIVATE", "PRIVATE", "PRIVATE", None)
        capture.assert_called_once()
        predict.assert_called_once()
        self.assertIs(predict.call_args.args[2], self.jpeg)
        render.assert_called_once()
        latest, status = self.state.snapshot()
        self.assertEqual(status["lastPredictionCount"], 1)
        self.assertNotEqual(latest, original)
        self.assertEqual(self.jpeg, original)

    def test_configuration_defaults_and_validation(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(feed.feed_configuration()[:3], ("127.0.0.1", 5001, 2))
        for value in ("0", "nan", "inf", "PRIVATE", "86401"):
            with patch.dict(os.environ, {"SEGMENTATION_INTERVAL_SECONDS": value}, clear=True):
                with self.assertRaises(ValueError) as error:
                    feed.feed_configuration()
                self.assertNotIn("PRIVATE", str(error.exception))
        with patch.dict(os.environ, {"SEGMENTATION_ALLOWED_ORIGINS": "*"}, clear=True):
            with self.assertRaises(ValueError):
                feed.feed_configuration()

    def test_failure_recovery_sequential_and_interval(self):
        stop = Mock()
        stop.is_set.side_effect = [False, False, True]
        with patch.object(feed, "sample_cycle", side_effect=[RuntimeError("PRIVATE"), None]) as cycle, \
                patch.object(feed.time, "monotonic", side_effect=[0, 1, 2, 5]), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            feed.sampling_loop(self.state, 2, stop, ("PRIVATE",) * 3, None)
        self.assertEqual(cycle.call_count, 2)
        self.assertEqual([call.args[0] for call in stop.wait.call_args_list], [1, 0])
        self.assertNotIn("PRIVATE", output.getvalue())

    def test_ctrl_c_closes_http_service(self):
        server, thread = Mock(), Mock()
        with patch.object(feed, "configuration", return_value=("PRIVATE",) * 3), \
                patch.object(feed, "stream_configuration", return_value=0), \
                patch.object(feed, "feed_configuration", return_value=("127.0.0.1", 5001, 2, ())), \
                patch.object(feed, "ThreadingHTTPServer", return_value=server), \
                patch.object(feed.threading, "Thread", return_value=thread), \
                patch.object(feed, "sampling_loop", side_effect=KeyboardInterrupt), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(feed.main(), 0)
        server.shutdown.assert_called_once()
        server.server_close.assert_called_once()
        thread.join.assert_called_once()
        self.assertNotIn("PRIVATE", output.getvalue())

    def test_startup_identity_configuration_and_missing_warning(self):
        for configured in (None, "", "  ", " camera-document-1 "):
            environment = {} if configured is None else {"SEGMENTATION_CAMERA_DOC_ID": configured}
            captured = []
            def capture_state(state, *args):
                captured.append(state)
                raise KeyboardInterrupt
            with patch.dict(os.environ, environment, clear=True), \
                    patch.object(feed, "stream_configuration", return_value=0), \
                    patch.object(feed, "configuration", return_value=("PRIVATE",) * 3), \
                    patch.object(feed, "feed_configuration", return_value=("127.0.0.1", 5001, 2, ())), \
                    patch.object(feed, "ThreadingHTTPServer", return_value=Mock()), \
                    patch.object(feed.threading, "Thread", return_value=Mock()), \
                    patch.object(feed, "sampling_loop", side_effect=capture_state), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(feed.main(), 0)
            self.state = captured[0]
            expected = (configured or "").strip()
            health = json.loads(self.request("/health")[2])
            self.assertEqual(health["cameraDocId"], expected)
            self.assertNotIn("PRIVATE", json.dumps(health) + output.getvalue())
            self.assertEqual("Camera document ID is not configured" in output.getvalue(), not bool(expected))


if __name__ == "__main__":
    unittest.main()

# RiverSight detection bridge: YOLOv8n-seg cloud inference

Linux production preparation, startup, ingress requirements and health checks:
see [DEPLOYMENT.md](DEPLOYMENT.md). No deployment has been performed.
Production Firebase authentication and per-camera grants are now mandatory;
see [SECURITY.md](SECURITY.md) before changing runtime configuration or exposure.

## Local near-real-time segmentation feed (development only)

Use **two terminals**, both from the repository root. In Terminal 1 serve the
website over HTTP (port 8000):

```powershell
python -m http.server 8000 --bind 127.0.0.1
```

Or use `./scripts/start-local-web.ps1`, which resolves the root automatically.
If PowerShell's execution policy blocks the helper, use the direct Python command
from the repository root instead; do not change the policy for this task.
Open `http://127.0.0.1:8000/lib/monitoring/Waste-Management.html` and sign in as
usual. Do not open the HTML using `file://`: its untrusted origin is intentionally
rejected by the bridge, resulting in HTTP 403. A developer-console warning points
to the HTTP URL. Both port-8000 loopback origins are already allowed by default.

In Terminal 2 start the bridge (port 5001), using your existing private settings:

```powershell
.\backend\detection-bridge\.venv\Scripts\python.exe backend/detection-bridge/segmentation_feed.py
```

Architecture: one persistent Hikvision RTSP capture -> shared latest raw JPEG ->
local MJPEG stream, with a separate sequential scheduler sending one immutable
JPEG to Ultralytics Cloud YOLOv8n-seg at the existing controlled interval. The
exact evidence renderer annotates that inference JPEG separately. One local
optical-flow worker aligns delayed results and propagates their locations onto
current frames. All viewers consume the same shared latest output in **one
primary Waste Detection camera view**. No inference/tracker is created per viewer.
Streaming starts automatically when the selected camera matches the bridge and
capture/inference are healthy and fresh. There is no Live / AI toggle.
RTSP.ME remains the automatic fallback within that same display; it never receives
segmentation overlays. Live Monitoring and Admin System Monitoring remain normal
RTSP.ME camera views and are unchanged.

Defaults (camera identity must be configured for frontend AI matching):

```dotenv
SEGMENTATION_INTERVAL_SECONDS=2
SEGMENTATION_STREAM_FPS=10
SEGMENTATION_TRACKING_ENABLED=true
SEGMENTATION_TRACK_MAX_AGE_SECONDS=3.0
SEGMENTATION_FEED_HOST=127.0.0.1
SEGMENTATION_FEED_PORT=5001
SEGMENTATION_CAMERA_DOC_ID=
SEGMENTATION_ALLOWED_ORIGINS=http://127.0.0.1:5500,http://localhost:5500,http://127.0.0.1:8000,http://localhost:8000
```

**Camera association:** set the non-secret `SEGMENTATION_CAMERA_DOC_ID` to the
actual Firestore `camera_feeds` document ID of the physical camera configured in
the bridge (not its `camId` display label). Verify the association yourself; the
bridge cannot infer it from RTSP. Accepted IDs contain letters, digits, underscores
or hyphens, up to 128 characters. Restart the bridge after setting it. Your private
`.env` is not edited by this change. Blank/mismatched identity deliberately keeps
the selected camera's live fallback with “AI processing is not active for this
camera”; another camera's AI imagery is never substituted.

The browser preserves the Firestore selector and compares its selected document
ID exactly with `/health.cameraDocId`. The stream URL includes the selected public
document ID, and the server rejects a different ID (HTTP 409), including if the
bridge restarted between health and image requests. Snapshot mode also checks
the JPEG's `X-Camera-Doc-Id` header. Changing camera immediately disconnects the
old image/stream and cancels the previous health poll.

### Live motion and honest AI results

`SEGMENTATION_STREAM_FPS` defaults to **10**, accepts 1-15, and controls local JPEG
encoding/output only. Camera frames are read continuously to drain the input;
excess frames are skipped before JPEG encoding. Actual FPS depends on camera,
network and laptop CPU. It is a target, not a measured guarantee.
**Video FPS is not YOLO inference FPS.** `SEGMENTATION_INTERVAL_SECONDS` stays at
2 seconds by default (at most about 0.5 cloud requests/second), with one request
at a time; a slow request delays the next cycle without an accumulating queue.

The primary stream always uses the latest captured JPEG or an annotated rendering
of **that same frame**. It never substitutes an older inference frame. If tracking
falls behind capture, viewers receive current raw motion rather than an older
tracked image. The former 0.75-second result replay has been removed.

YOLO remains authoritative for class, segmentation shape and confidence. Local
tracking only estimates translation; it performs no classification or detection.
Tracked overlays are a monitoring visualization, not fresh model evidence.
The live banner reads `TRACKED ESTIMATE | labels: last YOLO confidence`.
`/latest-segmentation.jpg` still contains the exact uploaded inference image with
the exact validated YOLO result, and never receives tracker geometry or this banner.

### Latency instrumentation and tracking limits

Each successful `predict` call records capture, request-start and response-return
UTC timestamps, plus monotonic round-trip duration and source-frame age on return.
Round-trip duration includes response validation in the existing predict function;
it is not the model's server-side execution time. Snapshot-only mode timestamps
capture completion in the parent; streaming mode uses the capture-worker timestamp.
Health exposes `lastInferenceCapturedAt`, `lastCloudRequestAt`,
`lastCloudResponseAt`, `latestInferenceLatencyMs`, `averageInferenceLatencyMs`, and
`inferenceFrameAgeMs`. The average retains only the latest **60 successful calls**;
there is no latency log/history on disk. Values start as null until a success.

Real-camera/cloud latency has **not** been measured by these offline tests.
The 3-second maximum propagation age is a provisional conservative default, not a
latency-tuned claim. Before changing cadence, inspect health over several normal
cycles. Reuse `SEGMENTATION_INTERVAL_SECONDS` (default 2, existing accepted range
1-86400); no duplicate inference-interval variable was added. Slow calls delay the
next request; no request queue or overlap is created, and the next cycle takes the
newest available raw frame.

`SEGMENTATION_TRACK_MAX_AGE_SECONDS` accepts 0.5-10 seconds and is measured from
the **YOLO source frame**, including cloud latency. Results older than that cannot
seed live overlays. Latency near/above the limit therefore produces short-lived
or absent overlays while video remains current. Increasing the limit permits more
drift; evaluate using the manual test below, not just appearance.

### Classical tracking and delayed-result alignment

The installed OpenCV 4.14.0 build was checked: `goodFeaturesToTrack` and
`calcOpticalFlowPyrLK` are available, MIL exists, and CSRT/KCF are absent. This
implementation uses Shi-Tomasi corners plus pyramidal Lucas-Kanade optical flow;
it needs neither contrib trackers nor any new package/neural model.

Each object gets up to 40 features from inside its polygon (or bbox fallback),
at most 12 highest-confidence candidate objects. Forward/backward consistency,
photometric error and displacement consensus reject unreliable points. At least
six points and 60% agreement are required. Median displacement translates the
last YOLO polygon/bbox; no scale, rotation or arbitrary shape is invented. Polygon
coordinates are clamped, and largely off-screen/collapsed regions are dropped.
Excessive motion, tracking gaps, texture loss and age expiry remove annotations.
Textureless objects, occlusion, glare, water motion, rotation and deformation can
cause overlays to disappear; this is safer than retaining unsupported masks.

A delayed result is initialized on its **own exact source image** and advanced
through a bounded history of reduced grayscale frames before association with
current tracks. Missing history, excessive gaps or failed flow rejects alignment;
old coordinates are never simply initialized on the newest video frame. History
uses at most `ceil(maxAge * 15) + 2` frames, each at most 640 pixels on its longest
edge, and also expires by age (47-frame cap at the default, 152 at the maximum).
This is a bounded in-memory alignment window, not a video recording or work queue.

Fresh supported observations reinitialize matching tracks using same class,
IoU >= 0.3 and center distance <= half the previous box diagonal. YOLO confidence
is copied unchanged; optical-flow quality is internal and never replaces it.
Unmatched tracks receive at most 0.5 seconds of grace, still subject to the original
source-age limit and successful flow. Further misses do not extend that grace.
An authoritative overlapping replacement removes the unsupported old label.
Zero predictions apply this short grace policy but never stop the live stream.

One visualization thread owns all tracks/history. Capture and inference exchange
only a latest-frame slot and a latest-result mailbox; no unbounded queue exists.
Expensive tracking/rendering/cloud requests and HTTP writes run outside shared
state locks. Reconnect generations invalidate old corrections, and publication
checks the source timestamp so a slow render cannot move the video backward.

### Shared capture, recovery and snapshot rollback

One supervised child process owns one persistent OpenCV RTSP connection. Native
camera diagnostics are discarded; credentials are passed privately through its
environment, never command-line arguments. Cloud credentials are removed from
that child's environment. A binary pipe carries size-bounded JPEGs (20 MiB max)
and capture timestamps to a reader. A supervisor kills an unresponsive capture
after 15 seconds without a recent frame and reconnects after a 2-second delay.
Open/read timeouts remain 10 seconds. No separate FFmpeg executable is added;
OpenCV uses the same existing capture backend.

Only the latest raw JPEG, latest exact evidence JPEG, latest current tracked JPEG,
one pending correction, bounded grayscale alignment history, 12 tracks and 60
latency samples are retained, plus transient bounded buffers. There is no unbounded
queue or runtime disk writing. Encoding is shared, not repeated for each viewer.
Up to eight simultaneous MJPEG clients are admitted; additional clients receive
503. Each client has a 5-second socket timeout; broken pipes and resets release
its slot without stopping capture/inference. Slow viewers skip intermediate
frames. Ctrl+C stops the shared worker and HTTP service.

To disable tracking, manually set `SEGMENTATION_TRACKING_ENABLED=false` and restart.
Continuous current raw MJPEG remains active; there is no result replay. Exact
YOLO evidence remains available at the snapshot endpoint.

For snapshot rollback, manually set `SEGMENTATION_STREAM_FPS=0` in your private environment
and restart the bridge. This restores the existing short-lived one-frame capture
and sequential snapshot display, without changes to the request/parser/renderer.
No private `.env` is edited automatically. The snapshot endpoint works in both
modes and can always be opened directly for debugging. A failed enabled stream
uses RTSP.ME automatically; it does not silently switch to a snapshot slideshow.

### Find and configure the camera identity

The selector value is `data.camId || cameraDoc.id`; its visible label includes
`data.title || data.camId`. AI matching instead uses `cameraDoc.id`, stored in
the camera container's `data-camera-doc-id`. Admin creation uses Firestore
`addDoc`, so a display label such as CAMERA1 does not establish the document ID.
The actual CAMERA1 document ID, stored camId and title are not available in static
repository data and must be verified against your camera records.

On Waste Detection, select the physical bridge camera, then run this in browser
DevTools Console after the camera list loads (it reads only public identity):

```javascript
document.querySelector('[data-camera-feed-frame]').dataset.cameraDocId
```

Alternatively open Firebase Console > Firestore Database > Data > `camera_feeds`,
find the record whose `camId` is CAMERA1, verify its title and physical-camera
association, and copy the **document ID**, not the camId field. If the browser
expression returns blank, wait for camera records to load or use Firebase Console.
Manually set this existing variable in `backend/detection-bridge/.env`:

```dotenv
SEGMENTATION_CAMERA_DOC_ID=<copied Firestore document ID>
```

Do not add a duplicate `CAMERA_DOC_ID` variable. `CAMERA_RTSP_URL` tells the
backend how to reach the physical camera; `SEGMENTATION_CAMERA_DOC_ID` associates
that physical camera with its RiverSight record. Stop and restart the bridge:
configuration is loaded at startup. `/health.cameraDocId` should then equal the
copied ID; the JPEG carries the same ID in `X-Camera-Doc-Id`. Missing configuration
returns an empty identity and prints a sanitized startup warning without values.
Fresh, healthy matching frames (including zero predictions) restore AI display
automatically; selecting a different camera uses its live fallback.

The interval is finite, 1–86400 seconds, measured start-to-start. One sequential
request runs at a time; slow cycles finish before the next begins. Failed cycles
retain the last complete image and try again at the normal interval. Ctrl+C stops
capture/inference and shuts down the HTTP service. Cloud latency affects AI result
cadence independently of live video updates.

There is no new dependency: Python's standard-library HTTP server runs alongside
the main sequential inference loop. A lock atomically swaps an immutable JPEG and
its matching metadata; HTTP readers keep a complete snapshot even when it changes.
All frame/history buffers are bounded, and no runtime JPEGs accumulate on disk.
Restarting the service clears the snapshot and returns HTTP 503 until a new
successful inference finishes.
`runtime/` is ignored as well, should local runtime files be introduced later.
Zero valid predictions publish the original unannotated inference JPEG.

- `GET http://127.0.0.1:5001/health`: safe status, model architecture, availability,
  last successful inference timestamp, rendered prediction count and public
  `cameraDocId`. A failure
  changes status to `degraded`; the prior image remains available.
  Streaming mode adds `streamEnabled`, `streamAvailable`, `captureActive`,
  `lastFrameAt`, `inferenceIntervalSeconds`, and `streamTargetFps`. Capture is active
  only with a raw frame less than 3 seconds old; streaming requires that plus a
  successful inference result less than 15 seconds old. No URLs or secrets appear.
  When the browser supplies its non-secret `streamId`, health also includes
  `streamClientActive`. Only admitted connections are registered (at most eight),
  and disconnects remove them. This detects a closed viewer stream even when the
  browser emits no image error after the first multipart frame.
  Tracking adds `trackingEnabled`, `activeTrackCount`, `lastTrackingUpdateAt`, and
  `trackMaxAgeSeconds`, alongside the safe timing fields described above.
- `GET http://127.0.0.1:5001/latest-segmentation.jpg`: latest complete JPEG or HTTP
  503 until the first success. Includes no-store/no-cache headers plus timestamp
  feed-status and camera-document-ID headers. No file system directory is exposed.
- `GET http://127.0.0.1:5001/segmentation-stream.mjpg`: continuous
  `multipart/x-mixed-replace; boundary=frame`, with JPEG parts and per-part lengths.
  Returns 503 while unavailable and closes an existing stream when unhealthy.
  Uses the same restricted origin/Host policy as the other endpoints.

The frontend polls health sequentially every 1.5 seconds after the last request
finishes, with an 8-second request timeout. It opens one CORS-enabled MJPEG image
connection and leaves it open across successful health polls. The first image
must load within 8 seconds; errors fall back and the next health poll retries.
Status reads `YOLOv8n-seg + Tracking` and explains estimated positions/last YOLO
confidence; the camera label reads `AI LIVE + TRACKING`. With tracking disabled,
the label is `AI LIVE STREAM`. In snapshot-only mode (or with an older
bridge), the existing health-then-JPEG polling remains supported.
Hiding/navigating away disconnects the image and pauses polling.
Failure, degraded status, missing timestamps or frames older than **15 seconds**
show the selected camera's live fallback and a small unavailable status. An expiry
timer prevents an old frame from remaining “active” during a stalled request.
Fresh matching frames automatically restore AI display with no page reload.
Zero detections remain a valid active AI frame, not a fallback condition.
While waiting for the first frame, the normal live feed remains visible.
If you change the service port/host, update the non-secret endpoint constant in
`js/monitoring/segmentation-feed.js` to match.

### Development origins and deployment limits

Repository `firebase.json` configures Firestore only: no Hosting/emulator origin
is established. Defaults above explicitly allow VS Code Live Server on port 5500
and a local static server on port 8000. For example, serve the repository with
`python -m http.server 8000 --bind 127.0.0.1` and open
`http://127.0.0.1:8000/lib/monitoring/Waste-Management.html` (normal Firebase login
requirements still apply). Do not open it using `file://`.

For another emulator/Hosting origin, explicitly add its exact scheme, hostname
and port to `SEGMENTATION_ALLOWED_ORIGINS`, with no trailing slash or wildcard.
Read `location.origin` in the Waste Detection browser console to obtain the
actual origin; the repository does not establish the currently running origin.
Append that exact origin to the comma-separated allowlist only if missing, then
restart the bridge. No additional origins have been added by this identity fix.
Opening `/health` directly does not verify cross-origin access from the page.
In DevTools Network, check the page's health and JPEG requests for HTTP 200 and
an `Access-Control-Allow-Origin` matching `location.origin`. An empty identity
causes the camera-mismatch status; the generic unavailable status can also mean
blocked requests, stale inference or an unavailable frame.
Disallowed origins/Host headers receive 403. Preflight permits local-network
access only for allowed origins. Browsers may still block an HTTPS-hosted page's
HTTP/local-network fetch or require local-network permission; CORS does not
override those browser policies. Prefer an allowed local HTTP origin for this test.

**127.0.0.1 refers to the browser's own computer.** The bridge and browser must run
on the same computer with the default setup. This unauthenticated loopback service
is for development, not production. Do not expose it by changing the bind address
without access controls. Future hosting needs an accessible edge/backend service,
HTTPS, authentication/authorization and deliberate network/CORS configuration.
Production preparation is documented in DEPLOYMENT.md; access controls at the
ingress are still required before deployment. Local processes can access the loopback feed.

No Firestore frame transport or detection persistence is implemented. Existing
one-frame, continuous-terminal and dataset-collection commands remain available.

Offline verification commands (no camera or cloud endpoint):

```powershell
.\backend\detection-bridge\.venv\Scripts\python.exe -B -m unittest discover -s backend/detection-bridge -p "test_*.py"
node --test backend/detection-bridge/test_segmentation_frontend.cjs
```

The HTTP tests execute handlers against in-memory streams, and frontend tests use
mock DOM/fetch objects. They do not prove browser-specific local-network permission
behavior; verify that with your browser and chosen development origin.

### Manual real-camera tracking verification (not run automatically)

1. From the repository root, start Terminal 1 with
   `python -m http.server 8000 --bind 127.0.0.1`.
2. In Terminal 2, start
   `.\backend\detection-bridge\.venv\Scripts\python.exe backend/detection-bridge/segmentation_feed.py`.
3. Open `http://127.0.0.1:8000/lib/monitoring/Waste-Management.html`, sign in and
   select the configured physical camera. Confirm `AI LIVE + TRACKING`.
4. Inspect `http://127.0.0.1:5001/health` over several successful cycles. Record
   the latest/average latency and inference-frame age before tuning any setting.
5. Hold a clearly detectable waste object stationary in view until YOLO finds it.
   Slowly move it left/right: the estimated annotation should follow the object.
6. Move it quickly: unreliable annotations should disappear rather than leave a
   ghost mask. Remove it and verify disappearance by the age limit or earlier
   flow failure/zero-result grace. Zero predictions should not stop the video.
7. Throughout, verify current motion never jumps back to an old inference frame.
8. Open `http://127.0.0.1:5001/latest-segmentation.jpg` separately. Confirm it shows
   the exact earlier inference evidence, independently of the moving live overlay.
9. Select another camera, then return: check live fallback and automatic recovery.
   Optionally stop/restart the bridge and test the same recovery.
10. If tracking is unreliable, manually set `SEGMENTATION_TRACKING_ENABLED=false`
    and restart: current MJPEG should remain smooth without masks. Set stream FPS
    to 0 only when deliberately testing the preserved snapshot-only mode.

The current final model architecture is **YOLOv8n-seg instance segmentation**.
The private endpoint selects the deployed model; the bridge does not load weights
or verify deployment identity. Check the deployment UI before the real-camera test.

```text
Hikvision RTSP -> Python bridge -> exact JPEG frame
  -> Ultralytics Cloud YOLOv8n-seg -> segmentation prediction
  -> exact-frame evidence rendering
```

Only capture, image encoding and visualization run locally. No local YOLO,
PyTorch, training, or Firestore detection persistence is included.

### One-frame test

```powershell
.\backend\detection-bridge\.venv\Scripts\python.exe backend/detection-bridge/one_frame.py --json
```

### Save original inference frame

```powershell
.\backend\detection-bridge\.venv\Scripts\python.exe backend/detection-bridge/one_frame.py --json --save-frame
```

### Save segmentation evidence and original frame

```powershell
.\backend\detection-bridge\.venv\Scripts\python.exe backend/detection-bridge/one_frame.py --json --save-frame --save-evidence
```

### Continuous test

```powershell
.\backend\detection-bridge\.venv\Scripts\python.exe backend/detection-bridge/continuous_detection.py
```

`debug/` contains unannotated inference JPEGs; `evidence/` contains annotated
copies. Neither should be committed. `.env` contains secrets and must never be
committed. `.venv/`, `__pycache__/`, `*.pyc` and `dataset-captures/` are also ignored.

## Synchronized detection evidence

```powershell
.\backend\detection-bridge\.venv\Scripts\python.exe backend/detection-bridge/one_frame.py --json --save-evidence
```

`--save-evidence` decodes the exact JPEG bytes uploaded to cloud inference, draws
returned segmentation polygons and labels on a separate copy, and saves a quality-95 JPEG under
`backend/detection-bridge/evidence/`. It never captures a second frame or modifies
the uploaded JPEG. Labels show class names and display-only confidence percentages
(for example `Plastic 78.1%`). Valid polygons receive a 35%-opacity fill and a
visible outline. A missing/invalid polygon falls back to the validated bounding
box. Segmentation is never fabricated from a box.
This avoids synchronization problems with the delayed RTSP.ME browser stream;
there are no website or live-video overlays.

The response parser skips invalid individual detections without losing valid
neighbors. Missing/invalid polygons retain the valid detection for bbox fallback.
An invalid overall response envelope still fails safely. The renderer also
validates coordinates against the decoded image's actual dimensions, clamps
partially visible boxes, and skips malformed, nonfinite, reversed, degenerate or
fully off-image boxes. Coordinates are treated as original-image pixels, following
the existing API contract; no resize or coordinate-space conversion is applied.
Zero predictions (or no drawable predictions) produce no evidence image.

Evidence filenames contain a timestamp with microseconds and a random identifier,
and exclusive creation prevents overwriting. The directory is created when needed
and ignored by Git. Only validated class labels and scores are drawn, never
configuration, credentials or endpoint metadata.

`--save-frame` and `--save-evidence` are independent and work together:

```powershell
.\backend\detection-bridge\.venv\Scripts\python.exe backend/detection-bridge/one_frame.py --json --save-frame --save-evidence
```

The original debug JPEG remains unannotated. Without `--save-evidence`, existing
behavior is unchanged. Continuous detection and dataset collection do not save
annotated evidence. YOLO inference still runs exclusively in Ultralytics Cloud;
drawing rectangles/text locally is visualization, **not local YOLO inference**.

Offline synthetic-image tests:

```powershell
.\backend\detection-bridge\.venv\Scripts\python.exe -B -m unittest discover -s backend/detection-bridge -p "test_evidence_renderer.py" -v
```

## Camera dataset collector

Run from the repository root with the existing bridge environment:

```powershell
.\backend\detection-bridge\.venv\Scripts\python.exe backend/detection-bridge/collect_dataset.py
```

Press **Enter** to connect, capture one original-size frame, disconnect and save
a quality-95 JPEG. Each Enter press makes only one capture attempt; failures
return to the prompt without automatic retries. **q**, **Ctrl+C**, or end of
input stops cleanly. The displayed count is successful saves in this session.
No capture occurs until Enter is pressed; other commands do not capture.

Images go to `backend/detection-bridge/dataset-captures/images/`, independent of
the current working directory. Directories are created automatically. Filenames
contain a timestamp with microseconds plus a random identifier; exclusive file
creation prevents overwrites. Images retain the original captured dimensions:
no resizing, cropping, overlays, labels or intentional color changes. JPEG is
lossy; quality 95 preserves detail without excessive compression.

The collector only uses `CAMERA_RTSP_URL`, from the process environment or its
single-line assignment in the existing private `.env`. Quoted values and an
optional `export` prefix are supported; interpolation is disabled. Cloud keys
are not parsed, loaded, required or passed to the capture worker. Never put
credentials in commands or shared logs. Native camera diagnostics are contained
in a short-lived capture process and never printed.

`dataset-captures/` is intentionally excluded from Git; collector source remains
trackable. These images are for **later manual annotation and future model
training**. This utility performs **no YOLO inference, cloud/API calls, training,
annotation, or Firestore operations**. Existing inference tools are unchanged.

Collect variation in object position, distance, orientation, lighting, partial
occlusion, different waste objects, multiple objects, and empty/background scenes.
Position objects safely and press Enter for each desired sample.

Offline collector tests (fake camera, synthetic images, no private `.env`):

```powershell
.\backend\detection-bridge\.venv\Scripts\python.exe -B -m unittest discover -s backend/detection-bridge -p "test_collect_dataset.py" -v
```

This isolated command captures exactly one frame directly from the camera RTSP
stream, disconnects, encodes a JPEG in memory, posts it to Ultralytics Cloud and
exits. `one_frame.py` remains the manual diagnostic tool. No image is saved by
default; its optional `--save-frame` flag saves the exact inference JPEG under
the Git-ignored `debug/` directory and works together with `--json`.
`continuous_detection.py` adds sequential periodic sampling. Neither entry point
includes Firestore access, frontend changes, local models, training or local inference.
OpenCV decodes video, encodes JPEG and draws returned geometry. A short-lived subprocess contains
native camera diagnostics so credential-bearing messages never reach the terminal.

## Windows PowerShell setup

Run from the repository root (Python 3.10+ required):

```powershell
python -m venv backend/detection-bridge/.venv
.\backend\detection-bridge\.venv\Scripts\python.exe -m pip install -r backend/detection-bridge/requirements.txt
Copy-Item backend/detection-bridge/.env.example backend/detection-bridge/.env
```

Copy the example only on first setup; do not overwrite an existing `.env`.
Edit `backend/detection-bridge/.env` locally, outside terminal history:

```dotenv
CAMERA_RTSP_URL=
ULTRALYTICS_ENDPOINT=
ULTRALYTICS_API_KEY=
DETECTION_INTERVAL_SECONDS=5
```

- `CAMERA_RTSP_URL`: complete direct RTSP playback URL, including RTSP.ME public playback,
  or a LAN camera URL with credentials when needed. Keep any playback push key private.
  Percent-encode reserved characters in username/password. Quote the entire value
  in the `.env` file if necessary. No RTSP.ME iframe URL.
- `ULTRALYTICS_ENDPOINT`: deployment HTTPS base URL. An existing `/predict`
  suffix is also accepted and will not be duplicated. No embedded credentials,
  query string or fragment.
- `ULTRALYTICS_API_KEY`: deployment bearer token, without the `Bearer ` prefix.

Existing process environment variables override `.env`. Dotenv interpolation is
disabled to preserve literal dollar signs in secrets. Never paste secrets into
source code, commands, screenshots or shared logs. The root and bridge ignore
rules exclude `.env`; the bridge also ignores its virtual environment/cache.
Keep this directory out of any public static hosting/upload configuration.

## Run once

```powershell
.\backend\detection-bridge\.venv\Scripts\python.exe backend/detection-bridge/one_frame.py --json
```

Omit `--json` for only the human-readable summary. Each invocation performs one
camera read and at most one HTTPS POST. A failed read exits instead of retrying.
Camera open/read timeouts are 10 seconds each, with a 30-second capture-process
limit. HTTPS connect/read timeouts are 10/60 seconds (read timeout is socket
inactivity, not a total wall-clock deadline). Redirects, automatic retries and
ambient proxy/.netrc settings are disabled; HTTPS certificate checks remain on.

The multipart request sends `file=frame.jpg`, `conf=0.25`, `iou=0.70`, `imgsz=640`
and the configured bearer token. No local Ultralytics/PyTorch packages are used.

Expected response: `images` containing exactly one image with `shape: [height,
width]`, `results: [{class, name, confidence, box: {x1,y1,x2,y2}}]` and optional
`speed.inference` in milliseconds. Coordinates use the default pixel space.
Instance segmentation uses `segments: {x: [...], y: [...]}` on each result,
as documented by Ultralytics `Results.summary()`. The existing request leaves
`normalize` at its default false: boxes and polygons use original-image **pixels**.
The parser does not guess normalized coordinates or interpret arbitrary dense/RLE
mask formats. Unsupported masks fall back to valid boxes. The private deployment's
actual response has not been queried during development; verify it in your test.

Each polygon requires matching finite x/y arrays, 3 distinct points and nonzero
area after boundary clamping. Consecutive duplicate vertices and a repeated closing
vertex are removed. Arrays over 20,000 points degrade to bbox fallback to bound
processing. No polygon is fabricated, and rendering never uses a truncated preview.
Malformed individual detections are skipped; malformed polygons preserve valid
boxes. If all detections are rejected, no evidence is produced.

Class names are no longer pinned to the old eight-class detection model. IDs/names
are checked against `metadata.classNames` when supplied (list or ID-keyed map).
Without that metadata, bounded IDs and safe names from each result are accepted.
Names allow up to 64 ASCII letters/digits, spaces, parentheses and hyphens; control
characters, URLs and credential matches are rejected. Check your final dataset
class ordering against deployment metadata; no class remapping is invented.

Normal logs show segmentation point counts, not arrays. `--json` retains pixel
polygons up to 64 points; larger polygons show `pointCount`, `coordinates: pixels`
and `pointsOmitted: true`. Full validated geometry remains available in memory
for evidence. Server messages, filenames, headers and unrelated metadata are omitted.
References: https://docs.ultralytics.com/platform/deploy/inference/#response
and https://docs.ultralytics.com/reference/engine/results/#ultralytics.engine.results.Results.summary

Illustrative output only (not a measured result):

```text
Camera connection succeeded; one frame captured and camera disconnected.
Frame: 1920 x 1080; JPEG: 184200 bytes (memory only)
HTTP status: 200
HTTPS request duration: 1.20 s
Cloud inference duration: 12.50 ms
Predictions: 1
  bottle (class 0), confidence 0.9200, box {'x1': 100, 'y1': 50, 'x2': 300, 'y2': 400}
```

An empty `results` list is a successful request with zero predictions. Missing
configuration, dependency/camera/frame/JPEG failures, timeout/network errors,
HTTP failures, invalid JSON and invalid response envelopes exit with code 1 and a safe
message. No raw exception text or response body is logged. If a corporate proxy
or custom CA is mandatory, this minimal command needs explicit trusted network
configuration before use; do not disable TLS verification.

Confirm in the Ultralytics deployment UI that this endpoint serves
your final YOLOv8n-seg model. Matching class labels alone cannot prove model identity.
Phase 1 is verified only after you run it against your camera and deployment and
inspect the real result. Development checks with mocks do not establish that.

## Phase 2: continuous sampling

From the repository root, using the existing environment and dependencies:

```powershell
.\backend\detection-bridge\.venv\Scripts\python.exe backend/detection-bridge/continuous_detection.py
```

Stop with **Ctrl+C**. The command prints `Monitoring stopped.` without a traceback.
No new dependencies or changes to your existing private `.env` are necessary.
Optionally set `DETECTION_INTERVAL_SECONDS` there; if absent, it defaults to 5.
Accepted values are finite numbers from 1 to 86400 seconds, including fractions.
Empty, nonnumeric, nonfinite and out-of-range values fail safely at startup.
Configuration is read once on startup; restart to apply changes.

The interval is the minimum time between cycle starts, measured using a monotonic
clock. For a 5-second interval, a 2-second cycle waits 3 seconds; an 8-second
cycle starts the next cycle after it finishes. There is no catch-up queue.
Each cycle makes one capture attempt, releases the camera, and makes at most one
HTTPS request. All work is sequential, so inference requests never overlap.
The existing short-lived capture subprocess is reused for native-log isolation;
no multiprocessing pool, parallel capture or background inference is added.

Temporary capture/request/response failures are logged safely, then the next
cycle follows the same timing rule. There are no retries within a cycle, including
for authorization failures. Stop the monitor to correct persistent configuration
or access errors. Request duration is printed on successful and failed requests;
HTTP status is available only when a response arrives. Raw errors/responses and
credentials are never printed. Only validated class, confidence, box fields and
segmentation point counts are displayed. Zero predictions is a valid result.

Continuous mode keeps JPEGs in memory and never calls the debug-saving function.
Use `one_frame.py --save-frame --json` for manual evidence capture instead.
Inference takes place in **Ultralytics Cloud**, not on the laptop. Firestore
persistence, incidents, reports, notifications, tracking and duplicate suppression
are intentionally not implemented in this phase. Repeated objects may therefore
appear in several cycles. Existing request parameters and security protections
are inherited unchanged from `one_frame.py`.

## Offline tests

```powershell
.\backend\detection-bridge\.venv\Scripts\python.exe -B -m unittest discover -s backend/detection-bridge -p "test_*.py" -v
```

Tests use fake capture, HTTP responses and clocks. They never load the private
`.env`, open the real camera or call the endpoint. Synthetic-image tests use the
existing OpenCV/NumPy dependencies; no ML package is installed or needed.

# Linux production preparation (not deployed)

The existing pipeline stays Hikvision -> RTSP.ME Software Agent -> RTSP.ME
public RTSP playback -> bridge -> existing Ultralytics cloud YOLOv8n-seg endpoint
-> exact-frame evidence/current-frame optical-flow visualization -> RiverSight.
Both capture paths force RTSP-over-TCP. No model weights or local ML framework
are installed. Do not change the endpoint, model, request parameters or secrets.

Use one always-running Linux process/container per physical camera, with one
replica. Do not scale HTTP workers or replicas horizontally: each instance would
open its own capture and incur separate inference requests. No GPU is needed.
Headless OpenCV retains decoding, encoding, rendering and optical flow; this
bridge uses no GUI functions. Install only one OpenCV distribution in an environment.
Keep the existing local virtual environment intact; use a fresh production venv.

## Startup

Existing Windows development command, from repository root:

```powershell
.\backend\detection-bridge\.venv\Scripts\python.exe backend/detection-bridge/segmentation_feed.py
```

The development HTTP server now rejects non-loopback binding. Linux setup and
proposed production startup, from repository root, with runtime environment
already supplied by a secret manager or protected service environment file:

```sh
python3 -m venv backend/detection-bridge/.venv
backend/detection-bridge/.venv/bin/python -m pip install -r backend/detection-bridge/requirements.txt
backend/detection-bridge/.venv/bin/python -B backend/detection-bridge/production_server.py
```

The production entry point uses Waitress, 16 HTTP threads, at most eight MJPEG
viewers, 32 connections and a bounded output high watermark. The inference loop
remains on one separate sequential path shared by all viewers. Disconnect-aware
stream iteration releases viewer slots. Slow clients encounter backpressure;
the latest-only camera/result/tracking storage does not grow with stream duration.
Large frames still require memory for decoding and per-client output; size the
container against actual resolution and viewers. Do not configure auto reload.

SIGTERM requests shutdown, as does Ctrl+C. Existing blocking capture/cloud calls
can delay shutdown. The HTTPS read timeout is socket inactivity, not a total
request deadline: choose at least 120 seconds shutdown grace and keep a hard
supervisor termination deadline. Restart on process failure; alert on persistent
degraded health instead of continually restarting during a cloud outage.

## Environment

Process environment overrides the local `.env`; interpolation remains disabled.
Never bake `.env` or secrets into an image, source, build args or command line.
The Docker image has no `.env`. Supply values at runtime using protected secret
configuration. Restart to apply changes.

Required for production:

| Variable | Meaning |
| --- | --- |
| `CAMERA_RTSP_URL` | Private direct RTSP playback URL, including RTSP.ME push key where applicable |
| `ULTRALYTICS_ENDPOINT` | Existing deployed HTTPS endpoint; existing `/predict` suffix remains accepted |
| `ULTRALYTICS_API_KEY` | Existing bearer token, without `Bearer ` prefix |
| `SEGMENTATION_CAMERA_DOC_ID` | Verified physical camera's public Firestore document ID |
| `SEGMENTATION_ALLOWED_HOSTS` | Comma-separated exact Host authorities; include ingress hostname and internal probe host:port |
| `SEGMENTATION_ALLOWED_ORIGINS` | Comma-separated exact HTTPS frontend origins, no path/trailing slash/wildcard |

Optional configuration:

| Variable | Default / valid values |
| --- | --- |
| `SEGMENTATION_FEED_HOST` | Development `127.0.0.1`; production `0.0.0.0`; explicit IPv4 setting overrides |
| `SEGMENTATION_FEED_PORT` | Explicit setting first; production then uses `PORT`, otherwise `5001`; 1–65535 |
| `PORT` | Platform-injected production port fallback; ignored by development entry point |
| `SEGMENTATION_INTERVAL_SECONDS` | `2`; finite 1–86400 seconds |
| `SEGMENTATION_STREAM_FPS` | `10`; 1–15, or `0` for snapshot-only mode |
| `SEGMENTATION_TRACKING_ENABLED` | `true`; `true`/`false` |
| `SEGMENTATION_TRACK_MAX_AGE_SECONDS` | `3`; finite 0.5–10 seconds |
| `DETECTION_INTERVAL_SECONDS` | `5`; used only by the separate continuous_detection.py diagnostic |

Local development keeps its existing loopback Host/origin defaults and permits
an empty camera identity with the existing warning/fallback. Production startup
requires explicit hosts, HTTPS origins and camera identity. Bind address and
public Host are separate settings. Forwarded Host/Proto headers are not trusted
for allowlisting; the proxy must forward the actual allowed `Host` unchanged.

## Railway startup diagnosis

Docker starts `python -B production_server.py`, imports the bridge, then calls
`segmentation_feed.main(ProductionServer)`. It loads environment configuration,
validates feed/stream/tracking settings and identity, validates Host authorities,
checks production origins/identity, binds Waitress, starts tracking/capture/HTTP
threads and enters sequential sampling. The old generic `Feed could not start`
message came from the broad exception handler around this entire sequence.

Startup now logs fixed stage names and, on failure, a fixed diagnostic code.
No values, complete URLs, arbitrary exception text or traceback are printed:

| Stage/code | Action |
| --- | --- |
| `cloud_camera_configuration` | Missing variable names are logged; configure runtime camera URL, endpoint and key. If present, check syntax privately. The image deliberately contains no `.env`. |
| `feed_configuration / configuration_rejected` | Check numeric port/interval, IPv4 bind and exact origin syntax. Empty or literal `$PORT` strings are not valid ports. |
| `stream_configuration` / `tracking_configuration` | Check documented numeric/boolean settings. |
| `camera_identity` | Use a valid camera document ID, not a URL/title. |
| `host_allowlist` | Use exact host authorities, not URLs, paths or wildcards. |
| `http_server_initialization / missing_allowed_hosts` | Supply explicit `SEGMENTATION_ALLOWED_HOSTS`. |
| `http_server_initialization / missing_allowed_origins` | Supply explicit `SEGMENTATION_ALLOWED_ORIGINS`. |
| `http_server_initialization / missing_camera_identity` | Supply verified `SEGMENTATION_CAMERA_DOC_ID`. |
| `http_server_initialization / https_origins_required` | Replace development HTTP origins with exact HTTPS frontend origins. |
| `http_server_initialization / address_in_use` | Check port conflicts or duplicate startup processes. |
| `http_server_initialization / bind_address_unavailable` | Bind a container-local IPv4 address, normally `0.0.0.0`, not a public hostname/IP. |
| Any stage / `dependency_unavailable` | Check installed dependencies; Docker now smoke-imports OpenCV, NumPy, Requests, dotenv and Waitress during build. |
| `tracking_worker_start` / `capture_worker_start` / `http_worker_start` | Worker/thread initialization failed; check process/resource limits. |

An RTSP connection failure occurs inside the supervised capture worker after
startup and normally reconnects; a cloud request failure is handled per sampling
cycle. Neither normally produces the startup failure message. The repeated
generic message alone cannot establish the particular Railway failure. Local
tests reproduce rejection cases, but the live crash requires the new stage/code
from Railway to confirm its cause. No Railway deployment or variable changes
were performed as part of this investigation.

Production now binds `0.0.0.0` by default and honors Railway's injected `PORT`
unless `SEGMENTATION_FEED_PORT` is explicitly set. Do not copy local example
HOST/PORT settings blindly into Railway: explicit loopback still overrides the
production default. Keep the service unexposed until gateway access controls exist.

For Railway deployment health checks, deliberately add `healthcheck.railway.app`
to `SEGMENTATION_ALLOWED_HOSTS` (and an exact port-qualified authority if the
probe sends one). No automatic allowlist exception is added. Use `/health` as a
liveness probe; its 200 response does not establish camera/cloud readiness, and
Railway's deployment check is not continuous monitoring. See
[Railway bind/port guidance](https://docs.railway.com/networking/troubleshooting/application-failed-to-respond)
and [Railway health-check guidance](https://docs.railway.com/deployments/healthchecks).

## Container preparation

Build context MUST be `backend/detection-bridge`, not repository root:

```sh
docker build -t riversight-detection-bridge backend/detection-bridge
```

This is a proposed command only. The allowlist `.dockerignore` excludes all
files except the production Python modules, Dockerfile and requirements. Private
`.env`, virtualenvs, evidence, dataset captures, debug files, caches and Git
metadata cannot enter the build context. The image uses Python 3.12 slim and UID
10001. It accepts no secret build args. Container command:

```sh
python -B production_server.py
```

Supply all production variables above. Bind `0.0.0.0` only on a private container
network. Publish to `127.0.0.1:5001:5001` when the proxy runs on the same VM;
otherwise use a private service network/security group with only ingress access.
Do not publish the container port to the Internet. Use restart supervision,
memory/CPU limits, a writable bounded `/tmp` for Waitress spill buffers, and
120-second stop grace. A read-only root filesystem is suitable with that tmpfs.

## HTTPS ingress and remaining security work

Before deployment, provide TLS, authentication AND per-camera authorization at
the gateway for all three routes. CORS/Host validation is not authentication:
non-browser clients can supply arbitrary headers or omit Origin. The bridge
intentionally has no Firebase-token verification or camera-user ACL. A valid
cameraDocId is an identity check, not permission to view a camera.

Prefer a same-origin authenticated gateway path, proxying the three bridge routes
and preserving Host, Origin and query strings. Disable buffering and caching for
MJPEG, allow long-lived responses, and set a read timeout above the frame cadence
(e.g. 60 seconds). Permit GET/OPTIONS only, impose header/body limits and rate
limits, and cap concurrent streams per authorized user. Handle allowed-origin
preflight at the gateway before authentication if cross-origin access is chosen.
Do not log query strings, auth headers, RTSP URLs or bodies. Avoid putting tokens
in image URLs. Do not enable wildcard CORS. No forwarded client identity is used
by the bridge, so enforce access at the gateway and firewall direct access.

RTSP.ME's public playback push key acts as a secret but RTSP transport itself is
unencrypted. A cloud VM still depends on the local camera/Software Agent remaining
online. Permit outbound TCP to the RTSP source's configured port and HTTPS to
the existing endpoint, plus DNS. Review video privacy/retention and API spending.
Dependencies use compatible ranges; lock resolved versions/digests and scan the
image before an eventual release. No camera/cloud connectivity is proven offline.

## Health checks

`GET /health` preserves HTTP 200 and existing JSON schema, even while waiting or
degraded. It is a liveness endpoint, not an HTTP-status readiness endpoint. No
secret or RTSP URL is returned. Configure probe Host in the exact allowlist.

```sh
curl --fail --silent http://127.0.0.1:5001/health
```

For readiness in streaming mode require `status == "ok"`, `captureActive == true`,
`streamAvailable == true`, matching nonempty `cameraDocId`, and fresh inference
timestamps. Snapshot-only mode has no `captureActive`/`streamAvailable`; require
`status == "ok"`, `latestFrameAvailable == true` and fresh `lastInferenceAt`.
The current frontend freshness window is 15 seconds; slow cloud responses or
intervals beyond that trigger its existing fallback. Give initial capture/cloud
inference time to warm up. Monitor latency, frame age, outages and capacity;
do not send readiness probes through the public authenticated viewer route.

Other preserved routes: `/latest-segmentation.jpg` serves exact inference-frame
evidence; `/segmentation-stream.mjpg` serves current tracked/raw MJPEG with
`cameraDocId` and optional `streamId`. No filesystem directory is served.

## Later frontend change (not applied here)

`js/monitoring/segmentation-feed.js:8` defines `const base = 'http://127.0.0.1:5001'`.
Replace that one source with validated deployment-time public configuration
(e.g. a runtime config loaded before this script), defaulting to loopback only
for local development. All health/JPEG/MJPEG URLs already derive from `base`.
Require HTTPS for a hosted backend, strip the trailing slash, and reject embedded
credentials, queries and fragments. Add the chosen frontend origin to the backend
allowlist and adjust any frontend CSP `connect-src`/`img-src` to allow that backend.
Never include RTSP URLs, push keys or cloud API keys in frontend configuration.

Authentication must also be settled before exposing video. The current image
uses `crossOrigin = 'anonymous'` and fetch uses no cross-origin credential flow.
For a same-origin gateway, use its authenticated session. Cross-origin cookie
auth would require coordinated fetch/image credentials, exact-origin credential
CORS and cookie policy changes. An `<img>` stream cannot attach a Firebase bearer
header: a token-aware gateway/session or different stream transport is needed.
Keep camera identity, fallback, tracking and sequential polling behavior intact.

## Recommended target

An always-on Linux VM with this container and an authenticated HTTPS reverse
proxy is the simplest fit: persistent outbound RTSP, CPU OpenCV processing,
one shared inference scheduler, predictable long-lived MJPEG and no scale-to-zero.
Choose a nearby region after measuring RTSP and inference latency. An always-on
container service with one replica and appropriate streaming ingress is also
viable; avoid request-only serverless/function hosting. Docker supports process
restart policies, but health degradation needs separate monitoring.

References: [Waitress limits and backpressure](https://docs.pylonsproject.org/projects/waitress/en/latest/arguments.html),
[Docker restart supervision](https://docs.docker.com/engine/containers/start-containers-automatically/).

## Offline verification

```powershell
.\backend\detection-bridge\.venv\Scripts\python.exe -B -m unittest discover -s backend/detection-bridge -p "test_*.py"
node --test backend/detection-bridge/test_segmentation_frontend.cjs
```

Use a fresh requirements-installed environment to additionally verify headless
OpenCV and Waitress. Tests must use synthetic frames/fake cloud calls only; never
start either entry point against private configuration during an offline check.

# Railway-private live-authentication smoke plan

Prepared only. No Railway job, public domain, deployment, Git commit or push was
performed. The reported ACTIVE inference/published frames are operational evidence
from the operator, not evidence that authentication was tested live in this task.

## What was inspected

ProductionServer wraps the feed in secure_application. `/health` is unauthenticated
but exact-Host/origin validated and returns only `{"status":"alive"}`. The three
camera GET routes require the configured camera document ID; feed-health/evidence
require Firebase bearer headers, and MJPEG requires a consumed ticket. Firebase
Admin verifies project/issuer/signature/expiry and checks revocation/disabled users.
The server reads users/{uid} for eligible active roles, then requires the enabled
grant at bridge_camera_access/{cameraDocId}/viewers/{uid}. This client neither
reads nor writes Firestore and never mints a token from a service-account key.

The actual live private hostname, effective listen port, Host/origin lists, Firebase
IAM and credentials were not accessed. The private .env and service-account JSON
were not read. Current private addressing/configuration must be confirmed in the
Railway dashboard, without exporting the production environment.

## Runner design

private_smoke.py is a standard-library-only, one-shot HTTP client. Dockerfile.smoke
runs it as UID 10001, with a 180-second wall-clock timeout and no web listener.
Per-request socket timeout is 8 seconds; response/JPEG memory is bounded at 20 MiB.
It follows no redirects, uses no ambient HTTP proxy/.netrc, does not load dotenv,
logs no URL/headers/response data/exception text, and saves no images. It prints
fixed PASS/FAIL/SKIP labels only. Exit 0 means performed checks passed, NOT that
skipped checks passed. Exit 1 means a performed check failed; 2 means configuration
or top-level execution failed; 124 means the container timeout expired.

Private transport uses HTTP on Railway's WireGuard network, not public HTTP. Only
http://<name>.railway.internal:<port> targets are accepted. The HTTP Host header is
configured separately using an authority ALREADY allowed by the production server.
The simulated Origin must already be an allowed HTTPS frontend origin. This avoids
editing production allowlists just to run a test. It exercises server CORS policy,
not actual browser CORS, TLS, public ingress or third-party-cookie behavior.

## Exact setup (requires approval before execution)

1. In the SAME Railway project AND environment as the deployed bridge, prepare a
   separate empty service named `ai-private-smoke`. Do not connect production
   source auto-deployment, add networking, duplicate production secrets, configure
   a cron schedule, attach a volume or configure a health-check route.
2. Set runner restart policy to **Never** and replicas to **1**. Leave Start Command
   unset so the Docker CMD runs once. This is a short-lived job, not a web service;
   completed/stopped status is expected. Failures must not cause automatic retries.
3. On the RUNNER only, provision these variables through the protected dashboard:

| Variable | Value |
| --- | --- |
| SMOKE_PRIVATE_URL | http://<existing bridge RAILWAY_PRIVATE_DOMAIN>:<actual bridge listen port> |
| SMOKE_ALLOWED_HOST | One exact authority already in SEGMENTATION_ALLOWED_HOSTS, with port if that authority includes it; e.g. healthcheck.railway.app only if already allowed |
| SMOKE_ALLOWED_ORIGIN | One exact existing HTTPS SEGMENTATION_ALLOWED_ORIGINS entry, no trailing slash |
| SMOKE_CAMERA_DOC_ID | Actual SEGMENTATION_CAMERA_DOC_ID, also the Firestore camera document/grant path ID |
| SMOKE_FIREBASE_ID_TOKEN | OPTIONAL fresh client SDK ID token for an existing active, granted test user; protected runner value, never a CLI argument |
| SMOKE_DENIED_ID_TOKEN | OPTIONAL valid ID token for an existing eligible active user known to lack this camera's grant |
| SMOKE_TEST_EXPIRY | OPTIONAL true to wait 32 seconds and test expiry with a still-authorized control request |

The runner's own injected PORT is NOT the bridge port. The bridge uses explicit
SEGMENTATION_FEED_PORT, otherwise its PORT, otherwise 5001. Confirm its effective
port in existing configuration privately. Do not change it for this test. A
runner reference variable may use the bridge's RAILWAY_PRIVATE_DOMAIN, but avoid
assuming an auto-injected PORT can be referenced if not available in the dashboard.

Do not provide CAMERA_RTSP_URL, ULTRALYTICS_API_KEY, FIREBASE_SERVICE_ACCOUNT_JSON
or passwords to the runner. A Firebase Admin service-account credential/custom
token is NOT a client ID token. If no approved method exists to securely transfer
a fresh user ID token, run negative checks only; report authorized checks SKIP.
Do not obtain tokens with console.log, shell arguments, debug output or screenshots.
Use a trusted token handoff into protected runner-only variables; remove temporary
test values through the dashboard after the run. No production secret changes.

## Build and approved deployment commands

Optional local image build, from repository root (not run in this task):

```powershell
docker build -f backend/detection-bridge/Dockerfile.smoke -t riversight-ai-private-smoke backend/detection-bridge
```

For a later approved runner deployment, stage ONLY these two files. Do not upload
the bridge directory or the repository wholesale; that avoids even relying on
ignore rules to keep private files out of the upload:

```powershell
$smokeStage = Join-Path $env:TEMP ('riversight-private-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $smokeStage | Out-Null
Copy-Item -LiteralPath backend/detection-bridge/private_smoke.py -Destination (Join-Path $smokeStage 'private_smoke.py')
Copy-Item -LiteralPath backend/detection-bridge/Dockerfile.smoke -Destination (Join-Path $smokeStage 'Dockerfile')
```

After explicit approval, replace PROJECT_ID and ENVIRONMENT with the existing
project/environment identifiers and run:

```powershell
railway up $smokeStage --path-as-root --project PROJECT_ID --environment ENVIRONMENT --service ai-private-smoke
railway logs --project PROJECT_ID --environment ENVIRONMENT --service ai-private-smoke --lines 100
```

Verify the exact destination and staged settings before executing up. This command
DEPLOYS THE RUNNER and is not authorized by preparation alone. It does not require
a Git commit/push. Do not use railway domain, --new, --no-gitignore, verbose token
logging, or railway run. railway run executes locally and cannot establish this
private-network test. Run the checks in deployed runtime, not a Docker build step.
The container command is:

```sh
timeout --signal=TERM --kill-after=5s 180s python -B private_smoke.py
```

## Performed live checks when the job runs

Always: exact minimal /health JSON; 401 for unauthenticated feed-health, evidence
and stream using the CORRECT camera ID; invalid token 403; disallowed Host/Origin
403; allowed preflight 200 with matching origin and Authorization permission.
Wrong Host/camera returning 403 is NOT substituted for authentication rejection.

With a granted token: authorized identity/fresh health; fresh evidence headers and
JPEG markers; ticket issuance; first bounded MJPEG JPEG part then disconnect;
replay rejection; advancing fresh capture metadata. The stream check does not
prove masks align with a scene, full 60-second lifetime, or byte-for-byte frame
freshness (the multipart parts have no capture timestamps). Those need separate
tests. FPS=0 deliberately skips MJPEG checks. Health freshness uses the frontend's
15-second window and at most 5 seconds future-clock tolerance.

With expiry enabled: a NEW unused ticket, a 32-second wait, a successful fresh
authorized feed-health control, then expired-ticket 401. This avoids treating
expired/revoked user access as evidence of ticket TTL enforcement. With a known
ungranted-user token: its feed-health must return 403. That only tests that user's
known missing grant; malformed tokens cannot prove camera-grant enforcement.

The runner does not revoke accounts, alter grants, change roles/rules/secrets,
create users, query private fields, load-test, or exercise the inference endpoint
directly. It briefly uses one stream viewer slot and makes a small number of
Firebase-authenticated bridge calls; existing inference continues independently.

## Local evidence and blockers

Only offline fake-transport/parser tests and the existing Python/frontend suites
were executed here. No live Railway network or Firebase IAM/access test was run.
Railway CLI and Docker are unavailable in this workspace; no approved runner
deployment or usable private execution session was provided. Required hostname,
port and allowlist entries must be supplied without opening private credentials.

Legacy Railway environments can expose IPv6-only private DNS. The current bridge
validates an IPv4 bind and defaults to 0.0.0.0. Dual-stack environments allow an
IPv4 connection; the client automatically tries resolved addresses. In an
IPv6-only environment it cannot reach this IPv4-only listener. Report that as a
connectivity blocker, not an auth failure. Do not fix it by exposing a public
domain or disabling Host checks; obtain separate approval for IPv6 support or an
appropriate private deployment adjustment.

Local PASS does not certify the deployed version. Record deployed image/commit
identity, runtime exit code, fixed test labels and skips, never request bodies,
camera URLs, user tokens or ticket values. A health/status-only check cannot
establish real authorization. Missing dedicated tokens block authorized/ACL
claims. Actual browser HTTPS, edge logs and revocation during a long stream
remain separate acceptance work.

References: [Private network isolation](https://docs.railway.com/networking/private-networking),
[IPv4/IPv6 and runtime-only networking](https://docs.railway.com/networking/private-networking/how-it-works),
[Local railway run](https://docs.railway.com/cli/run),
[One-shot restart policy](https://docs.railway.com/deployments/restart-policy),
[Scoped code upload/deployment](https://docs.railway.com/cli/up).

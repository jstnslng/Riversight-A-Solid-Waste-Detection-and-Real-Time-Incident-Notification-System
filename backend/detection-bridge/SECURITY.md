# Secure Firebase-hosted feed access (prepared, not deployed)

For non-public live validation, see [PRIVATE_SMOKE.md](PRIVATE_SMOKE.md): a
separate one-shot runner in the same Railway project/environment, never a public
domain or local railway run. Deployment of that runner requires approval.

ProductionServer always wraps its internal WSGI application with Firebase
authentication. There is no runtime switch to disable authentication. Development
segmentation_feed.py stays loopback-only and retains its existing local behavior.
RTSP capture, sequential Ultralytics cloud requests, evidence rendering, tracking,
bounded MJPEG viewers and Railway PORT precedence remain unchanged.

## Identity and permissions

Firebase Admin verifies the client SDK ID token: signature, issuer, audience,
expiry, revocation and disabled Firebase accounts (`check_revoked=True`). The
configured project must match the website's Firebase project. Emulator variables
are rejected in production. Verification/network/database failures deny access;
exception text and tokens are not logged.

The bridge reads `users/{uid}` through Admin SDK. Allowed roles are exactly
`Administrator`, `Monitoring`, `Monitoring Personnel`. Status must be `active`
or `Active`; absent status preserves the existing legacy Active default.
Pending/inactive accounts are denied, including administrators. No browser
sessionStorage role or custom client field is trusted.

Every viewer also needs this server-managed Firestore document:

```text
bridge_camera_access/{SEGMENTATION_CAMERA_DOC_ID}/viewers/{firebase_uid}
  enabled: true
```

There is no administrator bypass, inferred barangay matching or default grant.
Missing/false grants deny access. Manage grants using a trusted Firebase Console
operator or privileged backend. Do NOT place assignments in user-editable profile
fields: current rules allow some self-registration/profile updates. Existing
rules deny client access to this unmatched collection, and are unchanged. Do not
add a broad recursive allow rule. Admin SDK bypasses Firestore rules, so backend
checks and least-privilege service-account IAM are essential.

## HTTP contract

All production routes enforce exact configured Host and HTTPS Origin allowlists.
OPTIONS allows only the needed methods and `Authorization`; no wildcard origins
or credential cookies. HTTPS terminates at Railway ingress; do not trust arbitrary
forwarded Host/identity headers. No endpoint serves private files.

| Route | Access |
| --- | --- |
| `GET /health` | Allowed Host, no token required; only `{"status":"alive"}`. No camera identity, timestamps or viewer-session information. |
| `GET /feed-health?cameraDocId=...` | Firebase bearer token + camera grant; existing detailed feed schema. Optional streamId retained. |
| `GET /latest-segmentation.jpg?cameraDocId=...` | Firebase bearer token + camera grant; exact inference-frame evidence. |
| `POST /stream-ticket?cameraDocId=...` | Firebase bearer token + camera grant + explicit allowed Origin; empty request body. |
| `GET /segmentation-stream.mjpg?cameraDocId=...&streamId=...&ticket=...` | Single-use ticket + same issuing Origin + fresh Firebase/ACL verification. No ID tokens in URLs. |

Use `Authorization: Bearer <Firebase ID token>` in fetch headers. Tickets are
cryptographically random, stored by hash in a bounded 256-entry memory table,
expire within 30 seconds/token expiry, and are consumed atomically. They are
bound to this process's configured camera and issuing Origin. They are short
bearer secrets: redact ALL query strings in Railway/proxy logs, tracing and
analytics; do not share ticket URLs. Browser Origin is an embedding restriction,
not proof against an attacker who steals a ticket and spoofs headers.

No third-party cookies or Firebase ID tokens are sent in image URLs. Streams
expire after at most 60 seconds/token expiry; the frontend renews at about 55
seconds. Firebase revocation, role/status and camera grants are rechecked every
15 seconds while sending. Revocation has that bounded polling delay plus network
time and already-buffered/in-flight frames. Auth outages close streams. Viewer
slots are released on expiry, rejection or disconnect. A single process/replica
is required: tickets are process-local. A restart invalidates all tickets.

## Required runtime configuration

Keep existing CAMERA_RTSP_URL, ULTRALYTICS_ENDPOINT, ULTRALYTICS_API_KEY,
SEGMENTATION_CAMERA_DOC_ID, SEGMENTATION_ALLOWED_HOSTS and
SEGMENTATION_ALLOWED_ORIGINS. Add:

- `FIREBASE_PROJECT_ID`: the website's Firebase project ID.
- Credentials: either protected `FIREBASE_SERVICE_ACCOUNT_JSON` containing a
  service account object, or Google Application Default Credentials. For a file,
  mount it privately and set `GOOGLE_APPLICATION_CREDENTIALS`; never COPY it into
  the image. Workload identity is preferable where supported. Do not print values.

Provide only Firebase Auth account-read/token-revocation-check permissions and
Firestore read access needed for users/grants; no broad Owner/Editor role. Enable
Firestore and Firebase Authentication for that project. Do not send service
credentials, RTSP playback secrets or Ultralytics keys to the website. Configure
Firebase Auth authorized domains for the actual hosted frontend as usual.

Production host defaults to 0.0.0.0; port precedence remains explicit
SEGMENTATION_FEED_PORT, then Railway PORT, then 5001. Add exact ingress authorities
and `healthcheck.railway.app` (plus exact port-qualified form if required) deliberately
to allowed hosts. Do not auto-allow Railway domains. Allow only the actual Firebase
Hosting HTTPS origins you use (each custom/web.app/firebaseapp.com origin separately).

## Website configuration and remaining deployment steps

1. Set the public HTTPS backend origin in the `riversight-ai-backend` meta tag in
   `lib/monitoring/Waste-Management.html`. It is intentionally blank here. The
   hosted frontend fails closed until configured; local HTTP still defaults to
   the loopback development bridge. No path/query/credentials are accepted.
2. The new `ai-feed-auth.js` obtains refreshed ID tokens from the existing Auth
   instance. The existing feed script uses token headers and exchanges tickets
   for anonymous CORS image streams. Sign-out removes the stream; camera changes
   abort pending work. Existing fallback, health polling and tracking display stay.
3. Provision service credentials and per-camera grants with trusted operators.
   Do not weaken Firestore rules. Configure exact Host/origin lists in Railway.
4. Rebuild/test on Linux, then obtain explicit deployment authorization. Keep
   Railway unexposed during preparation. Before eventual exposure, require TLS,
   redact request query/auth logs, disable MJPEG buffering/caching, allow long
   responses, and add edge rate limits/concurrent-viewer limits. Application limits
   alone do not prevent paid Auth/Firestore request abuse.
5. Validate real Firebase tokens: correct/wrong project, signed-out/expired/revoked,
   disabled/pending users, granted/ungranted cameras, camera switch, ticket replay,
   permission removal during streaming, recovery and production preflight.
6. Check browser CSP connect-src/img-src for the chosen backend. No Firebase
   Hosting configuration, rules, credentials or exposure changes were made here.

Unprocessed RTSP.ME iframe fallback is outside this bridge's authorization gate;
current camera records expose that playback to eligible Firestore readers. This
change secures the AI feed, not the third-party source. Review fallback playback
privacy separately before treating all video as camera-grant restricted.

Offline policy tests mock token verification/database responses. Additional SDK
tests use generated in-memory RSA test keys and mocked certificate/account network
responses to exercise real signature, issuer, audience, expiry, disabled-user and
revocation checks. They do not establish live Firebase IAM/project correctness or
browser/Railway behavior. Firebase Admin is the production cryptographic verifier;
no homemade token decoder is used. Loopback Waitress tests also cover preflight,
empty-body ticket POSTs and unauthenticated route rejection.

## Readiness review and safe deployment sequence

The website's public Firebase configuration selects `riversight-220d9`. Verify
privately that Railway's FIREBASE_PROJECT_ID selects that same project. Credentials
and camera grants have been reported as provisioned; their contents, IAM and live
Railway variables were not inspected. This review did not read any private .env
or service-account file, deploy software, change rules or enable networking.

Two timing fixes prevent frame publication after a stream deadline even when
verification blocks, and prevent a delayed ticket from reopening stale health.
Renewal now retains its freshness timer. The frontend backend meta tag remains
blank intentionally: it is an unresolved hosted-access configuration blocker.

Remaining Railway checks (set only if missing; preserve working secrets):

| Setting | Required check |
| --- | --- |
| CAMERA_RTSP_URL / ULTRALYTICS_ENDPOINT / ULTRALYTICS_API_KEY | Preserve the working runtime values; do not copy them into frontend files or commands. |
| SEGMENTATION_CAMERA_DOC_ID | Must equal camera_feeds/{document ID}, the camera grant path ID and the physical camera actually captured. Not camId/title. Frontend selection already publishes cameraDoc.id. |
| SEGMENTATION_ALLOWED_HOSTS | Exact planned backend authority, healthcheck.railway.app, and only needed private probe authorities; hostnames without scheme/path, include explicit port when sent. |
| SEGMENTATION_ALLOWED_ORIGINS | Exact frontend HTTPS origins without trailing slash; web.app, firebaseapp.com and custom domains are distinct. Use only those actually needed. |
| SEGMENTATION_FEED_HOST | Unset uses production 0.0.0.0; remove an accidental local-loopback override or explicitly set 0.0.0.0. |
| SEGMENTATION_FEED_PORT / PORT | Prefer unset SEGMENTATION_FEED_PORT and Railway's injected PORT. If overriding, align runtime, ingress target and health-check ports. |
| FIREBASE_PROJECT_ID / FIREBASE_SERVICE_ACCOUNT_JSON | Already reported configured; verify project and required read IAM privately, without exporting values into logs. |
| Replica / execution settings | One always-on process/replica, Docker production entry point, /health liveness probe, sensible memory/CPU and shutdown grace. |

Safe order for a later explicitly authorized deployment:

1. Confirm the user profile role/status, enabled boolean grant, exact UID and all
   camera document IDs using a trusted console. Confirm Firebase Auth account-read
   and Firestore read IAM. Do not change credentials or grant broad roles just to
   bypass a failed test.
2. Select the intended HTTPS hostname without enabling public networking. Record
   the exact backend Host and hosted frontend Origin. Configure allowlists and
   health-check authority. Do not create a Railway public domain during preparation
   if doing so enables networking; defer that action to explicit authorization.
3. Set the public backend origin in Waste-Management.html's riversight-ai-backend
   meta tag. Confirm the Auth adapter script remains included. A hosted page must
   never fall back to localhost for AI requests. Allow the backend in connect-src
   and img-src if a deployment CSP is present. No credentials go in this tag.
4. Run offline tests and a Linux image build. Deploy the reviewed image privately
   only after deployment authorization. Retain one replica and the production
   command `python -B production_server.py`; keep public networking disabled.
5. Through a trusted private test client/tunnel, validate real Firebase tokens in
   headers held in memory, using allowed Host/Origin. Expect /health minimal 200,
   camera routes without tokens 401, unauthorized camera/user 403, verified
   /feed-health 200, POST /stream-ticket 200, ticket stream 200, replay/expired
   ticket 401, disallowed Host/Origin 403, and allowed preflight 200. Validate IAM,
   fresh evidence/tracking and revocation during an active stream. Never put tokens
   in shell history, test output, screenshots or shared curl commands.
6. Before exposing anything, verify TLS and that ingress/proxy/browser analytics
   do not retain tickets or auth headers. Railway edge HTTP logging is separate
   from application stdout: application redaction does not prove edge redaction.
   Use a harmless dummy query marker to inspect logging behavior, never a real
   ticket. If bearer query values cannot be excluded/redacted, treat that as a
   release blocker and use an ingress/transport that meets this requirement.
   Verify streaming is unbuffered/uncached and configure edge rate/viewer limits.
7. Obtain separate authorization for public networking and frontend publication.
   Only then enable the planned HTTPS route and publish the configured page.
   Test from its real browser Origin: Chrome/Firefox image decoding, 55-second
   renewal, snapshot mode, sign-out, permission removal, recovery and denied users.
   Restrict networking again if protection/logging tests fail; do not relax CORS,
   Host checks or camera grants as a workaround.

Signing out closes this page's image but does not globally revoke an already
issued Firebase token. For account compromise/offboarding, disable/revoke the
Firebase account and remove the grant; the bridge checks those server-side.
Continuous feed-health/freshness monitoring is separate from Railway deployment
liveness. A passing public /health cannot prove Firebase authorization works.

Platform references: [Railway health-check Host/PORT](https://docs.railway.com/deployments/healthchecks),
[Railway edge HTTP logs](https://docs.railway.com/cli/logs),
[Firebase sign-out and Auth state](https://firebase.google.com/docs/reference/js/auth.auth).

References: [Firebase ID token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens),
[Admin revocation checks](https://firebase.google.com/docs/reference/admin/python/firebase_admin.auth),
[Firestore server IAM and rule bypass](https://firebase.google.com/docs/firestore/security/overview).

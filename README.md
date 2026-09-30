# Riversight

A Solid waste detection and real-time incident notification system using YOLOv8 algorithm for environmental waterway monitoring. This project utilizes the YOLOv8 algorithm to identify and categorize floating solid waste in water bodies in real-time and also inform local authorities about the buildup of garbage in the area. The primary goals of this project are to develop an effective object detection application, develop a dashboard for the project, and build reporting tools. The project working plan entails working with Google Drive and GitHub in coordination with other team members. Our key milestones would include collecting and distinguishing a dataset, building the application, developing the dashboard, and finally testing the whole system of the application. 

# Development Tools
- HTML
- Javascript
- CSS
- Python
- Visual Studio Code
- Firebase
- OpenCV
- YOLOv8

## Local Waste Detection development

Run two terminals from the repository root. Python's standard-library server
serves the existing static files; no additional web-server dependency is needed.

**Terminal 1 — website (port 8000):**

```powershell
python -m http.server 8000 --bind 127.0.0.1
```

Alternatively run `./scripts/start-local-web.ps1`. The helper resolves the
repository root even when invoked from another directory and starts only the
website, bound to loopback. Stop either process with Ctrl+C.
If PowerShell blocks scripts under your execution policy, use the direct Python
command above from the repository root; no policy change is required.

Open [Waste Detection](http://127.0.0.1:8000/lib/monitoring/Waste-Management.html)
in your browser and use the existing sign-in flow. Do not open the HTML file
directly: `file://` requests have an untrusted origin (typically `null`) and are
intentionally rejected by the segmentation bridge. The developer console warns
about this; the normal live-camera fallback remains available.

**Terminal 2 — segmentation bridge (port 5001):**

```powershell
.\backend\detection-bridge\.venv\Scripts\python.exe backend/detection-bridge/segmentation_feed.py
```

Use your existing private bridge configuration, including
`SEGMENTATION_CAMERA_DOC_ID`; never put credentials or the actual configured ID
in frontend source. See the [bridge README](backend/detection-bridge/README.md)
for setup and camera association. Healthy, fresh frames with an exact matching
document ID activate AI automatically, including frames with zero detections.
Mismatch, stale frames or failed requests use the selected camera's live feed;
recovery restores AI without a reload.

Waste Detection now uses `http://127.0.0.1:5001/segmentation-stream.mjpg` with a
default local target of 10 FPS (`SEGMENTATION_STREAM_FPS`, range 1-15). YOLO stays
in the cloud, sequential, at the existing 2-second interval. One shared classical
optical-flow tracker propagates YOLO polygon positions onto current frames; the
stream never intentionally replays an old inference frame. Labels retain the last
YOLO confidence and identify tracked positions as estimates. Exact model evidence
remains at `/latest-segmentation.jpg`, independently of the live tracked overlay.
`/health` includes bounded rolling latency statistics and tracking status.
`SEGMENTATION_TRACK_MAX_AGE_SECONDS=3.0` is a provisional conservative expiry
including cloud latency; inspect the measured health values before tuning.
Set `SEGMENTATION_TRACKING_ENABLED=false` for current raw MJPEG without tracking,
or set stream FPS to 0 for the original snapshot-only mode; restart after changes.
See the bridge README for alignment limits, zero-result grace, and manual tests.

Both `http://127.0.0.1:8000` and `http://localhost:8000` are already in the bridge's
default allowed origins. If you privately override `SEGMENTATION_ALLOWED_ORIGINS`,
ensure your exact HTTP origin remains listed and restart the bridge after edits.
No wildcard or filesystem origin is needed. Verify `location.origin` in browser
DevTools and check that health/JPEG requests succeed from the page.

`firebase.json` currently configures only Firestore; `.firebaserc` selects the
Firebase project. There is no Hosting or Hosting emulator configuration, which
explains “No emulators to start” for `firebase emulators:start --only hosting`.
The static server above needs no Firebase initialization or configuration change.

This server is for trusted local development only. Python's static server serves
files beneath the repository root, including ignored files when requested;
`.gitignore` is not HTTP access control. Keep the loopback bind and do not expose
or forward this server. The website code does not load backend `.env` files.

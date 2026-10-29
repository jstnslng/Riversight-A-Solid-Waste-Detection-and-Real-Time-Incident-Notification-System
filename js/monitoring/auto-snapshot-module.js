import { db } from "../shared/firebase-config.js";
import {
  collection, query, where, onSnapshot, doc, setDoc, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const DETECTION_TIME_FIELD = "timestamp"; // change if the backend writes a different field name
const MIN_CONFIDENCE = 0.5;               // 0 to 1 scale
const COOLDOWN_MS = 30000;                // one snapshot per camera every 30 s
const MAX_WIDTH = 480;
const JPEG_QUALITY = 0.7;

const frame = document.querySelector("[data-camera-feed-frame]");
const image = document.querySelector("[data-segmentation-image]");
const selector = document.getElementById("wasteCameraSelect");
const lastCapture = new Map();

function normalizeConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

function grabFrame() {
  if (!image || image.hidden || !image.naturalWidth) return null;
  const scale = Math.min(1, MAX_WIDTH / image.naturalWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  try {
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } catch (err) {
    console.error("Snapshot blocked (canvas tainted):", err);
    return null;
  }
}

async function captureFor(detectionDoc) {
  const d = detectionDoc.data();
  const conf = normalizeConfidence(d.confidenceScore ?? d.confidence);
  if (conf !== null && conf < MIN_CONFIDENCE) return;

  const selectedIds = [selector?.value, frame?.dataset.cameraDocId].filter(Boolean);
  if (d.cameraId && !selectedIds.includes(d.cameraId)) return; // on-screen frame is another camera
  const cameraId = d.cameraId || selectedIds[0] || "unknown";

  const now = Date.now();
  if (now - (lastCapture.get(cameraId) || 0) < COOLDOWN_MS) return;

  const imageUrl = grabFrame();
  if (!imageUrl) return;
  lastCapture.set(cameraId, now);

  await setDoc(doc(db, "snapshots", detectionDoc.id), {
    imageUrl,
    cameraId,
    detectionId: detectionDoc.id,
    confidenceScore: conf,
    timestamp: serverTimestamp(),
  });
}

const q = query(
  collection(db, "detections"),
  where(DETECTION_TIME_FIELD, ">=", Timestamp.now())
);

onSnapshot(q, (snap) => {
  snap.docChanges().forEach((change) => {
    if (change.type === "added") {
      captureFor(change.doc).catch((e) => console.error("Auto snapshot failed:", e));
    }
  });
}, (err) => console.error("Auto snapshot listener failed:", err));
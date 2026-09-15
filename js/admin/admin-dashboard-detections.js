import { db } from "../shared/firebase-config.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const MAX_VISIBLE_DETECTIONS = 5;
let onlineCameraIds = new Set();
let reports = [];

function normalizeCameraId(value) {
  return String(value || "").trim().toUpperCase();
}

function getTimestampValue(report) {
  const value = report.createdAt || report.timestamp || report.evaluatedAt;
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTime(report) {
  const date = getTimestampValue(report);
  if (date) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  }
  return report.time || "--:--:--";
}

function normalizeSeverity(value) {
  const severity = String(value || "Low").toLowerCase();
  if (severity === "high" || severity === "severe" || severity === "critical") return "High";
  if (severity === "medium" || severity === "moderate") return "Medium";
  return "Low";
}

function getConfidence(report) {
  const confidence = Number(report.confidence);
  return Number.isFinite(confidence) ? `${confidence.toFixed(1)}%` : "--";
}

function renderDetection(report) {
  const item = document.createElement("article");
  item.className = "detection-item";

  const info = document.createElement("div");
  info.className = "detection-info";

  const row = document.createElement("div");
  row.className = "detection-row";
  const cameraId = document.createElement("span");
  cameraId.className = "cam-id";
  cameraId.textContent = report.camId;
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = formatTime(report);
  row.append(cameraId, time);

  const title = document.createElement("div");
  title.className = "detection-title";
  title.textContent = report.detectionType || "Waste Detection";

  const severity = normalizeSeverity(report.severity);
  const severityLabel = document.createElement("div");
  severityLabel.className = `detection-meta severity-${severity.toLowerCase()}`;
  severityLabel.textContent = `Severity Level: ${severity}`;

  const confidence = document.createElement("div");
  confidence.className = "confidence";
  confidence.textContent = "Confidence: ";
  const confidenceValue = document.createElement("strong");
  confidenceValue.textContent = getConfidence(report);
  confidence.appendChild(confidenceValue);

  info.append(row, title, severityLabel, confidence);
  item.appendChild(info);
  return item;
}

function renderDetections() {
  const list = document.getElementById("recentDetectionsList");
  const summary = document.getElementById("recentDetectionsSummary");
  if (!list) return;

  const activeDetections = reports
    .filter((report) => onlineCameraIds.has(normalizeCameraId(report.camId || report.cameraId || report.camera)))
    .sort((left, right) => (getTimestampValue(right)?.getTime() || 0) - (getTimestampValue(left)?.getTime() || 0));
  const visibleDetections = activeDetections.slice(0, MAX_VISIBLE_DETECTIONS);
  list.replaceChildren();

  if (!visibleDetections.length) {
    const emptyState = document.createElement("div");
    emptyState.className = "detection-empty";
    emptyState.textContent = "No AI detections recorded.";
    list.appendChild(emptyState);
  } else {
    visibleDetections.forEach((report) => list.appendChild(renderDetection(report)));
  }

  if (summary) {
    summary.textContent = `${activeDetections.length} active-camera detection${activeDetections.length === 1 ? "" : "s"}`;
  }
}

onSnapshot(collection(db, "camera_feeds"), (snapshot) => {
  onlineCameraIds = new Set(
    snapshot.docs
      .map((cameraDoc) => {
        const camera = cameraDoc.data();
        if ((camera.status || "ONLINE").toUpperCase() !== "ONLINE") return null;
        return [camera.camId, cameraDoc.id]
          .map(normalizeCameraId)
          .filter(Boolean);
      })
      .flat()
      .filter(Boolean),
  );
  renderDetections();
}, (error) => {
  console.error("Failed to load active cameras for recent detections:", error);
  onlineCameraIds = new Set();
  renderDetections();
});

onSnapshot(collection(db, "reports"), (snapshot) => {
  reports = snapshot.docs.map((reportDoc) => ({ id: reportDoc.id, ...reportDoc.data() }));
  renderDetections();
}, (error) => {
  console.error("Failed to load reports for recent detections:", error);
  reports = [];
  renderDetections();
});
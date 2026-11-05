import { subscribeDetections } from "./detection-store.js";

const container = document.getElementById("recentSnapshotsGrid");
const cameraSelect = document.getElementById("wasteCameraSelect");
let detections = [];

function formatTime(timestamp) {
  if (!timestamp) return "Time pending";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "Time unavailable"
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function selectedCameraId() {
  return document.querySelector("[data-camera-feed-frame]")?.dataset.cameraDocId || "";
}

function render() {
  if (!container) return;
  const camera = selectedCameraId();
  const visible = detections.filter((item) => !camera || item.cameraDocId === camera);
  container.replaceChildren();

  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "snapshot-empty";
    empty.textContent = "No detection events recorded for this camera.";
    container.appendChild(empty);
    return;
  }

  visible.slice(0, 3).forEach((item) => {
    const card = document.createElement("article");
    card.className = "snapshot";
    const title = document.createElement("strong");
    title.textContent = item.wasteClass || "Waste detection";
    const time = document.createElement("span");
    time.textContent = formatTime(item.timestamp);
    const note = document.createElement("small");
    note.textContent = item.snapshotUrl
      ? "Persisted detection snapshot"
      : "Detection recorded; no persisted snapshot";
    card.append(title, time, note);
    if (item.snapshotUrl) {
      card.style.backgroundImage = `url("${item.snapshotUrl}")`;
      card.title = "Open persisted detection snapshot";
      card.addEventListener("click", () => window.open(item.snapshotUrl, "_blank", "noopener"));
    }
    container.appendChild(card);
  });
}

subscribeDetections(
  (snapshot) => {
    detections = snapshot.docs
      .sort((left, right) => (right.data().timestamp?.toMillis?.() || 0)
        - (left.data().timestamp?.toMillis?.() || 0))
      .slice(0, 50)
      .map((item) => ({ id: item.id, ...item.data() }));
    render();
  },
  (error) => {
    console.error("Could not load recent detection captures:", error);
    if (container) container.textContent = "Recent detection captures are unavailable.";
  }
);

cameraSelect?.addEventListener("change", render);
document.addEventListener("riversight:camera-selected", render);

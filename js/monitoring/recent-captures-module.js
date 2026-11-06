import { subscribeDetections } from "./detection-store.js";

const container = document.getElementById("recentSnapshotsGrid");
const cameraSelect = document.getElementById("wasteCameraSelect");
let detections = [];

const samplePreviews = [
  { wasteClass: "Plastic bottle", confidenceScore: 94.2 },
  { wasteClass: "Plastic wrapper", confidenceScore: 88.6 },
  { wasteClass: "Organic debris", confidenceScore: 91.3 }
];

function formatTime(timestamp) {
  if (!timestamp) return "Time pending";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "Time unavailable"
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function placeholderImage(wasteClass = "") {
  const label = String(wasteClass).toLowerCase();
  const file = label.includes("organic") || label.includes("leaf") || label.includes("debris")
    ? "organic-debris.svg"
    : label.includes("wrapper") || label.includes("bag") || label.includes("pack")
      ? "wrapper.svg"
      : "plastic-bottle.svg";
  return new URL(`../../assets/detection-samples/${file}`, import.meta.url).href;
}

function selectedCameraId() {
  return document.querySelector("[data-camera-feed-frame]")?.dataset.cameraDocId || "";
}

function createSnapshotCard(item, isSample = false) {
  const card = document.createElement("article");
  card.className = "snapshot";

  const image = document.createElement("img");
  let showingPlaceholder = isSample || !item.snapshotUrl;
  image.className = "snapshot-image";
  image.alt = isSample
    ? `Illustrative sample of ${item.wasteClass}`
    : item.snapshotUrl
      ? `Saved detection snapshot of ${item.wasteClass || "waste"}`
      : `Illustrative preview for ${item.wasteClass || "waste"} detection`;
  const illustration = document.createElement("span");
  illustration.className = "snapshot-illustration";
  illustration.textContent = "Illustration";
  illustration.hidden = !showingPlaceholder;

  const details = document.createElement("div");
  details.className = "snapshot-details";
  const title = document.createElement("strong");
  title.textContent = item.wasteClass || "Waste detection";
  const metadata = document.createElement("span");
  const confidence = Number(item.confidenceScore ?? (item.confidence * 100));
  const confidenceLabel = Number.isFinite(confidence)
    ? `${confidence.toFixed(1)}% confidence`
    : "";
  const timeLabel = isSample ? "Sample detection" : formatTime(item.timestamp);
  metadata.textContent = [confidenceLabel, timeLabel].filter(Boolean).join(" · ");
  const note = document.createElement("small");
  note.textContent = isSample
    ? "Sample preview · not a live detection"
    : item.snapshotUrl
      ? "Saved detection image"
      : "Illustrative preview · not the captured evidence";
  details.append(title, metadata, note);

  image.src = item.snapshotUrl || placeholderImage(item.wasteClass);
  image.addEventListener("error", () => {
    if (showingPlaceholder) return;
    showingPlaceholder = true;
    image.src = placeholderImage(item.wasteClass);
    image.alt = `Illustrative preview for ${item.wasteClass || "waste"} detection`;
    illustration.hidden = false;
    note.textContent = "Illustrative preview · captured image unavailable";
  }, { once: true });

  card.append(image, illustration, details);

  if (item.snapshotUrl && !isSample) {
    card.classList.add("snapshot--saved");
    card.title = "Open saved detection snapshot";
    card.addEventListener("click", () => window.open(item.snapshotUrl, "_blank", "noopener"));
  }
  return card;
}

function render() {
  if (!container) return;
  const camera = selectedCameraId();
  const visible = detections.filter((item) => !camera || item.cameraDocId === camera);
  container.replaceChildren();

  if (!visible.length) {
    samplePreviews.forEach((sample) => container.appendChild(createSnapshotCard(sample, true)));
    return;
  }

  visible.slice(0, 3).forEach((item) => container.appendChild(createSnapshotCard(item)));
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

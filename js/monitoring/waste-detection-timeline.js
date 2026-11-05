import { db } from "../shared/firebase-config.js";
import { collection, query, where, onSnapshot, Timestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const HIGH_CONF_THRESHOLD = 70;
const chartLeft = 30;
const chartRight = 620;
const baselineY = 150;
const chartTop = 10;
const maxCount = 100;

// x position for each 2-hour bucket (00h..22h), evenly spaced
const bucketCount = 12;
function xForBucket(i) {
  return chartLeft + (i / (bucketCount - 1)) * (chartRight - chartLeft);
}

function yForCount(count) {
  const clamped = Math.min(count, maxCount);
  return baselineY - (clamped / maxCount) * (baselineY - chartTop);
}

function buildLinePath(counts) {
  return counts
    .map((c, i) => `${i === 0 ? "M" : "L"}${xForBucket(i)},${yForCount(c)}`)
    .join(" ");
}

function buildFillPath(counts) {
  const line = buildLinePath(counts);
  return `${line} L${chartRight},${baselineY} L${chartLeft},${baselineY} Z`;
}

function render(highCounts, lowCounts) {
  const highLine = document.getElementById("timeline-high-line");
  const highFill = document.getElementById("timeline-high-fill");
  const lowLine = document.getElementById("timeline-low-line");

  if (highLine) highLine.setAttribute("d", buildLinePath(highCounts));
  if (highFill) highFill.setAttribute("d", buildFillPath(highCounts));
  if (lowLine) lowLine.setAttribute("d", buildLinePath(lowCounts));
}

let unsubscribe = null;

function listen() {
  if (unsubscribe) unsubscribe();
  const dateInput = document.getElementById("detectionDate");
  const start = dateInput?.value ? new Date(`${dateInput.value}T00:00:00`) : new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const q = query(
    collection(db, "detections"),
    where("timestamp", ">=", Timestamp.fromDate(start)),
    where("timestamp", "<", Timestamp.fromDate(end))
  );

  unsubscribe = onSnapshot(q, (snapshot) => {
  const highCounts = new Array(bucketCount).fill(0);
  const lowCounts = new Array(bucketCount).fill(0);
  const selectedCamera = document.querySelector("[data-camera-feed-frame]")?.dataset.cameraDocId;

  snapshot.forEach((docSnap) => {
    const data = docSnap.data();
    if (!data.timestamp || typeof data.confidenceScore !== "number"
      || (selectedCamera && data.cameraDocId !== selectedCamera)) return;

    const hour = data.timestamp.toDate().getHours();
    const bucketIndex = Math.min(Math.floor(hour / 2), bucketCount - 1);

    if (data.confidenceScore >= HIGH_CONF_THRESHOLD) {
      highCounts[bucketIndex]++;
    } else {
      lowCounts[bucketIndex]++;
    }
  });

  render(highCounts, lowCounts);
  }, (error) => console.error("Failed to load detection timeline:", error));
}

document.getElementById("detectionDate")?.addEventListener("change", listen);
document.addEventListener("riversight:camera-selected", listen);
listen();
import { db } from "../shared/firebase-config.js";
import { collection, query, where, onSnapshot, Timestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const HIGH_CONF_THRESHOLD = 70; // adjust if you want a different cutoff
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

const startOfToday = new Date();
startOfToday.setHours(0, 0, 0, 0);

const q = query(
  collection(db, "detections"),
  where("timestamp", ">=", Timestamp.fromDate(startOfToday))
);

onSnapshot(q, (snapshot) => {
  const highCounts = new Array(bucketCount).fill(0);
  const lowCounts = new Array(bucketCount).fill(0);

  snapshot.forEach((docSnap) => {
    const data = docSnap.data();
    if (!data.timestamp || typeof data.confidenceScore !== "number") return;

    const hour = data.timestamp.toDate().getHours();
    const bucketIndex = Math.min(Math.floor(hour / 2), bucketCount - 1);

    if (data.confidenceScore >= HIGH_CONF_THRESHOLD) {
      highCounts[bucketIndex]++;
    } else {
      lowCounts[bucketIndex]++;
    }
  });

  render(highCounts, lowCounts);
});
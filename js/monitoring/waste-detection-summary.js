import { db } from "../shared/firebase-config.js";
import {
  collection,
  onSnapshot,
  query,
  Timestamp,
  where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const countElement = document.querySelector("[data-detection-total]");
const confidenceElement = document.querySelector("[data-average-confidence]");
const statusElement = document.querySelector("[data-summary-data-status]");
const volumeElement = document.querySelector("[data-recorded-volume]");
const volumeNoteElement = document.querySelector("[data-volume-note]");

const severityCounts = {
  low: 0,
  medium: 0,
  severe: 0,
  unclassified: 0
};

function classifySeverity(value) {
  const severity = String(value || "").trim().toLowerCase();
  if (["low", "normal", "minor"].includes(severity)) return "low";
  if (["medium", "moderate"].includes(severity)) return "medium";
  if (["high", "severe", "critical"].includes(severity)) return "severe";
  return "unclassified";
}

function formatCount(value) {
  return `${value.toLocaleString()} ${value === 1 ? "event" : "events"}`;
}

function render(snapshot) {
  const counts = { ...severityCounts };
  const confidenceScores = [];
  let recordedVolumeKg = 0;
  let volumeRecordCount = 0;

  snapshot.forEach((detection) => {
    const data = detection.data();
    counts[classifySeverity(data.severity)]++;

    if (typeof data.confidenceScore === "number"
      && Number.isFinite(data.confidenceScore)
      && data.confidenceScore >= 0
      && data.confidenceScore <= 100) {
      confidenceScores.push(data.confidenceScore);
    }

    if (typeof data.wasteVolumeKg === "number"
      && Number.isFinite(data.wasteVolumeKg)
      && data.wasteVolumeKg >= 0) {
      recordedVolumeKg += data.wasteVolumeKg;
      volumeRecordCount++;
    }
  });

  if (countElement) countElement.textContent = snapshot.size.toLocaleString();
  if (confidenceElement) {
    confidenceElement.textContent = confidenceScores.length
      ? `${(confidenceScores.reduce((total, score) => total + score, 0) / confidenceScores.length).toFixed(1)}%`
      : "Not recorded";
  }
  if (statusElement) {
    statusElement.textContent = `Live Firestore data · All cameras · Today (local time) · ${snapshot.size.toLocaleString()} detections`;
  }

  Object.entries(counts).forEach(([severity, count]) => {
    const countElementForSeverity = document.querySelector(`[data-severity-count="${severity}"]`);
    const barElement = document.querySelector(`[data-severity-bar="${severity}"]`);
    if (countElementForSeverity) countElementForSeverity.textContent = formatCount(count);
    if (barElement) {
      const percentage = snapshot.size ? (count / snapshot.size) * 100 : 0;
      barElement.style.width = `${percentage}%`;
    }
  });

  if (volumeElement) {
    volumeElement.textContent = volumeRecordCount
      ? `${recordedVolumeKg.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg`
      : "Not recorded";
  }
  if (volumeNoteElement) {
    volumeNoteElement.textContent = volumeRecordCount
      ? `From ${volumeRecordCount.toLocaleString()} detection record(s) today.`
      : "No recorded waste volume today.";
  }
}

function renderUnavailable(error) {
  console.error("Failed to load today's detections from Firestore:", error);
  if (countElement) countElement.textContent = "Unavailable";
  if (confidenceElement) confidenceElement.textContent = "Unavailable";
  if (statusElement) statusElement.textContent = "Could not load today’s Firestore detections. Check the connection and access permissions.";
  if (volumeElement) volumeElement.textContent = "Unavailable";
  if (volumeNoteElement) volumeNoteElement.textContent = "Could not load recorded waste volume.";

  Object.keys(severityCounts).forEach((severity) => {
    const countElementForSeverity = document.querySelector(`[data-severity-count="${severity}"]`);
    const barElement = document.querySelector(`[data-severity-bar="${severity}"]`);
    if (countElementForSeverity) countElementForSeverity.textContent = "Unavailable";
    if (barElement) barElement.style.width = "0%";
  });
}

const startOfToday = new Date();
startOfToday.setHours(0, 0, 0, 0);
const startOfTomorrow = new Date(startOfToday);
startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);

const detectionsToday = query(
  collection(db, "detections"),
  where("timestamp", ">=", Timestamp.fromDate(startOfToday)),
  where("timestamp", "<", Timestamp.fromDate(startOfTomorrow))
);

onSnapshot(detectionsToday, render, renderUnavailable);

import { db } from "../shared/firebase-config.js";
import {
  collection,
  query,
  where,
  getDocs,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ---------- Helpers ----------
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function setText(elementId, value) {
  const el = document.getElementById(elementId);
  if (el) {
    el.textContent = value;
  } else {
    // Helpful console warning if your HTML id doesn't match yet
    console.warn(`No element found with id="${elementId}" in this page.`);
  }
}

// ---------- Total Detections Today ----------
async function loadTotalDetectionsToday() {
  const q = query(
    collection(db, "reports"),
    where("createdAt", ">=", Timestamp.fromDate(startOfToday()))
  );
  const snapshot = await getDocs(q);
  setText("total-detections", snapshot.size);
}

// ---------- Active Incidents ----------
async function loadActiveIncidents() {
  const q = query(collection(db, "reports"), where("status", "==", "Active"));
  const snapshot = await getDocs(q);
  setText("active-incidents", snapshot.size);
}

// ---------- Resolved Incidents (this month) ----------
async function loadResolvedThisMonth() {
  const q = query(
    collection(db, "reports"),
    where("status", "==", "Resolved"),
    where("createdAt", ">=", Timestamp.fromDate(startOfMonth()))
  );
  const snapshot = await getDocs(q);
  setText("resolved-incidents", snapshot.size);
}

// ---------- Active Cameras (from camera_feeds) ----------
async function loadActiveCameras() {
  const allSnapshot = await getDocs(collection(db, "camera_feeds"));
  const total = allSnapshot.size;

  const onlineQuery = query(
    collection(db, "camera_feeds"),
    where("status", "==", "online")
  );
  const onlineSnapshot = await getDocs(onlineQuery);

  setText("active-cameras", `${onlineSnapshot.size}/${total}`);
}

// ---------- Run everything once the page loads ----------
async function loadDashboard() {
  try {
    await Promise.all([
      loadTotalDetectionsToday(),
      loadActiveIncidents(),
      loadResolvedThisMonth(),
      loadActiveCameras(),
    ]);
  } catch (err) {
    console.error("Failed to load dashboard data:", err);
  }
}

loadDashboard();
import { db } from "../shared/firebase-config.js";
import {
  collection,
  query,
  where,
  getDocs,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ---------- Helpers ----------
function startOfDay(date) {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
}

function getDefaultDateRange() {
  const end = startOfDay(new Date());
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  return { start, end };
}

let selectedDateRange = getDefaultDateRange();

function dateToInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateRange(range) {
  const formatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `${formatter.format(range.start)} - ${formatter.format(range.end)}`;
}

function getEndExclusive(date) {
  const end = startOfDay(date);
  end.setDate(end.getDate() + 1);
  return end;
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

// ---------- Total detections in selected range ----------
async function loadTotalDetections(dateRange) {
  const q = query(
    collection(db, "reports"),
    where("createdAt", ">=", Timestamp.fromDate(dateRange.start)),
    where("createdAt", "<", Timestamp.fromDate(getEndExclusive(dateRange.end)))
  );
  const snapshot = await getDocs(q);
  setText("total-detections", snapshot.size);
}

// ---------- Active Incidents ----------
async function loadActiveIncidents() {
  const q = query(
    collection(db, "reports"),
    where("status", "in", ["Evaluated", "Dispatched"])
  );

  const snapshot = await getDocs(q);

  setText("active-incidents", snapshot.size);
}

// ---------- Resolved incidents in selected range ----------
async function loadResolvedIncidents(dateRange) {
    const q = query(
        collection(db, "reports"),
        where("status", "==", "Resolved"),
    where("resolvedAt", ">=", Timestamp.fromDate(dateRange.start)),
    where("resolvedAt", "<", Timestamp.fromDate(getEndExclusive(dateRange.end)))
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
    where("status", "==", "ONLINE")
  );
  const onlineSnapshot = await getDocs(onlineQuery);

  setText("active-cameras", `${onlineSnapshot.size}/${total}`);
}

// ---------- Run everything once the page loads ----------
async function loadDashboard(dateRange = selectedDateRange) {
  try {
    await Promise.all([
      loadTotalDetections(dateRange),
      loadActiveIncidents(),
      loadResolvedIncidents(dateRange),
      loadActiveCameras(),
    ]);
  } catch (err) {
    console.error("Failed to load dashboard data:", err);
  }
}

const dateRangeDialog = document.getElementById("dateRangeDialog");
const dateRangeForm = document.getElementById("dateRangeForm");
const dateRangeStart = document.getElementById("dateRangeStart");
const dateRangeEnd = document.getElementById("dateRangeEnd");
const dateRangeError = document.getElementById("dateRangeError");
const dateRangeLabel = document.getElementById("dashboardDateRangeLabel");

function showSelectedDateRange() {
  if (dateRangeLabel) dateRangeLabel.textContent = formatDateRange(selectedDateRange);
  if (dateRangeStart) dateRangeStart.value = dateToInputValue(selectedDateRange.start);
  if (dateRangeEnd) dateRangeEnd.value = dateToInputValue(selectedDateRange.end);
}

document.getElementById("openDateRangeDialog")?.addEventListener("click", () => {
  showSelectedDateRange();
  if (dateRangeError) {
    dateRangeError.hidden = true;
    dateRangeError.textContent = "";
  }
  dateRangeDialog?.showModal();
});

function closeDateRangeDialog() {
  dateRangeDialog?.close();
}

document.getElementById("closeDateRangeDialog")?.addEventListener("click", closeDateRangeDialog);
document.getElementById("cancelDateRange")?.addEventListener("click", closeDateRangeDialog);

dateRangeDialog?.addEventListener("click", (event) => {
  if (event.target === dateRangeDialog) closeDateRangeDialog();
});

dateRangeForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const start = startOfDay(new Date(`${dateRangeStart.value}T00:00:00`));
  const end = startOfDay(new Date(`${dateRangeEnd.value}T00:00:00`));

  if (!dateRangeStart.value || !dateRangeEnd.value || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    dateRangeError.textContent = "Choose a valid range where the start date is on or before the end date.";
    dateRangeError.hidden = false;
    return;
  }

  selectedDateRange = { start, end };
  showSelectedDateRange();
  closeDateRangeDialog();
  loadDashboard(selectedDateRange);
});

showSelectedDateRange();
loadDashboard();

function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.getElementById("exportDashboardReport")?.addEventListener("click", () => {
  const rows = [
    ["RiverSight Dashboard Summary", new Date().toLocaleString()],
    ["Selected Date Range", formatDateRange(selectedDateRange)],
    ["Metric", "Current Value"],
    ["Active Cameras", document.getElementById("active-cameras")?.textContent || "N/A"],
    ["Total Detections in Range", document.getElementById("total-detections")?.textContent || "N/A"],
    ["Active Incidents", document.getElementById("active-incidents")?.textContent || "N/A"],
    ["Resolved Incidents in Range", document.getElementById("resolved-incidents")?.textContent || "N/A"]
  ];

  document.querySelectorAll(".dashboard-camera-item").forEach((camera) => {
    rows.push([
      "Camera",
      camera.querySelector(".dashboard-camera-title")?.textContent || "Unknown",
      camera.querySelector(".dashboard-camera-location")?.textContent || "Unknown",
      camera.querySelector(".dashboard-camera-status")?.textContent || "Unknown"
    ]);
  });

  downloadCsv(`riversight-dashboard-${new Date().toISOString().slice(0, 10)}.csv`, rows);
});

document.getElementById("viewAllAlertsBtn")?.addEventListener("click", () => {
  window.location.href = "./Admin-Reports.html#reportFilters";
});
import { db } from "../shared/firebase-config.js";
import { renderSeverityDistribution } from "./severity-distribution.js";
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

function parseReportDate(timestamp) {
  if (!timestamp) return null;

  let date;
  if (typeof timestamp.toDate === "function") {
    date = timestamp.toDate();
  } else if (typeof timestamp.seconds === "number") {
    date = new Date(timestamp.seconds * 1000);
  } else {
    date = new Date(timestamp);
  }

  return Number.isNaN(date.getTime()) ? null : date;
}

function renderDetectionTrend(reports) {
  const svg = document.getElementById("dashboard-detection-trend-svg");
  if (!svg) return;

  const now = new Date();
  const windowStart = now.getTime() - 24 * 60 * 60 * 1000;
  const binDuration = 4 * 60 * 60 * 1000;
  const counts = new Array(6).fill(0);

  reports.forEach((report) => {
    const date = parseReportDate(report.createdAt);
    if (!date || date.getTime() < windowStart || date > now) return;

    const bin = Math.min(5, Math.floor((date.getTime() - windowStart) / binDuration));
    counts[bin]++;
  });

  const maxCount = Math.max(20, Math.ceil(Math.max(...counts) / 10) * 10);
  const midpoint = maxCount / 2;
  const plot = { left: 40, right: 310, top: 16, bottom: 140 };
  const points = counts.map((count, index) => {
    const x = plot.left + (index * (plot.right - plot.left)) / (counts.length - 1);
    const y = plot.bottom - (count / maxCount) * (plot.bottom - plot.top);
    return { x, y, count };
  });
  const linePath = points.map(({ x, y }, index) => `${index === 0 ? "M" : "L"}${x},${y}`).join(" ");
  const areaPath = `${linePath} L${plot.right},${plot.bottom} L${plot.left},${plot.bottom} Z`;
  const xLabels = ["24h ago", "20h ago", "16h ago", "12h ago", "8h ago", "4h ago"];
  const chartDescription = `Detections in six four-hour periods over the last 24 hours: ${counts.join(", ")}.`;

  svg.setAttribute("aria-label", chartDescription);
  svg.innerHTML = `
    <line x1="${plot.left}" y1="${plot.top}" x2="${plot.left}" y2="${plot.bottom}" stroke="#e2e2e2" stroke-width="1"/>
    <line x1="${plot.left}" y1="${plot.bottom}" x2="${plot.right}" y2="${plot.bottom}" stroke="#e2e2e2" stroke-width="1"/>
    <text x="6" y="${plot.top + 4}" class="axis-label">${maxCount}</text>
    <text x="14" y="${(plot.top + plot.bottom) / 2 + 3}" class="axis-label">${midpoint}</text>
    <text x="14" y="${plot.bottom + 3}" class="axis-label">0</text>
    <path d="${areaPath}" fill="#111111" fill-opacity="0.06"/>
    <path d="${linePath}" fill="none" stroke="#111111" stroke-width="2.2"/>
    ${points.map(({ x, y, count }, index) => `
      <circle cx="${x}" cy="${y}" r="3" fill="#111111">
        <title>${xLabels[index]}: ${count} detections</title>
      </circle>
      <text x="${x}" y="158" class="axis-label" text-anchor="middle">${xLabels[index]}</text>
    `).join("")}
  `;
}

// ---------- Total detections in selected range ----------
async function loadTotalDetections(dateRange) {
  const periodDays = Math.round((dateRange.end - dateRange.start) / 86400000) + 1;
  const previousEnd = new Date(dateRange.start);
  previousEnd.setDate(previousEnd.getDate() - 1);
  const previousStart = new Date(previousEnd);
  previousStart.setDate(previousStart.getDate() - periodDays + 1);

  const countReports = async (range) => {
    const q = query(
      collection(db, "reports"),
      where("createdAt", ">=", Timestamp.fromDate(range.start)),
      where("createdAt", "<", Timestamp.fromDate(getEndExclusive(range.end)))
    );
    const snapshot = await getDocs(q);
    return snapshot.size;
  };

  const [currentCount, previousCount] = await Promise.all([
    countReports(dateRange),
    countReports({ start: previousStart, end: previousEnd }),
  ]);

  setText("total-detections", currentCount);

  const change = document.getElementById("detection-change");
  const comparisonNote = document.getElementById("detection-comparison-note");
  if (!change) return;

  change.className = "stat-sub muted";
  if (previousCount === 0) {
    change.textContent = currentCount === 0 ? "No change" : "New";
  } else {
    const percentChange = Math.round(((currentCount - previousCount) / previousCount) * 100);
    if (percentChange > 0) {
      change.textContent = `↑ ${percentChange}%`;
      change.className = "stat-sub good";
    } else if (percentChange < 0) {
      change.textContent = `↓ ${Math.abs(percentChange)}%`;
      change.className = "stat-sub down";
    } else {
      change.textContent = "No change";
    }
  }

  if (comparisonNote) {
    comparisonNote.textContent = `vs. previous ${periodDays} ${periodDays === 1 ? "day" : "days"}`;
  }
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

async function loadReportVisualizations() {
  const snapshot = await getDocs(collection(db, "reports"));
  const reports = snapshot.docs.map((report) => report.data());
  const donut = document.getElementById("dashboard-severity-donut-svg");
  renderSeverityDistribution(donut, reports);
  renderDetectionTrend(reports);
}

// ---------- Run everything once the page loads ----------
async function loadDashboard(dateRange = selectedDateRange) {
  try {
    await Promise.all([
      loadTotalDetections(dateRange),
      loadActiveIncidents(),
      loadResolvedIncidents(dateRange),
      loadActiveCameras(),
      loadReportVisualizations(),
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
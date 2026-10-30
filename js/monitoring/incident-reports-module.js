import { db } from "../shared/firebase-config.js";
import {
  collection,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

/*
  Incident Reports, live from Firestore.
  Sources: `reports`, `incidents` (created in Incident Evaluation), and
  `detections` that have not become an incident yet.
*/

const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_WEEKS = 4;   // Wk 1 = oldest week, Wk 4 = most recent 7 days
const DONUT_DAYS = 30;   // window for the severity donut
const PLASTIC_WORDS = ["plastic", "poly", "bottle", "bag", "styrofoam"];
const CHART = { bottom: 180, plotHeight: 150, xStart: 42, xStep: 120, barWidth: 26 };
const STATUS_CLASS = { Detected: "evaluated", Dismissed: "resolved" };

const state = { reports: [], incidents: [], detections: [] };

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normSeverity(value) {
  const s = String(value || "").toLowerCase();
  if (["critical", "severe", "high"].includes(s)) return "SEVERE";
  if (s === "medium") return "MEDIUM";
  return "NORMAL";
}

function normStatus(value) {
  if (!value) return "Resolved";
  const s = String(value).toLowerCase();
  if (["resolved", "closed", "completed", "cleaned"].includes(s)) return "Resolved";
  if (["escalated", "notified", "dispatched", "sent"].includes(s)) return "Dispatched";
  if (["flagged", "evaluated", "reviewed", "pending", "review"].includes(s)) return "Evaluated";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function toRow(docSnap, source) {
  const d = docSnap.data();
  const shortId = docSnap.id.slice(0, 8);
  let status;
  if (source === "detection") {
    status = d.protocolAction === "dismiss_false_positive" ? "Dismissed"
      : d.reviewed ? "Evaluated" : "Detected";
  } else {
    status = normStatus(d.status);
  }
  const fallbackLabel = source === "incident" ? `INC-${shortId}`
    : source === "detection" ? `DET-${shortId}` : shortId;

  return {
    docId: docSnap.id,
    detectionId: d.detectionId || null,
    source,
    label: d.reportId || fallbackLabel,
    date: toDate(d.createdAt || d.timestamp),
    location: d.location || d.locationNode || d.cameraId || "PH-MNL-QC",
    type: d.detectionType || d.materialType || (source === "detection" ? "Waste Detection" : "Camera Detection"),
    severity: normSeverity(d.severity),
    status
  };
}

function buildRows() {
  // A detection that already became an incident/report is shown once, as the incident.
  const linked = new Set();
  [...state.reports, ...state.incidents].forEach((r) => {
    if (r.detectionId) linked.add(r.detectionId);
  });
  const detections = state.detections.filter((r) => !linked.has(r.docId));

  return [...state.reports, ...state.incidents, ...detections]
    .sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));
}

function renderSummary(rows) {
  const totalElem = document.getElementById("totalDetectionsCount");
  const activeElem = document.getElementById("activeIncidentsCount");

  if (totalElem) totalElem.textContent = rows.length;

  if (activeElem) {
    const active = rows.filter((r) => r.source !== "detection" && r.status !== "Resolved").length;
    activeElem.innerHTML = active === 0
      ? `0 <span class="stat-sub good">Clear</span>`
      : `${active} <span class="stat-sub warn">Active</span>`;
  }
}

function renderTrends(rows) {
  const svg = document.querySelector(".trend-chart");
  const linesGroup = document.getElementById("chartGroupLines");
  const barsGroup = document.getElementById("chartGroupBars");
  if (!svg || !linesGroup || !barsGroup) return;

  const plastic = new Array(TREND_WEEKS).fill(0);
  const organic = new Array(TREND_WEEKS).fill(0);
  const now = Date.now();

  rows.forEach((r) => {
    if (!r.date) return;
    const daysAgo = Math.max(0, Math.floor((now - r.date.getTime()) / DAY_MS));
    if (daysAgo >= TREND_WEEKS * 7) return;
    const index = TREND_WEEKS - 1 - Math.floor(daysAgo / 7);
    const type = r.type.toLowerCase();
    (PLASTIC_WORDS.some((w) => type.includes(w)) ? plastic : organic)[index]++;
  });

  const yMax = Math.max(5, ...plastic, ...organic);
  const x = (i) => CHART.xStart + i * CHART.xStep;
  const y = (v) => CHART.bottom - (v / yMax) * CHART.plotHeight;
  const toPath = (values) => values.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(" ");

  const paths = linesGroup.querySelectorAll("path");
  if (paths[0]) paths[0].setAttribute("d", toPath(plastic));
  if (paths[1]) paths[1].setAttribute("d", toPath(organic));

  barsGroup.replaceChildren();
  const ns = "http://www.w3.org/2000/svg";
  const addBar = (xPos, value, fill) => {
    const height = (value / yMax) * CHART.plotHeight;
    const rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", xPos);
    rect.setAttribute("y", CHART.bottom - height);
    rect.setAttribute("width", CHART.barWidth);
    rect.setAttribute("height", height);
    rect.setAttribute("fill", fill);
    barsGroup.appendChild(rect);
  };
  plastic.forEach((v, i) => addBar(x(i) - CHART.barWidth - 1, v, "#2f6fd6"));
  organic.forEach((v, i) => addBar(x(i) + 1, v, "#1a9e57"));

  const maxLabel = svg.querySelector("text[data-max-label]")
    || [...svg.querySelectorAll("text")].find((t) => t.textContent.trim() === "Max");
  if (maxLabel) {
    maxLabel.dataset.maxLabel = "1";
    maxLabel.textContent = String(yMax);
  }
}

function renderDonut(rows) {
  const circles = document.querySelectorAll(".donut circle");
  const center = document.getElementById("donutPercentage");
  if (circles.length < 3) return;

  const cutoff = Date.now() - DONUT_DAYS * DAY_MS;
  const recent = rows.filter((r) => r.date && r.date.getTime() >= cutoff);
  const counts = { NORMAL: 0, MEDIUM: 0, SEVERE: 0 };
  recent.forEach((r) => { counts[r.severity]++; });

  const total = recent.length;
  const shares = total
    ? [counts.NORMAL, counts.MEDIUM, counts.SEVERE].map((n) => (n / total) * 100)
    : [100, 0, 0];

  let used = 0;
  circles.forEach((circle, i) => {
    circle.setAttribute("pathLength", "100");
    circle.setAttribute("stroke-dasharray", `${shares[i]} ${100 - shares[i]}`);
    circle.setAttribute("stroke-dashoffset", String(25 - used));
    used += shares[i];
  });

  if (center) center.textContent = total ? `${Math.round((counts.SEVERE / total) * 100)}%` : "0%";
}

function renderTable(rows) {
  const tableBody = document.getElementById("incidentTableBody");
  if (!tableBody) return;

  const severity = document.getElementById("severitySelect")?.value || "ALL";
  const status = document.getElementById("statusSelect")?.value || "ALL";

  const visible = rows.filter((r) =>
    (severity === "ALL" || r.severity === severity.toUpperCase()) &&
    (status === "ALL" || r.status.toLowerCase() === status.toLowerCase())
  ).slice(0, 200);

  if (!visible.length) {
    tableBody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 1.5rem; color: #6b7280;">No reports found matching criteria.</td></tr>`;
    return;
  }

  tableBody.innerHTML = visible.map((r) => {
    const dateText = r.date
      ? r.date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : "N/A";
    const statusClass = (STATUS_CLASS[r.status] || r.status.toLowerCase()).replace(/\s+/g, "-");
    return `
      <tr>
        <td><strong>${esc(r.label)}</strong><br><small style="color: #6b7280;">${esc(dateText)}</small></td>
        <td>${esc(r.location)}</td>
        <td>${esc(r.type)}</td>
        <td><span class="badge severity-${r.severity.toLowerCase()}">${esc(r.severity)}</span></td>
        <td><span class="badge status-${esc(statusClass)}">${esc(r.status)}</span></td>
        <td></td>
      </tr>`;
  }).join("");
}

function renderAll() {
  const rows = buildRows();
  renderSummary(rows);
  renderTrends(rows);
  renderDonut(rows);
  renderTable(rows);
}

function initControls() {
  const statusSelect = document.getElementById("statusSelect");
  if (statusSelect) {
    ["Detected", "Dismissed"].forEach((label) => {
      if (![...statusSelect.options].some((o) => o.value === label)) {
        statusSelect.add(new Option(`Status: ${label}`, label));
      }
    });
  }

  document.getElementById("severitySelect")?.addEventListener("change", renderAll);
  statusSelect?.addEventListener("change", renderAll);

  const btnLines = document.getElementById("btnShowLines");
  const btnBars = document.getElementById("btnShowBars");
  const linesGroup = document.getElementById("chartGroupLines");
  const barsGroup = document.getElementById("chartGroupBars");

  btnLines?.addEventListener("click", () => {
    btnLines.classList.add("active");
    btnBars?.classList.remove("active");
    if (linesGroup) linesGroup.style.display = "";
    if (barsGroup) barsGroup.style.display = "none";
  });

  btnBars?.addEventListener("click", () => {
    btnBars.classList.add("active");
    btnLines?.classList.remove("active");
    if (linesGroup) linesGroup.style.display = "none";
    if (barsGroup) barsGroup.style.display = "";
  });
}

function listen(collectionName, key, source) {
  onSnapshot(collection(db, collectionName), (snapshot) => {
    state[key] = snapshot.docs.map((docSnap) => toRow(docSnap, source));
    renderAll();
  }, (error) => {
    console.error(`Error streaming ${collectionName}:`, error);
    const tableBody = document.getElementById("incidentTableBody");
    if (tableBody && !tableBody.children.length) {
      tableBody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #ef4444; padding: 1.5rem;">Failed to stream records.</td></tr>`;
    }
  });
}

function init() {
  initControls();
  listen("reports", "reports", "report");
  listen("incidents", "incidents", "incident");
  listen("detections", "detections", "detection");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
import { auth, db as sharedDb } from "../shared/firebase-config.js";

import { 
  collection, 
  onSnapshot, 
  query, 
  orderBy,
  initializeFirestore
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let db = sharedDb; 
let currentReportsData = []; 

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", verifyAndInitializeApp);
} else {
  verifyAndInitializeApp();
}

function verifyAndInitializeApp() {
  console.log("RiverSight Report Engine Running. Core DB Hook state:", db ? "Connected" : "Requires Recovery Injection");

  if (!db && auth && auth.app) {
    try {
      console.warn("Attempting Long Polling fallback interface injection...");
      db = initializeFirestore(auth.app, { experimentalForceLongPolling: true });
    } catch (fallbackErr) {
      console.error("Critical error during database reconstruction:", fallbackErr);
    }
  }

  if (!db) {
    console.error("Database initialization totally failed. Check imports in firebase-config.js");
    return;
  }

  initializeReportsListener();
  setupControlListeners();
}

function initializeReportsListener() {
  const tableBody = document.getElementById("incidentTableBody");
  if (!tableBody) return;

  try {
    const targetCollection = collection(db, "reports");
    const baseQuery = query(targetCollection, orderBy("timestamp", "desc"));

    console.log("Subscribing to Firestore updates...");
    
    onSnapshot(baseQuery, (snapshot) => {
      console.log(`Snapshot active. Pulled ${snapshot.size} valid record nodes.`);
      currentReportsData = [];
      
      snapshot.forEach((doc) => {
        const data = doc.data();
        currentReportsData.push({
          id: doc.id,
          reportId: data.reportId || `EV-${doc.id.substring(0, 4).toUpperCase()}`,
          dateText: data.dateText || data.evaluatedAt || "Just now",
          location: data.location || "Unknown Sector",
          detectionType: data.detectionType || "Evaluated Incident",
          confidence: data.confidence ? parseFloat(data.confidence) : 100,
          severity: (data.severity || "LOW").toUpperCase(),
          status: data.status || "Evaluated",
          timestamp: data.timestamp 
        });
      });

      processAndRenderDashboard();
    }, (error) => {
      console.error("Firestore Snapshot stream encountered an error:", error);
    });
  } catch (err) {
    console.error("Initialization error inside collection query engine:", err);
  }
}

function processAndRenderDashboard() {
  const tableBody = document.getElementById("incidentTableBody");
  if (!tableBody) return;

  const searchInput = document.querySelector('input[type="search"], input[placeholder*="Search"]');
  const searchVal = searchInput ? searchInput.value.toLowerCase() : "";
  
  const severityFilter = getDropdownValue("severity");
  const statusFilter = getDropdownValue("status");

  let filtered = currentReportsData.filter(item => {
    const matchesSearch = item.reportId.toLowerCase().includes(searchVal) || 
                          item.location.toLowerCase().includes(searchVal) || 
                          item.detectionType.toLowerCase().includes(searchVal);

    const matchesSeverity = severityFilter === "ALL" || item.severity === severityFilter;
    const matchesStatus = statusFilter === "ALL" || item.status === statusFilter;

    return matchesSearch && matchesSeverity && matchesStatus;
  });

  tableBody.innerHTML = "";
  
  let activeCount = 0;
  let totalCount = filtered.length;
  let resolvedCount = 0;
  let severityCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  let weeklyTrends = { plastic: [0, 0, 0, 0], organic: [0, 0, 0, 0] };

  if (filtered.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:2rem; color:var(--muted);">No matching reports found.</td></tr>`;
    updateDashboardMetrics(0, 0, 0, severityCounts, weeklyTrends);
    return;
  }

  filtered.forEach((item) => {
    if (item.status === "Resolved") resolvedCount++;
    else activeCount++;

    if (severityCounts[item.severity] !== undefined) {
      severityCounts[item.severity]++;
    }

    if (item.timestamp) {
      const docDate = item.timestamp.toDate ? item.timestamp.toDate() : new Date(item.timestamp);
      const day = docDate.getDate();
      let weekIdx = Math.min(Math.floor((day - 1) / 7), 3);
      
      if (item.detectionType.toLowerCase().includes("plastic") || item.detectionType.toLowerCase().includes("trash")) {
        weeklyTrends.plastic[weekIdx]++;
      } else {
        weeklyTrends.organic[weekIdx]++;
      }
    }

    let dotColor = "green";
    if (item.severity === "CRITICAL" || item.severity === "HIGH") dotColor = "red";
    else if (item.severity === "MEDIUM") dotColor = "orange";

    let statusDotColor = "gray";
    if (item.status === "Resolved") statusDotColor = "green";
    if (item.status === "Dispatched") statusDotColor = "blue";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <div class="report-id">${item.reportId}</div>
        <div class="report-date">${item.dateText}</div>
      </td>
      <td><span class="status-dot ${dotColor} inline"></span>${item.location}</td>
      <td>
        <div class="detect-type">${item.detectionType}</div>
        <div class="detect-conf good">${item.confidence}% Confidence</div>
      </td>
      <td><span class="severity-pill ${item.severity.toLowerCase()}">${item.severity}</span></td>
      <td><span class="status-text ${statusDotColor}"><i class="dot dot-${statusDotColor}"></i>${item.status}</span></td>
      <td class="action-cell">
        <button class="kebab-btn">
          <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
        </button>
      </td>
    `;
    tableBody.appendChild(tr);
  });

  updateDashboardMetrics(activeCount, totalCount, resolvedCount, severityCounts, weeklyTrends);
}

function updateDashboardMetrics(active, total, resolved, severities, trends) {
  const activeCountLabel = document.getElementById("activeIncidentsCount");
  const totalCountLabel = document.getElementById("totalDetectionsCount");
  const successRateLabel = document.getElementById("cleanupSuccessRate");
  const successProgressBar = document.getElementById("cleanupProgressBar");
  const donutCenterLabel = document.getElementById("donutPercentage");

  if (totalCountLabel) totalCountLabel.textContent = total.toLocaleString();

  if (activeCountLabel) {
    activeCountLabel.innerHTML = active > 0 
      ? `${active} <span class="stat-sub pill-red">HIGH RISK</span>`
      : `0 <span class="stat-sub good">CLEAR</span>`;
  }

  const successRate = total > 0 ? Math.round((resolved / total) * 100) : 100;
  if (successRateLabel) successRateLabel.innerHTML = `${successRate}% <span class="stat-sub good">Live</span>`;
  if (successProgressBar) successProgressBar.style.width = `${successRate}%`;

  const urgentCount = severities.CRITICAL + severities.HIGH;
  const urgentPercent = total > 0 ? Math.round((urgentCount / total) * 100) : 0;
  if (donutCenterLabel) donutCenterLabel.textContent = `${urgentPercent}%`;

  const circles = document.querySelectorAll(".donut circle");
  if (circles.length === 4) {
    const totalCircleLen = 100;
    let pMedium = total > 0 ? (severities.MEDIUM / total) * totalCircleLen : 25;
    let pLow = total > 0 ? (severities.LOW / total) * totalCircleLen : 25;
    let pHigh = total > 0 ? (severities.HIGH / total) * totalCircleLen : 25;
    let pCritical = total > 0 ? (severities.CRITICAL / total) * totalCircleLen : 25;

    circles[0].setAttribute("stroke-dasharray", `${pMedium} ${totalCircleLen - pMedium}`);
    circles[1].setAttribute("stroke-dasharray", `${pLow} ${totalCircleLen - pLow}`);
    circles[1].setAttribute("stroke-dashoffset", `-${pMedium}`);
    circles[2].setAttribute("stroke-dasharray", `${pHigh} ${totalCircleLen - pHigh}`);
    circles[2].setAttribute("stroke-dashoffset", `-${pMedium + pLow}`);
    circles[3].setAttribute("stroke-dasharray", `${pCritical} ${totalCircleLen - pCritical}`);
    circles[3].setAttribute("stroke-dashoffset", `-${pMedium + pLow + pHigh}`);
  }

  const maxVal = Math.max(...trends.plastic, ...trends.organic, 5);
  const xCoords = [34, 150, 270, 390];

  const chartPaths = document.querySelectorAll("#chartGroupLines path");
  if (chartPaths.length >= 2) {
    const getLinePath = (dataPoints) => {
      const points = dataPoints.map((val, i) => ({
        x: xCoords[i],
        y: 180 - ((val / maxVal) * 140)
      }));
      return `M${points[0].x},${points[0].y} L${points[1].x},${points[1].y} L${points[2].x},${points[2].y} L${points[3].x},${points[3].y}`;
    };

    chartPaths[0].setAttribute("d", getLinePath(trends.plastic));
    chartPaths[1].setAttribute("d", getLinePath(trends.organic));
  }

  const chartBarsGroup = document.getElementById("chartGroupBars");
  if (chartBarsGroup) {
    const xOffsets = [55, 165, 285, 405];
    let barsHTML = "";

    xOffsets.forEach((x, i) => {
      const plasticVal = trends.plastic[i];
      const organicVal = trends.organic[i];

      const pHeight = (plasticVal / maxVal) * 140;
      const oHeight = (organicVal / maxVal) * 140;

      const pY = 180 - pHeight;
      const oY = 180 - oHeight;

      barsHTML += `<rect x="${x}" y="${pY}" width="16" height="${pHeight}" fill="#2f6fd6" rx="3"/>`;

      barsHTML += `<rect x="${x + 20}" y="${oY}" width="16" height="${oHeight}" fill="#1a9e57" rx="3"/>`;
    });

    chartBarsGroup.innerHTML = barsHTML;
  }
}

function getDropdownValue(type) {
  const selects = Array.from(document.querySelectorAll("select"));
  let selectEl = null;

  if (type === "severity") {
    selectEl = selects.find(s => s.id.toLowerCase().includes("severity") || s.name.toLowerCase().includes("severity")) || selects[0];
  } else {
    selectEl = selects.find(s => s.id.toLowerCase().includes("status") || s.name.toLowerCase().includes("status")) || selects[1];
  }

  if (selectEl && selectEl.value) {
    if (type === "severity") {
      const val = selectEl.value.toUpperCase();
      return val.includes("ALL") ? "ALL" : val;
    } else {
      return selectEl.value === "ALL" || selectEl.value.toUpperCase().includes("ALL") ? "ALL" : selectEl.value;
    }
  }
  
  return "ALL";
}

function setupControlListeners() {
  const searchInput = document.querySelector('input[type="search"], input[placeholder*="Search"]');
  if (searchInput) {
    searchInput.addEventListener("input", processAndRenderDashboard);
  }

  document.querySelectorAll("select").forEach(dropdown => {
    dropdown.addEventListener("change", processAndRenderDashboard);
  });

  const btnShowLines = document.getElementById('btnShowLines');
  const btnShowBars = document.getElementById('btnShowBars');
  const chartLines = document.getElementById('chartGroupLines');
  const chartBars = document.getElementById('chartGroupBars');

  if (btnShowLines && btnShowBars && chartLines && chartBars) {
    btnShowLines.addEventListener('click', () => {
      btnShowLines.classList.add('active');
      btnShowBars.classList.remove('active');
      chartLines.style.display = 'block';
      chartBars.style.display = 'none';
    });

    btnShowBars.addEventListener('click', () => {
      btnShowBars.classList.add('active');
      btnShowLines.classList.remove('active');
      chartLines.style.display = 'none';
      chartBars.style.display = 'block';
    });
  }

  const allButtons = Array.from(document.querySelectorAll("button"));
  
  const csvBtn = allButtons.find(el => el.textContent.trim().toUpperCase().includes("EXPORT CSV"));
  if (csvBtn) csvBtn.addEventListener("click", exportToCSV);

  const pdfBtn = allButtons.find(el => el.textContent.trim().toUpperCase().includes("EXPORT PDF"));
  if (pdfBtn) pdfBtn.addEventListener("click", exportToPDF);
}

function exportToCSV() {
  if (currentReportsData.length === 0) {
    alert("No data available to export.");
    return;
  }

  const headers = ["Report ID", "Timestamp/Date", "Location Node", "Detection Type", "Confidence Rating", "Severity Level", "Status"];
  const csvRows = [headers.join(",")];

  currentReportsData.forEach(item => {
    const fields = [
      `"${item.reportId}"`,
      `"${item.dateText}"`,
      `"${item.location}"`,
      `"${item.detectionType}"`,
      `"${item.confidence}%"`,
      `"${item.severity}"`,
      `"${item.status}"`
    ];
    csvRows.push(fields.join(","));
  });

  const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `Incident_Log_Report_${new Date().toISOString().split('T')[0]}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function exportToPDF() {
  window.print();
}
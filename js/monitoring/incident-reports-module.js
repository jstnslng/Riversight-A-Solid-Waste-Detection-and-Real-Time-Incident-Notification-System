import { db } from "../shared/firebase-config.js";
import {
  collection,
  query,
  orderBy,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

document.addEventListener("DOMContentLoaded", () => {
  initSummaryCards();
  initWasteTrendsChart();
  initIncidentArchiveTable();
});

export function initSummaryCards() {
  const totalDetectionsElem = document.getElementById("totalDetectionsCount");
  const activeIncidentsElem = document.getElementById("activeIncidentsCount");

  onSnapshot(collection(db, "reports"), (snapshot) => {
    let activeCount = 0;

    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      if (data.status && data.status.toLowerCase() !== "resolved") {
        activeCount++;
      }
    });

    if (totalDetectionsElem) {
      totalDetectionsElem.textContent = snapshot.size;
    }

    if (activeIncidentsElem) {
      if (activeCount === 0) {
        activeIncidentsElem.innerHTML = `0 <span class="stat-sub good">Clear</span>`;
      } else {
        activeIncidentsElem.innerHTML = `${activeCount} <span class="stat-sub warn">Active</span>`;
      }
    }
  }, (error) => {
    console.error("Error streaming summary counts:", error);
  });
}

export function initWasteTrendsChart() {
  const chartGroupLines = document.getElementById("chartGroupLines");
  const chartGroupBars = document.getElementById("chartGroupBars");
  const btnShowLines = document.getElementById("btnShowLines");
  const btnShowBars = document.getElementById("btnShowBars");

  onSnapshot(collection(db, "reports"), (querySnapshot) => {
    const weeklyData = {
      plastic: [0, 0, 0, 0],
      organic: [0, 0, 0, 0]
    };

    querySnapshot.forEach((docSnap) => {
      const data = docSnap.data();
      if (data.createdAt) {
        const date = data.createdAt.toDate();
        const day = date.getDate();

        const weekIndex = Math.min(Math.floor((day - 1) / 7), 3);
        const type = (data.detectionType || "").toLowerCase();

        if (type.includes("plastic")) {
          weeklyData.plastic[weekIndex] += 1;
        } else {
          weeklyData.organic[weekIndex] += 1;
        }
      }
    });

    if (btnShowLines && btnShowBars && chartGroupLines && chartGroupBars) {
      btnShowLines.onclick = () => {
        btnShowLines.classList.add("active");
        btnShowBars.classList.remove("active");
        chartGroupLines.style.display = "block";
        chartGroupBars.style.display = "none";
      };

      btnShowBars.onclick = () => {
        btnShowBars.classList.add("active");
        btnShowLines.classList.remove("active");
        chartGroupLines.style.display = "none";
        chartGroupBars.style.display = "block";
      };
    }
  }, (error) => {
    console.error("Error streaming Waste Detection Trends:", error);
  });
}

export function initIncidentArchiveTable() {
  const tableBody = document.getElementById("incidentTableBody");
  if (!tableBody) return;

  const severityFilter = document.getElementById("severitySelect");
  const statusFilter = document.getElementById("statusSelect");

  const q = query(collection(db, "reports"), orderBy("createdAt", "desc"));

  onSnapshot(q, (querySnapshot) => {
    const selectedSeverity = severityFilter ? severityFilter.value : "ALL";
    const selectedStatus = statusFilter ? statusFilter.value : "ALL";

    tableBody.innerHTML = "";

    let count = 0;
    querySnapshot.forEach((docSnap) => {
      const item = docSnap.data();

      if (selectedSeverity !== "ALL" && (item.severity || "").toLowerCase() !== selectedSeverity.toLowerCase()) {
        return;
      }
      if (selectedStatus !== "ALL" && (item.status || "").toLowerCase() !== selectedStatus.toLowerCase()) {
        return;
      }

      count++;
      const row = document.createElement("tr");

      const formattedDate = item.createdAt 
        ? item.createdAt.toDate().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : "N/A";

      const severityClass = (item.severity || "normal").toLowerCase();
      const statusClass = (item.status || "resolved").toLowerCase();

      row.innerHTML = `
        <td><strong>${item.reportId || docSnap.id.substring(0, 8)}</strong><br><small style="color: #6b7280;">${formattedDate}</small></td>
        <td>${item.location || "PH-MNL-QC"}</td>
        <td>${item.detectionType || "Camera Detection"}</td>
        <td><span class="badge severity-${severityClass}">${item.severity || "NORMAL"}</span></td>
        <td><span class="badge status-${statusClass}">${item.status || "Resolved"}</span></td>
        <td></td>
      `;

      tableBody.appendChild(row);
    });

    if (count === 0) {
      tableBody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 1.5rem; color: #6b7280;">No reports found matching criteria.</td></tr>`;
    }
  }, (error) => {
    console.error("Error streaming archive table:", error);
    tableBody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #ef4444; padding: 1.5rem;">Failed to stream records.</td></tr>`;
  });

  if (severityFilter) severityFilter.addEventListener("change", () => initIncidentArchiveTable());
  if (statusFilter) statusFilter.addEventListener("change", () => initIncidentArchiveTable());
}
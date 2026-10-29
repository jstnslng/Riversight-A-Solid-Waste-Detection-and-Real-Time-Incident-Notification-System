import { db } from "./firebase-config.js";
import { collection, query, orderBy, limit, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

document.addEventListener("DOMContentLoaded", () => {
  initGlobalSearch();
});

// Detect whether user is currently in the Admin Portal or Monitoring Portal
const isAdminPath = window.location.pathname.includes("/admin/");

// STRICT ROLE ISOLATION: Admin index ONLY contains Admin pages; Monitoring ONLY contains Monitoring pages
const ADMIN_NAVIGATION_INDEX = [
  {
    title: "Administrator Dashboard",
    category: "Admin Portal",
    description: "GIS map preview, active nodes, system health, recent AI detections",
    url: "Admin-Dashboard.html",
    keywords: ["admin", "dashboard", "control", "overview", "gis", "map", "system health"]
  },
  {
    title: "User Management",
    category: "Admin Portal",
    description: "Manage accounts, assigned sectors, roles, active users, invites",
    url: "UserManagement.html",
    keywords: ["user", "management", "users", "accounts", "roles", "administrator", "monitoring", "add user", "sector"]
  },
  {
    title: "Admin Reports Center",
    category: "Admin Portal",
    description: "Comprehensive system logs, monthly reports, export Excel/PDF/CSV",
    url: "Admin-Reports.html",
    keywords: ["reports", "reports center", "export excel", "pdf", "csv", "summary", "monthly reports"]
  },
  {
    title: "System Monitoring & Cameras",
    category: "Admin Portal",
    description: "Manage connected cameras, add camera, RTSP embed URLs, system health",
    url: "Admin-System-Monitoring.html",
    keywords: ["system monitoring", "camera management", "add camera", "camera health", "rtsp", "ip address", "status"]
  },
  {
    title: "Audit Trail & Activity Logs",
    category: "Admin Portal",
    description: "System activity logs, login events, user actions, profile edits",
    url: "Admin-Audit-Trail.html",
    keywords: ["audit", "trail", "audit trail", "logs", "activity", "login events", "actions", "failed actions"]
  },
  {
    title: "Administrator Settings",
    category: "Admin Portal",
    description: "Theme preferences, font size, email & system alert toggles",
    url: "Admin-Settings.html",
    keywords: ["settings", "admin settings", "appearance", "theme", "dark mode", "notifications", "security"]
  },
  {
    title: "Administrator Profile",
    category: "Admin Portal",
    description: "Admin account details, username, email, change password",
    url: "Admin-Profile.html",
    keywords: ["profile", "admin profile", "password", "change password", "account", "user id"]
  }
];

const MONITORING_NAVIGATION_INDEX = [
  {
    title: "Live Monitoring Module",
    category: "Monitoring Console",
    description: "Live CCTV streams, active camera feeds, sector status",
    url: "Live-Monitoring.html",
    keywords: ["live", "monitoring", "camera", "cctv", "stream", "video", "feed", "sector", "ph-mnl-qc"]
  },
  {
    title: "Waste Detection & Management",
    category: "Monitoring Console",
    description: "AI waste classification, volume metrics, detection summary, segmentation",
    url: "Waste-Management.html",
    keywords: ["waste", "detection", "detection summary", "plastic", "organic", "volume", "ai", "segmentation"]
  },
  {
    title: "Incident Evaluation Console",
    category: "Monitoring Console",
    description: "Active incident analysis, protocol actions, incident data, LGU escalation stepper",
    url: "Incident-Evaluation.html",
    keywords: ["incident", "evaluation", "incident data", "protocol", "escalation", "lgu", "alert", "console", "sub-events"]
  },
  {
    title: "Incident Reports & Analytics",
    category: "Monitoring Console",
    description: "Performance metrics, detection trends, archive database, export PDF/CSV",
    url: "Incident-Reports.html",
    keywords: ["reports", "analytics", "archive", "trends", "history", "stats", "export"]
  },
  {
    title: "Camera Feed: CAM-001 (North Inlet)",
    category: "Camera Node",
    description: "Main Creek North camera stream • Active",
    url: "Live-Monitoring.html?cam=cam-001",
    keywords: ["cam-001", "cam001", "camera 1", "north inlet", "buwaya creek north"]
  },
  {
    title: "Camera Feed: CAM-002 (South Dam)",
    category: "Camera Node",
    description: "South Waterway Dam stream • Active",
    url: "Live-Monitoring.html?cam=cam-002",
    keywords: ["cam-002", "cam002", "camera 2", "south dam"]
  },
  {
    title: "Alert Configuration & Thresholds",
    category: "Console Settings",
    description: "Volume trigger threshold, required confidence, sensitivity settings",
    url: "Incident-Evaluation.html#alert-config",
    keywords: ["alert configuration", "detection volume trigger", "confidence required", "sensitivity", "threshold"]
  }
];

export function initGlobalSearch() {
  let searchInput = document.getElementById("globalSearchInput") || document.querySelector(".search-wrap input");
  if (!searchInput) return;

  if (!searchInput.id) searchInput.id = "globalSearchInput";

  let resultsContainer = document.getElementById("globalSearchResults");
  if (!resultsContainer) {
    resultsContainer = document.createElement("div");
    resultsContainer.id = "globalSearchResults";
    resultsContainer.className = "global-search-results";
    searchInput.parentNode.appendChild(resultsContainer);
  }

  // Active navigation index based purely on current role portal
  const activeNavigationIndex = isAdminPath ? ADMIN_NAVIGATION_INDEX : MONITORING_NAVIGATION_INDEX;

  let reportsCache = [];

  // Non-blocking Firestore listener for Incident Reports
  try {
    if (db) {
      const q = query(collection(db, "reports"), orderBy("createdAt", "desc"), limit(50));
      onSnapshot(q, (snapshot) => {
        reportsCache = snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
      }, () => {});
    }
  } catch (e) {
    // Fail-safe suppress
  }

  searchInput.addEventListener("input", (e) => {
    const searchTerm = e.target.value.trim().toLowerCase();

    if (!searchTerm) {
      resultsContainer.style.display = "none";
      resultsContainer.innerHTML = "";
      return;
    }

    // Filter ONLY the current portal's navigation index
    const matchedSystemItems = activeNavigationIndex.filter(item => {
      return item.title.toLowerCase().includes(searchTerm) ||
             item.description.toLowerCase().includes(searchTerm) ||
             item.category.toLowerCase().includes(searchTerm) ||
             item.keywords.some(kw => kw.includes(searchTerm));
    });

    // Filter Firestore Reports
    const matchedReports = reportsCache.filter(item => {
      const rId = (item.reportId || item.id || "").toLowerCase();
      const loc = (item.location || "").toLowerCase();
      const typ = (item.detectionType || "").toLowerCase();
      const sev = (item.severity || "").toLowerCase();
      return rId.includes(searchTerm) || loc.includes(searchTerm) || typ.includes(searchTerm) || sev.includes(searchTerm);
    });

    renderSearchResults(matchedSystemItems, matchedReports, resultsContainer);
  });

  document.addEventListener("click", (e) => {
    if (!searchInput.contains(e.target) && !resultsContainer.contains(e.target)) {
      resultsContainer.style.display = "none";
    }
  });
}

function renderSearchResults(systemItems, reports, container) {
  if (systemItems.length === 0 && reports.length === 0) {
    container.innerHTML = `<div style="padding: 12px; font-size: 0.85rem; color: #6b7280; text-align: center;">No matching system pages or records found.</div>`;
    container.style.display = "block";
    return;
  }

  let html = "";

  if (systemItems.length > 0) {
    const sectionHeader = isAdminPath ? "Admin System Navigation" : "Monitoring Navigation & Modules";
    html += `<div style="padding: 6px 12px; font-size: 0.7rem; font-weight: 700; color: #6b7280; text-transform: uppercase; background: #f9fafb; border-bottom: 1px solid #e5e7eb;">${sectionHeader}</div>`;
    
    systemItems.forEach(item => {
      html += `
        <a href="${item.url}" class="search-result-item" style="display: block; padding: 8px 12px; border-bottom: 1px solid #f3f4f6; text-decoration: none; color: inherit;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; font-size: 0.85rem; color: #1f2937;">${item.title}</span>
            <span style="font-size: 0.7rem; font-weight: 500; padding: 2px 6px; border-radius: 4px; background: #e0f2fe; color: #0369a1;">${item.category}</span>
          </div>
          <div style="font-size: 0.75rem; color: #6b7280; margin-top: 2px;">${item.description}</div>
        </a>
      `;
    });
  }

  if (reports.length > 0) {
    const reportTargetUrl = isAdminPath ? "Admin-Reports.html" : "Incident-Evaluation.html";
    html += `<div style="padding: 6px 12px; font-size: 0.7rem; font-weight: 700; color: #6b7280; text-transform: uppercase; background: #f9fafb; border-bottom: 1px solid #e5e7eb;">Firestore Incident Records</div>`;
    
    reports.slice(0, 5).forEach(item => {
      const sevClass = (item.severity || "normal").toLowerCase();
      html += `
        <a href="${reportTargetUrl}?id=${item.id}" class="search-result-item" style="display: block; padding: 8px 12px; border-bottom: 1px solid #f3f4f6; text-decoration: none; color: inherit;">
          <div style="display: flex; justify-content: space-between; font-weight: 600; font-size: 0.85rem; color: #111827;">
            <span>${item.reportId || item.id.substring(0, 8)}</span>
            <span class="badge severity-${sevClass}" style="font-size: 0.7rem; text-transform: uppercase; padding: 2px 6px; border-radius: 4px;">${item.severity || "NORMAL"}</span>
          </div>
          <div style="font-size: 0.75rem; color: #6b7280; margin-top: 2px;">
            ${item.location || 'PH-MNL-QC'} • ${item.detectionType || 'Detection'}
          </div>
        </a>
      `;
    });
  }

  container.innerHTML = html;
  container.style.display = "block";
}
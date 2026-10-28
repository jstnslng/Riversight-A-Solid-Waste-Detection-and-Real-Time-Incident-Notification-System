import { db } from "./firebase-config.js";
import { collection, query, orderBy, limit, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

document.addEventListener("DOMContentLoaded", () => {
  initGlobalSearch();
});

// Detect folder depth automatically
const isAdminPath = window.location.pathname.includes("/admin/");
const monitoringBase = isAdminPath ? "../monitoring/" : "";
const adminBase = isAdminPath ? "" : "../admin/";

// Expanded Cross-System Search Index
const SYSTEM_NAVIGATION_INDEX = [
  // --- MONITORING MODULES ---
  {
    title: "Live Monitoring Module",
    category: "Monitoring Page",
    description: "Live CCTV streams, active camera feeds, sector status",
    url: `${monitoringBase}Live-Monitoring.html`,
    keywords: ["live", "monitoring", "camera", "cctv", "stream", "video", "feed", "sector", "ph-mnl-qc", "live monitoring"]
  },
  {
    title: "Waste Detection & Management",
    category: "Monitoring Page",
    description: "AI waste classification, volume metrics, detection summary, segmentation",
    url: `${monitoringBase}Waste-Management.html`,
    keywords: ["waste", "detection", "detection summary", "plastic", "organic", "volume", "ai", "segmentation", "waste management"]
  },
  {
    title: "Incident Evaluation Console",
    category: "Monitoring Page",
    description: "Active incident analysis, protocol actions, incident data, LGU escalation stepper",
    url: `${monitoringBase}Incident-Evaluation.html`,
    keywords: ["incident", "evaluation", "incident data", "protocol", "escalation", "lgu", "alert", "console", "sub-events", "incident evaluation"]
  },
  {
    title: "Incident Reports & Analytics",
    category: "Monitoring Page",
    description: "Performance metrics, detection trends, archive database, export PDF/CSV",
    url: `${monitoringBase}Incident-Reports.html`,
    keywords: ["reports", "analytics", "archive", "trends", "history", "stats", "export", "incident reports"]
  },

  // --- ADMIN PORTAL PAGES ---
  {
    title: "Administrator Dashboard",
    category: "Admin Portal",
    description: "GIS map preview, system metrics overview, recent AI detections",
    url: `${adminBase}Admin-Dashboard.html`,
    keywords: ["admin", "dashboard", "control", "overview", "gis", "map", "system health", "admin dashboard"]
  },
  {
    title: "User Management",
    category: "Admin Portal",
    description: "Manage accounts, assigned sectors, roles, active users, invites",
    url: `${adminBase}UserManagement.html`,
    keywords: ["user", "management", "users", "accounts", "roles", "administrator", "monitoring", "add user", "sector", "user management"]
  },
  {
    title: "Admin Reports Center",
    category: "Admin Portal",
    description: "Comprehensive system logs, monthly reports, export Excel/PDF",
    url: `${adminBase}Admin-Reports.html`,
    keywords: ["admin reports", "reports center", "export excel", "pdf", "csv", "summary", "monthly reports"]
  },
  {
    title: "System Monitoring & Camera Management",
    category: "Admin Portal",
    description: "Manage connected cameras, add camera, RTSP embed URLs, system health",
    url: `${adminBase}Admin-System-Monitoring.html`,
    keywords: ["system monitoring", "camera management", "add camera", "camera health", "rtsp", "ip address", "status", "system health"]
  },
  {
    title: "Audit Trail & Activity Logs",
    category: "Admin Portal",
    description: "System activity logs, login events, user actions, profile edits",
    url: `${adminBase}Admin-Audit-Trail.html`,
    keywords: ["audit", "trail", "audit trail", "logs", "activity", "login events", "actions", "failed actions"]
  },
  {
    title: "Administrator Settings",
    category: "Admin Portal",
    description: "Theme preferences, font size, email & system alert toggles",
    url: `${adminBase}Admin-Settings.html`,
    keywords: ["settings", "admin settings", "appearance", "theme", "dark mode", "notifications", "security"]
  },
  {
    title: "Administrator Profile",
    category: "Admin Portal",
    description: "Admin account details, username, email, change password",
    url: `${adminBase}Admin-Profile.html`,
    keywords: ["profile", "admin profile", "password", "change password", "account", "user id"]
  },

  // --- SPECIFIC FEEDS & KEYWORD SHORTCUTS ---
  {
    title: "Camera Feed: CAM-001 (North Inlet)",
    category: "Camera Node",
    description: "Main Creek North camera stream • Active",
    url: `${monitoringBase}Live-Monitoring.html?cam=cam-001`,
    keywords: ["cam-001", "cam001", "camera 1", "north inlet", "buwaya creek north"]
  },
  {
    title: "Camera Feed: CAM-002 (South Dam)",
    category: "Camera Node",
    description: "South Waterway Dam stream • Active",
    url: `${monitoringBase}Live-Monitoring.html?cam=cam-002`,
    keywords: ["cam-002", "cam002", "camera 2", "south dam"]
  },
  {
    title: "Alert Configuration & Thresholds",
    category: "System Settings",
    description: "Volume trigger threshold, required confidence, sensitivity settings",
    url: `${monitoringBase}Incident-Evaluation.html#alert-config`,
    keywords: ["alert configuration", "detection volume trigger", "confidence required", "sensitivity", "threshold"]
  }
];

export function initGlobalSearch() {
  const searchInput = document.getElementById("globalSearchInput");
  const resultsContainer = document.getElementById("globalSearchResults");

  if (!searchInput || !resultsContainer) return;

  let reportsCache = [];
  let debounceTimeout = null;

  // Real-time Firestore Reports stream
  const q = query(collection(db, "reports"), orderBy("createdAt", "desc"), limit(50));
  
  onSnapshot(q, (snapshot) => {
    reportsCache = snapshot.docs.map(docSnap => ({
      id: docSnap.id,
      ...docSnap.data()
    }));
  }, (error) => {
    console.error("Global search stream error:", error);
  });

  searchInput.addEventListener("input", (e) => {
    clearTimeout(debounceTimeout);
    const searchTerm = e.target.value.trim().toLowerCase();

    if (!searchTerm) {
      resultsContainer.style.display = "none";
      resultsContainer.innerHTML = "";
      return;
    }

    debounceTimeout = setTimeout(() => {
      // 1. Filter System Pages, Keywords & Features
      const matchedSystemItems = SYSTEM_NAVIGATION_INDEX.filter(item => {
        const titleMatch = item.title.toLowerCase().includes(searchTerm);
        const descMatch = item.description.toLowerCase().includes(searchTerm);
        const categoryMatch = item.category.toLowerCase().includes(searchTerm);
        const keywordMatch = item.keywords.some(kw => kw.includes(searchTerm));

        return titleMatch || descMatch || categoryMatch || keywordMatch;
      });

      // 2. Filter Live Incident Reports from Firestore
      const matchedReports = reportsCache.filter(item => {
        const reportId = (item.reportId || item.id || "").toLowerCase();
        const location = (item.location || "").toLowerCase();
        const type = (item.detectionType || "").toLowerCase();
        const severity = (item.severity || "").toLowerCase();
        const camId = (item.camId || "").toLowerCase();

        return reportId.includes(searchTerm) || 
               location.includes(searchTerm) || 
               type.includes(searchTerm) || 
               severity.includes(searchTerm) ||
               camId.includes(searchTerm);
      });

      renderSearchResults(matchedSystemItems, matchedReports, resultsContainer);
    }, 150);
  });

  // Hide dropdown on click outside
  document.addEventListener("click", (e) => {
    if (!searchInput.contains(e.target) && !resultsContainer.contains(e.target)) {
      resultsContainer.style.display = "none";
    }
  });
}

function renderSearchResults(systemItems, reports, container) {
  if (systemItems.length === 0 && reports.length === 0) {
    container.innerHTML = `<div style="padding: 12px; font-size: 0.85rem; color: #6b7280; text-align: center;">No matching pages, cameras, or reports found.</div>`;
    container.style.display = "block";
    return;
  }

  let html = "";

  // Render Modules, Pages, and Keywords Section
  if (systemItems.length > 0) {
    html += `<div style="padding: 6px 12px; font-size: 0.7rem; font-weight: 700; color: #6b7280; text-transform: uppercase; background: #f9fafb; border-bottom: 1px solid #e5e7eb;">System Navigation & Modules</div>`;
    
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

  // Render Firestore Reports Section
  if (reports.length > 0) {
    const reportTargetUrl = `${monitoringBase}Incident-Evaluation.html`;
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
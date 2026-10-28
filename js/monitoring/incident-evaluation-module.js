import { auth, db as sharedDb } from "../shared/firebase-config.js";
import {
  collection,
  doc,
  writeBatch,
  serverTimestamp,
  onSnapshot,
  query,
  where,
  orderBy,
  limit
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const db = sharedDb;
let activeDetectionId = null;
let activeDetectionData = null;
let lastSyncTimestamp = Date.now();
let syncTimerInterval = null;

document.addEventListener("DOMContentLoaded", () => {
  initActiveConsoleStream();
  initProtocolActionButtons();
  initIncidentEngine();
  initSidebarFilters();
  initAlertConfigurationStream();
});

function initActiveConsoleStream() {
  const q = query(
    collection(db, "reports"),
    orderBy("createdAt", "desc"),
    limit(1)
  );

  onSnapshot(q, (snapshot) => {
    if (!snapshot.empty) {
      const docSnap = snapshot.docs[0];
      activeDetectionId = docSnap.id;
      activeDetectionData = docSnap.data();

      renderConsoleHeader(docSnap.id, activeDetectionData);
      renderIncidentData(docSnap.id, activeDetectionData);
      renderEscalationWorkflow(activeDetectionData);
      streamSubEvents(docSnap.id);
    } else {
      renderEmptyConsoleState();
    }
  }, (error) => {
    console.error("Error streaming Active Incident Console:", error);
  });
}

function renderConsoleHeader(id, data) {
  const titleElem = document.getElementById("activeDetectionIdText");
  const metaElem = document.getElementById("activeDetectionMetaText");
  const badgeElem = document.getElementById("activeSeverityBadge");
  const sectorElem = document.getElementById("activeLocationSector");

  const camName = data.camId ? data.camId.toUpperCase() : "CAMERA";
  const confidenceVal = data.confidence ? `${data.confidence}%` : "N/A";
  const typeText = data.detectionType || "Camera Detection";

  if (titleElem) {
    titleElem.textContent = `Detection ID: ${data.reportId || id.substring(0, 8)}`;
  }

  if (metaElem) {
    metaElem.textContent = `Captured by ${camName} • ${typeText} (${confidenceVal}) • ${formatTime(data.createdAt)}`;
  }

  if (sectorElem) {
    sectorElem.textContent = data.location || "Main North Inlet Sector";
  }

  if (badgeElem) {
    const sev = (data.severity || "CRITICAL").toUpperCase();
    badgeElem.textContent = `${sev} INCIDENT`;
    badgeElem.className = `severity-badge ${sev.toLowerCase()}`;
  }

  if (data.camId && window.RiversightCameraModule?.selectCamera) {
    window.RiversightCameraModule.selectCamera(data.camId);
  }
}

function renderIncidentData(id, data) {
  const locationElem = document.getElementById("dataLocationNode");
  const confidenceElem = document.getElementById("dataConfidenceScore");
  const volumeElem = document.getElementById("dataWasteVolume");
  const materialElem = document.getElementById("dataPrimaryMaterial");
  const timestampElem = document.getElementById("dataTimestamp");

  if (locationElem) locationElem.textContent = data.location || "PH-MNL-QC (North)";
  if (confidenceElem) confidenceElem.textContent = data.confidence ? `${data.confidence}%` : "88.42%";
  if (volumeElem) volumeElem.textContent = data.wasteVolume || "~12.5 kg (Massive)";
  if (materialElem) materialElem.textContent = data.detectionType || "Camera Detection";
  if (timestampElem) timestampElem.textContent = formatFullDate(data.createdAt);
}

function renderEmptyConsoleState() {
  const titleElem = document.getElementById("activeDetectionIdText");
  if (titleElem) titleElem.textContent = "No Active Incidents Detected";
}

function initProtocolActionButtons() {
  bindActionButton("#dismiss-btn", "dismiss_false_positive");
  bindActionButton("#flag-btn", "flag_for_review");
  bindActionButton("#escalate-btn", "escalate_to_lgu");
}

function bindActionButton(selector, actionType) {
  const btn = document.querySelector(selector);
  if (!btn) return;

  btn.addEventListener("click", () => {
    if (!activeDetectionId || !activeDetectionData) {
      showToast({ type: "error", title: "No Active Incident", desc: "No active alert to process." });
      return;
    }
    handleProtocolAction(activeDetectionId, activeDetectionData, actionType);
  });
}

async function handleProtocolAction(detectionId, detectionData, action) {
  try {
    const batch = writeBatch(db);
    const reportRef = doc(db, "reports", detectionId);

    const actionStatusMap = {
      dismiss_false_positive: "Dismissed",
      flag_for_review: "Flagged",
      escalate_to_lgu: "Escalated"
    };

    batch.update(reportRef, {
      protocolAction: action,
      status: actionStatusMap[action] || "Flagged",
      reviewed: true,
      updatedAt: serverTimestamp()
    });

    if (action === "escalate_to_lgu") {
      const eventRef = doc(collection(reportRef, "events"));
      batch.set(eventRef, {
        recipient: "QC Waste Management",
        status: "SENT",
        description: `Emergency notification regarding incident ${detectionData.reportId || detectionId}. Response acknowledged.`,
        timestamp: serverTimestamp()
      });

      const notificationRef = doc(collection(db, "notifications"));
      batch.set(notificationRef, {
        type: "cleanup_escalation",
        title: "LGU Alert Dispatched",
        message: `Incident ${detectionData.reportId || detectionId} at ${detectionData.location || "Sector 4"} escalated to QC Waste Management.`,
        detectionId: detectionId,
        recipient: "QC Waste Management",
        status: "unread",
        createdAt: serverTimestamp()
      });
    }

    await batch.commit();
    showToastForAction(action, detectionData.reportId || detectionId);

  } catch (error) {
    console.error("Error executing protocol action:", error);
    showToast({ type: "error", title: "Action Failed", desc: error.message });
  }
}

// Stream Sub-Events & Log in Real-Time
function streamSubEvents(reportId) {
  const eventsContainer = document.getElementById("incidentEventsList");
  if (!eventsContainer) return;

  const eventsQuery = query(collection(db, "reports", reportId, "events"), orderBy("timestamp", "desc"));

  onSnapshot(eventsQuery, (snapshot) => {
    eventsContainer.innerHTML = "";
    if (snapshot.empty) {
      eventsContainer.innerHTML = `
        <div class="alert-log-item">
          <div class="alert-log-title">No Sub-Events Logged</div>
          <div class="alert-log-desc">Sub-events will automatically record here upon protocol updates.</div>
        </div>
      `;
      return;
    }

    snapshot.forEach((docSnap) => {
      const ev = docSnap.data();
      const div = document.createElement("div");
      div.className = "alert-log-item";
      div.innerHTML = `
        <div class="alert-log-top">
          <span class="alert-status-tag ${(ev.status || "sent").toLowerCase()}">${ev.status || "SENT"}</span>
          <span class="alert-log-time">${formatTime(ev.timestamp)}</span>
        </div>
        <div class="alert-log-title">${ev.recipient || "Response Unit"}</div>
        <div class="alert-log-desc">${ev.description || "Alert dispatched."}</div>
      `;
      eventsContainer.appendChild(div);
    });
  }, (error) => {
    console.error("Sub-events stream error:", error);
  });
}

// Real-Time Listener for Alert Configuration
function initAlertConfigurationStream() {
  const cfgVol = document.getElementById("cfgDisplayVolume");
  const cfgVolDesc = document.getElementById("cfgVolumeDesc");
  const cfgConf = document.getElementById("cfgDisplayConfidence");
  const cfgBar = document.getElementById("cfgConfidenceBar");
  const thresholdLabel = document.getElementById("lblVolumeThreshold");

  const settingsRef = doc(db, "system_settings", "alerts");

  onSnapshot(settingsRef, (docSnap) => {
    if (docSnap.exists()) {
      const data = docSnap.data();
      const volumeTrigger = data.volumeTrigger !== undefined ? data.volumeTrigger : 15;
      const confidenceReq = data.confidenceRequired !== undefined ? data.confidenceRequired : 98;

      if (cfgVol) cfgVol.textContent = `${volumeTrigger} Units`;
      if (thresholdLabel) thresholdLabel.textContent = volumeTrigger;
      if (cfgVolDesc) cfgVolDesc.textContent = `Trigger alert when more than ${volumeTrigger} items are detected in a 5-min window.`;
      if (cfgConf) cfgConf.textContent = `${confidenceReq}%`;
      if (cfgBar) cfgBar.style.width = `${confidenceReq}%`;
    }
  }, (error) => {
    console.error("Alert config stream error, check Firestore Security Rules:", error);
  });
}

function renderEscalationWorkflow(data) {
  const status = (data.status || "").toLowerCase();
  
  const isCaptured = true;
  const isReviewed = Boolean(data.reviewed || status === "flagged" || status === "escalated" || status === "resolved" || status === "dismissed");
  const isEscalated = status === "escalated" || status === "resolved";
  const isResolved = status === "resolved" || Boolean(data.resolvedAt);

  const setStepState = (stepId, iconId, labelId, isDone) => {
    const step = document.getElementById(stepId);
    const icon = document.getElementById(iconId);
    const label = document.getElementById(labelId);

    if (step) step.className = isDone ? "step done" : "step";
    if (icon) {
      icon.className = isDone ? "step-icon done" : "step-icon";
      if (isDone) {
        icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>`;
      }
    }
    if (label) label.className = isDone ? "step-label done" : "step-label";
  };

  setStepState("wfStepCaptured", "wfIconCaptured", "wfLabelCaptured", isCaptured);
  setStepState("wfStepReviewed", "wfIconReviewed", "wfLabelReviewed", isReviewed);
  setStepState("wfStepEscalated", "wfIconEscalated", "wfLabelEscalated", isEscalated);
  setStepState("wfStepResolved", "wfIconResolved", "wfLabelResolved", isResolved);

  const line1 = document.getElementById("wfLine1");
  const line2 = document.getElementById("wfLine2");
  const line3 = document.getElementById("wfLine3");

  if (line1) line1.className = isReviewed ? "step-line done" : "step-line";
  if (line2) line2.className = isEscalated ? "step-line done" : "step-line";
  if (line3) line3.className = isResolved ? "step-line done" : "step-line";
}

function initIncidentEngine() {
  const countElem = document.getElementById("engineUnresolvedCount");
  const syncElem = document.getElementById("engineLastSync");
  const statusElem = document.getElementById("engineStatusText");

  const q = query(
    collection(db, "reports"),
    where("status", "!=", "Resolved")
  );

  onSnapshot(q, (snapshot) => {
    let unresolvedCount = 0;

    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const sev = (data.severity || "").toLowerCase();
      if (sev === "critical" || sev === "severe" || sev === "high" || sev === "normal" || sev === "") {
        unresolvedCount++;
      }
    });

    if (countElem) {
      countElem.textContent = `${unresolvedCount} CRITICALS UNRESOLVED`;
    }

    if (statusElem) {
      statusElem.textContent = "ACTIVE";
    }

    lastSyncTimestamp = Date.now();
    updateLastSyncText();
  }, (error) => {
    console.error("Incident Engine Firestore Error:", error);
    if (countElem) countElem.textContent = "0 CRITICALS UNRESOLVED";
    if (statusElem) statusElem.textContent = "OFFLINE";
  });

  if (syncTimerInterval) clearInterval(syncTimerInterval);
  syncTimerInterval = setInterval(updateLastSyncText, 1000);
}

function updateLastSyncText() {
  const syncElem = document.getElementById("engineLastSync");
  if (!syncElem) return;

  const secondsAgo = Math.floor((Date.now() - lastSyncTimestamp) / 1000);

  if (secondsAgo < 2) {
    syncElem.textContent = "LAST SYNC: JUST NOW";
  } else if (secondsAgo < 60) {
    syncElem.textContent = `LAST SYNC: ${secondsAgo}s AGO`;
  } else {
    const minsAgo = Math.floor(secondsAgo / 60);
    syncElem.textContent = `LAST SYNC: ${minsAgo}m AGO`;
  }
}

function initSidebarFilters() {
  const critElem = document.getElementById("filterCountCritical");
  const highElem = document.getElementById("filterCountHigh");

  onSnapshot(collection(db, "reports"), (snapshot) => {
    let crit = 0;
    let high = 0;

    snapshot.forEach((docSnap) => {
      const sev = (docSnap.data().severity || "").toLowerCase();
      if (sev === "critical" || sev === "severe") crit++;
      if (sev === "high") high++;
    });

    if (critElem) critElem.textContent = crit;
    if (highElem) highElem.textContent = high;
  });
}

function formatTime(timestamp) {
  if (!timestamp) return "--:--";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function formatFullDate(timestamp) {
  if (!timestamp) return "N/A";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return date.toISOString().replace("T", " ").substring(0, 19);
}

function showToastForAction(action, reportId) {
  const messages = {
    dismiss_false_positive: { type: "success", title: "Marked as False Positive", desc: `Detection ${reportId} has been dismissed.` },
    flag_for_review: { type: "warning", title: "Flagged for Review", desc: `Detection ${reportId} sent to manual review queue.` },
    escalate_to_lgu: { type: "error", title: "Escalated to LGU", desc: `Alert dispatched to QC Waste Management for ${reportId}.` }
  };
  showToast(messages[action]);
}

function showToast({ type = "success", title, desc, duration = 4000 }) {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const icons = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3 1 21h22L12 3Z"/><path d="M12 9.5v5M12 17.5h.01"/></svg>',
    error:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>'
  };

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.success}</span>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      ${desc ? `<div class="toast-desc">${desc}</div>` : ""}
    </div>
    <button class="toast-close">&times;</button>
  `;

  container.appendChild(toast);
  const remove = () => { toast.classList.add("closing"); setTimeout(() => toast.remove(), 200); };
  toast.querySelector(".toast-close").addEventListener("click", remove);
  setTimeout(remove, duration);
}
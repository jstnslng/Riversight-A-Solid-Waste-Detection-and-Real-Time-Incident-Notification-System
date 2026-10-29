import { auth, db as sharedDb } from "../shared/firebase-config.js";
import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  serverTimestamp,
  onSnapshot,
  query,
  limit,
  getDocs
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const db = sharedDb;
let activeDetectionId = null;
let activeDetectionData = null;
let activeEventsUnsubscribe = null;
let lastSyncTimestamp = Date.now();
let syncTimerInterval = null;

document.addEventListener("DOMContentLoaded", () => {
  initActiveConsoleStream();
  initProtocolActionButtons();
  initIncidentEngine();
  initSidebarFilters();
  initAlertConfigurationStream();
});

// 1. Fail-Safe Active Console Stream
async function initActiveConsoleStream() {
  const reportsRef = collection(db, "reports");

  onSnapshot(reportsRef, (snapshot) => {
    if (!snapshot.empty) {
      const docSnap = snapshot.docs[0];
      setActiveIncident(docSnap.id, docSnap.data());
    } else {
      renderEmptyConsoleState();
    }
  }, async (error) => {
    console.warn("Real-time stream notice, attempting direct fetch:", error.message);
    try {
      const snap = await getDocs(reportsRef);
      if (!snap.empty) {
        const docSnap = snap.docs[0];
        setActiveIncident(docSnap.id, docSnap.data());
      } else {
        renderEmptyConsoleState();
      }
    } catch (fetchErr) {
      console.error("Direct fetch failed:", fetchErr);
      renderEmptyConsoleState();
    }
  });
}

function setActiveIncident(id, data) {
  activeDetectionId = id;
  activeDetectionData = data;

  renderConsoleHeader(id, data);
  renderIncidentData(id, data);
  renderEscalationWorkflow(data);
  streamSubEvents(id);
}

function renderConsoleHeader(id, data) {
  const titleElem = document.getElementById("activeDetectionIdText");
  const metaElem = document.getElementById("activeDetectionMetaText");
  const badgeElem = document.getElementById("activeSeverityBadge");
  const sectorElem = document.getElementById("activeLocationSector");

  const camName = data.camId ? data.camId.toUpperCase() : "CAM-001";
  const confidenceVal = data.confidence ? `${data.confidence}%` : "88.42%";
  const typeText = data.detectionType || "Camera Detection";
  const displayId = data.reportId || id.substring(0, 8);

  if (titleElem) titleElem.textContent = `Detection ID: ${displayId}`;
  if (metaElem) metaElem.textContent = `Captured by ${camName} • ${typeText} (${confidenceVal}) • ${formatTime(data.createdAt || data.updatedAt)}`;
  if (sectorElem) sectorElem.textContent = data.location || "Buwaya Creek North";

  if (badgeElem) {
    const sev = (data.severity || "CRITICAL").toUpperCase();
    badgeElem.textContent = `${sev} INCIDENT`;
    badgeElem.className = `severity-badge ${sev.toLowerCase()}`;
  }
}

function renderIncidentData(id, data) {
  const locationElem = document.getElementById("dataLocationNode");
  const confidenceElem = document.getElementById("dataConfidenceScore");
  const volumeElem = document.getElementById("dataWasteVolume");
  const materialElem = document.getElementById("dataPrimaryMaterial");
  const timestampElem = document.getElementById("dataTimestamp");

  if (locationElem) locationElem.textContent = data.location || "Buwaya Creek North";
  if (confidenceElem) confidenceElem.textContent = data.confidence ? `${data.confidence}%` : "88.42%";
  if (volumeElem) volumeElem.textContent = data.wasteVolume || "~12.5 kg (Massive)";
  if (materialElem) materialElem.textContent = data.detectionType || "Camera Detection";
  if (timestampElem) timestampElem.textContent = formatFullDate(data.createdAt || data.updatedAt);
}

function renderEmptyConsoleState() {
  const titleElem = document.getElementById("activeDetectionIdText");
  const eventsContainer = document.getElementById("incidentEventsList");
  if (titleElem) titleElem.textContent = "No Active Incidents Detected";
  if (eventsContainer) {
    eventsContainer.innerHTML = `
      <div class="alert-log-item" style="padding: 12px; color: #6b7280; text-align: center; font-size: 0.85rem;">
        No active report document found in database.
      </div>
    `;
  }
}

// 2. Protocol Action Button Binding
function initProtocolActionButtons() {
  bindActionButton("#dismiss-btn", "dismiss_false_positive");
  bindActionButton("#flag-btn", "flag_for_review");
  bindActionButton("#escalate-btn", "escalate_to_lgu");
}

function bindActionButton(selector, actionType) {
  const btn = document.querySelector(selector);
  if (!btn) return;

  btn.addEventListener("click", () => {
    if (!activeDetectionId) {
      showToast({ type: "error", title: "Syncing Incident", desc: "No active report loaded from Firestore." });
      return;
    }
    handleProtocolAction(activeDetectionId, activeDetectionData || {}, actionType);
  });
}

// 3. Protocol Actions Execution Handler
async function handleProtocolAction(detectionId, detectionData, action) {
  try {
    const reportRef = doc(db, "reports", detectionId);

    const actionStatusMap = {
      dismiss_false_positive: "Dismissed",
      flag_for_review: "Flagged",
      escalate_to_lgu: "Escalated"
    };

    const actionTitleMap = {
      dismiss_false_positive: "False Positive Dismissed",
      flag_for_review: "Flagged for Review",
      escalate_to_lgu: "QC Waste Management"
    };

    const displayReportId = detectionData.reportId || detectionId.substring(0, 8);

    const actionDescMap = {
      dismiss_false_positive: `Incident ${displayReportId} marked as false positive. Stepper reset.`,
      flag_for_review: `Incident ${displayReportId} sent to manual review queue.`,
      escalate_to_lgu: `Emergency notification regarding incident ${displayReportId}. Response acknowledged.`
    };

    const actionTagMap = {
      dismiss_false_positive: "DISMISSED",
      flag_for_review: "FLAGGED",
      escalate_to_lgu: "SENT"
    };

    const isDismissed = action === "dismiss_false_positive";

    // 1. Update report status & stepper state
    await setDoc(reportRef, {
      protocolAction: action,
      status: actionStatusMap[action] || "Flagged",
      reviewed: !isDismissed,
      updatedAt: serverTimestamp()
    }, { merge: true });

    // 2. Add log entry to Sub-Events
    const eventRef = doc(collection(db, "reports", detectionId, "events"));
    await setDoc(eventRef, {
      recipient: actionTitleMap[action],
      status: actionTagMap[action],
      description: actionDescMap[action],
      timestamp: serverTimestamp()
    });

    // 3. Dispatch notification for LGU escalations
    if (action === "escalate_to_lgu") {
      try {
        const notifRef = doc(collection(db, "notifications"));
        await setDoc(notifRef, {
          type: "cleanup_escalation",
          title: "LGU Alert Dispatched",
          message: `Incident ${displayReportId} escalated to QC Waste Management.`,
          detectionId: detectionId,
          recipient: "QC Waste Management",
          status: "unread",
          createdAt: serverTimestamp()
        });
      } catch (notifErr) {
        console.warn("Non-blocking notification notice:", notifErr.message);
      }
    }

    showToastForAction(action, displayReportId);

  } catch (error) {
    console.error("Error executing protocol action:", error);
    showToast({ type: "error", title: "Action Failed", desc: error.message });
  }
}

// 4. Real-Time Sub-Events Stream Listener
function streamSubEvents(reportId) {
  const eventsContainer = document.getElementById("incidentEventsList");
  if (!eventsContainer || !reportId) return;

  if (activeEventsUnsubscribe) {
    activeEventsUnsubscribe();
    activeEventsUnsubscribe = null;
  }

  const eventsRef = collection(db, "reports", reportId, "events");

  activeEventsUnsubscribe = onSnapshot(eventsRef, (snapshot) => {
    eventsContainer.innerHTML = "";
    if (!snapshot || snapshot.empty) {
      eventsContainer.innerHTML = `
        <div class="alert-log-item" style="padding: 12px; color: #6b7280; text-align: center; font-size: 0.85rem;">
          No sub-events logged yet. Click a protocol action above to generate a log entry.
        </div>
      `;
      return;
    }

    const eventsList = snapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      ...docSnap.data()
    })).sort((a, b) => {
      const timeA = a.timestamp?.toMillis ? a.timestamp.toMillis() : (a.timestamp ? new Date(a.timestamp).getTime() : 0);
      const timeB = b.timestamp?.toMillis ? b.timestamp.toMillis() : (b.timestamp ? new Date(b.timestamp).getTime() : 0);
      return timeB - timeA;
    });

    eventsList.forEach((ev) => {
      const eventId = ev.id;
      const div = document.createElement("div");
      div.className = "alert-log-item";
      div.style.cssText = "padding: 10px 0; border-bottom: 1px solid #f1f5f9;";

      const tagClass = (ev.status || "sent").toLowerCase();

      div.innerHTML = `
        <div class="alert-log-top" style="display: flex; justify-content: space-between; align-items: center;">
          <span class="alert-status-tag ${tagClass}">${ev.status || "SENT"}</span>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="alert-log-time" style="font-size: 0.75rem; color: #94a3b8;">${formatTime(ev.timestamp)}</span>
            <button type="button" class="btn-delete-event" data-event-id="${eventId}" title="Delete event" style="background: none; border: none; color: #ef4444; cursor: pointer; padding: 2px;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px;"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </div>
        <div class="alert-log-title" style="font-weight: 600; font-size: 0.85rem; color: #1e293b; margin-top: 4px;">${ev.recipient || "Response Unit"}</div>
        <div class="alert-log-desc" style="font-size: 0.775rem; color: #64748b; margin-top: 2px; line-height: 1.3;">${ev.description || "Alert recorded."}</div>
      `;

      div.querySelector(".btn-delete-event").addEventListener("click", () => {
        deleteSubEvent(reportId, eventId);
      });

      eventsContainer.appendChild(div);
    });
  }, (error) => {
    console.warn("Sub-events stream warning:", error.message);
    eventsContainer.innerHTML = `
      <div class="alert-log-item" style="padding: 12px; color: #6b7280; text-align: center; font-size: 0.85rem;">
        No sub-events logged yet. Click a protocol action above to generate a log entry.
      </div>
    `;
  });
}

async function deleteSubEvent(reportId, eventId) {
  try {
    const eventRef = doc(db, "reports", reportId, "events", eventId);
    await deleteDoc(eventRef);
    showToast({ type: "success", title: "Log Deleted", desc: "Sub-event entry removed." });
  } catch (err) {
    console.error("Failed to delete sub-event:", err);
    showToast({ type: "error", title: "Delete Failed", desc: err.message });
  }
}

// 5. Workflow Stepper Renderer
function renderEscalationWorkflow(data) {
  const status = (data.status || "").toLowerCase();
  const protocolAction = (data.protocolAction || "").toLowerCase();

  const isCaptured = true;
  const isDismissed = protocolAction === "dismiss_false_positive" || status === "dismissed";
  const isReviewed = !isDismissed && Boolean(
    data.reviewed || 
    status === "flagged" || 
    status === "escalated" || 
    status === "resolved"
  );

  const isEscalated = !isDismissed && (status === "escalated" || status === "resolved");
  const isResolved = !isDismissed && (status === "resolved" || Boolean(data.resolvedAt));

  const setStepState = (stepId, iconId, labelId, isDone, defaultIconSvg) => {
    const step = document.getElementById(stepId);
    const icon = document.getElementById(iconId);
    const label = document.getElementById(labelId);

    if (step) step.className = isDone ? "step done" : "step";
    if (icon) {
      icon.className = isDone ? "step-icon done" : "step-icon";
      if (isDone) {
        icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>`;
      } else {
        icon.innerHTML = defaultIconSvg;
      }
    }
    if (label) label.className = isDone ? "step-label done" : "step-label";
  };

  const searchSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>`;
  const bellSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>`;
  const checkCircleSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M9 12l2 2 4-4"/></svg>`;

  setStepState("wfStepCaptured", "wfIconCaptured", "wfLabelCaptured", isCaptured, searchSvg);
  setStepState("wfStepReviewed", "wfIconReviewed", "wfLabelReviewed", isReviewed, searchSvg);
  setStepState("wfStepEscalated", "wfIconEscalated", "wfLabelEscalated", isEscalated, bellSvg);
  setStepState("wfStepResolved", "wfIconResolved", "wfLabelResolved", isResolved, checkCircleSvg);

  const line1 = document.getElementById("wfLine1");
  const line2 = document.getElementById("wfLine2");
  const line3 = document.getElementById("wfLine3");

  if (line1) line1.className = isReviewed ? "step-line done" : "step-line";
  if (line2) line2.className = isEscalated ? "step-line done" : "step-line";
  if (line3) line3.className = isResolved ? "step-line done" : "step-line";
}

function initAlertConfigurationStream() {
  const cfgVol = document.getElementById("cfgDisplayVolume");
  const cfgVolDesc = document.getElementById("cfgVolumeDesc");
  const cfgConf = document.getElementById("cfgDisplayConfidence");
  const cfgBar = document.getElementById("cfgConfidenceBar");
  const thresholdLabel = document.getElementById("lblVolumeThreshold");

  const settingsRef = doc(db, "system_settings", "alerts");

  onSnapshot(settingsRef, (docSnap) => {
    let volumeTrigger = 10;
    let confidenceReq = 85;

    if (docSnap.exists()) {
      const data = docSnap.data();
      if (data.volumeTrigger !== undefined) volumeTrigger = data.volumeTrigger;
      if (data.confidenceRequired !== undefined) confidenceReq = data.confidenceRequired;
    }

    if (cfgVol) cfgVol.textContent = `${volumeTrigger} Units`;
    if (thresholdLabel) thresholdLabel.textContent = volumeTrigger;
    if (cfgVolDesc) cfgVolDesc.textContent = `Trigger alert when threshold of ${volumeTrigger} items is exceeded.`;
    if (cfgConf) cfgConf.textContent = `${confidenceReq}%`;
    if (cfgBar) cfgBar.style.width = `${confidenceReq}%`;
  }, () => {
    if (cfgVol) cfgVol.textContent = "10 Units";
    if (cfgConf) cfgConf.textContent = "85%";
    if (cfgBar) cfgBar.style.width = "85%";
  });
}

function initIncidentEngine() {
  const countElem = document.getElementById("engineUnresolvedCount");
  const syncElem = document.getElementById("engineLastSync");
  const statusElem = document.getElementById("engineStatusText");

  onSnapshot(collection(db, "reports"), (snapshot) => {
    let unresolvedCount = 0;

    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      if ((data.status || "").toLowerCase() !== "resolved") {
        unresolvedCount++;
      }
    });

    if (countElem) countElem.textContent = `${unresolvedCount} UNRESOLVED INCIDENTS`;
    if (statusElem) statusElem.textContent = "ACTIVE";

    lastSyncTimestamp = Date.now();
    updateLastSyncText();
  }, () => {
    if (countElem) countElem.textContent = "0 UNRESOLVED INCIDENTS";
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
  showToast(messages[action] || { type: "success", title: "Action Applied", desc: `Updated ${reportId}` });
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
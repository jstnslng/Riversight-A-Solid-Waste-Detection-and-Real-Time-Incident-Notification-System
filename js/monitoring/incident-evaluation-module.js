import { auth, db as sharedDb } from "../shared/firebase-config.js";
import { buildKeywords } from "../shared/search-module.js";
import {
  collection,
  doc,
  writeBatch,
  serverTimestamp,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const db = sharedDb;
const activeDetectionId = "sk4uXAjxkGS3XvCjdAQI";
let activeDetectionData = null;

document.addEventListener("DOMContentLoaded", () => {
  const detectionRef = doc(db, "detections", activeDetectionId);

  onSnapshot(detectionRef, (docSnap) => {
    if (docSnap.exists()) {
      activeDetectionData = docSnap.data();
      console.log("Active detection loaded:", activeDetectionData);
    } else {
      console.error("No detection document found for ID:", activeDetectionId);
    }
  });

  bindActionButton(".btn-dismiss", "dismiss_false_positive");
  bindActionButton(".btn-flag", "flag_for_review");
  bindActionButton(".btn-escalate", "escalate_to_lgu");
});

function bindActionButton(selector, actionType) {
  const btn = document.querySelector(selector);
  if (!btn) {
    console.warn(`Button selector '${selector}' not found in DOM.`);
    return;
  }

  btn.addEventListener("click", () => {
    if (!activeDetectionData) {
      console.error("Cannot perform action: Detection data has not loaded yet.");
      return;
    }
    handleProtocolAction(activeDetectionId, activeDetectionData, actionType);
  });
}

async function handleProtocolAction(detectionId, detectionData, action) {
  try {
    const batch = writeBatch(db);
    const detectionRef = doc(db, "detections", detectionId);

    batch.update(detectionRef, {
      protocolAction: action,
      reviewed: true
    });

    if (action !== "dismiss_false_positive") {
      const incidentRef = doc(collection(db, "incidents"));
      const keywords = typeof buildKeywords === "function"
        ? buildKeywords(detectionData)
        : [];

      batch.set(incidentRef, {
        detectionId: detectionId,
        cameraId: detectionData.cameraId || "",
        locationNode: detectionData.locationNode || "",
        confidenceScore: detectionData.confidenceScore || 0,
        wasteVolumeKg: detectionData.wasteVolumeKg || 0,
        materialType: detectionData.materialType || "",
        severity: (detectionData.wasteVolumeKg > 10) ? "critical" : "high",
        status: (action === "escalate_to_lgu") ? "escalated" : "flagged",
        protocolAction: action,
        createdAt: serverTimestamp(),
        searchKeywords: keywords
      });

      if (action === "escalate_to_lgu") {
        const eventRef = doc(collection(incidentRef, "events"));
        batch.set(eventRef, {
          recipient: "QC Waste Management",
          status: "sent",
          timestamp: serverTimestamp()
        });
      }
    }

    await batch.commit();
    console.log(`Action '${action}' successfully executed for ${detectionId}`);

    showToastForAction(action, detectionId);

  } catch (error) {
    console.error("Error executing protocol action batch write:", error);
    showToast({ type: 'error', title: 'Action failed', desc: error.message });
  }
}

function showToastForAction(action, detectionId) {
  const messages = {
    dismiss_false_positive: {
      type: 'success',
      title: 'Marked as False Positive',
      desc: `Detection ${detectionId} has been dismissed.`
    },
    flag_for_review: {
      type: 'warning',
      title: 'Flagged for Review',
      desc: `Detection ${detectionId} sent to the manual review queue.`
    },
    escalate_to_lgu: {
      type: 'error',
      title: 'Escalated to LGU',
      desc: `Alert dispatched to QC Waste Management for detection ${detectionId}.`
    }
  };
  showToast(messages[action]);
}

function showToast({ type = 'success', title, desc, duration = 4000 }) {
  const container = document.getElementById('toast-container');
  if (!container) {
    console.warn('Toast container not found in DOM');
    return;
  }

  const icons = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3 1 21h22L12 3Z"/><path d="M12 9.5v5M12 17.5h.01"/></svg>',
    error:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>'
  };

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.success}</span>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      ${desc ? `<div class="toast-desc">${desc}</div>` : ''}
    </div>
    <button class="toast-close">&times;</button>
  `;

  container.appendChild(toast);

  const remove = () => {
    toast.classList.add('closing');
    setTimeout(() => toast.remove(), 200);
  };

  toast.querySelector('.toast-close').addEventListener('click', remove);
  setTimeout(remove, duration);
}
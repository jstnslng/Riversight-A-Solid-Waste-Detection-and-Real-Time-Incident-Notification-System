import { auth, db } from "../shared/firebase-config.js";
import {
  addDoc,
  collection,
  onSnapshot,
  serverTimestamp,
  updateDoc,
  doc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const requestButton = document.querySelector("[data-dispatch-cleanup]");
const requestList = document.querySelector("[data-cleanup-requests-list]");
const requestStatus = document.querySelector("[data-cleanup-requests-status]");
const requestsRef = collection(db, "cleanup_requests");
let cleanupRequests = [];

function formatTimestamp(timestamp) {
  if (!timestamp) return "Time pending";
  const date = typeof timestamp.toDate === "function"
    ? timestamp.toDate()
    : typeof timestamp.seconds === "number"
      ? new Date(timestamp.seconds * 1000)
      : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function addRequestAction(container, label, action, requestId) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.dataset.cleanupAction = action;
  button.dataset.requestId = requestId;
  container.appendChild(button);
}

function renderRequests() {
  if (!requestList) return;
  requestList.replaceChildren();

  const recentRequests = [...cleanupRequests]
    .sort((left, right) => {
      const leftTime = left.requestedAt?.toMillis?.() || 0;
      const rightTime = right.requestedAt?.toMillis?.() || 0;
      return rightTime - leftTime;
    })
    .slice(0, 10);

  if (!recentRequests.length) {
    const emptyMessage = document.createElement("p");
    emptyMessage.className = "cleanup-requests-status";
    emptyMessage.textContent = "No in-app cleanup requests have been created.";
    requestList.appendChild(emptyMessage);
    return;
  }

  recentRequests.forEach((request) => {
    const item = document.createElement("article");
    item.className = "cleanup-request-item";

    const title = document.createElement("div");
    title.className = "cleanup-request-title";
    title.textContent = `${request.cameraId || "Unknown camera"} · ${request.location || "Unknown location"}`;

    const meta = document.createElement("div");
    meta.className = "cleanup-request-meta";
    const statusLabels = {
      pending_acknowledgment: "Awaiting in-app acknowledgment",
      acknowledged: "Acknowledged; cleanup outcome not yet verified",
      verified: request.cleanupOutcome === "successful"
        ? "Cleanup verified successful"
        : "Cleanup verified unsuccessful"
    };
    const details = [
      statusLabels[request.status] || "Unknown request status",
      `Requested ${formatTimestamp(request.requestedAt)}`
    ];
    if (request.acknowledgedAt) {
      details.push(`Acknowledged ${formatTimestamp(request.acknowledgedAt)}`);
    }
    if (request.verifiedAt) {
      details.push(`Outcome recorded ${formatTimestamp(request.verifiedAt)}`);
    }
    meta.textContent = details.join(" · ");

    item.append(title, meta);

    if (request.status === "pending_acknowledgment" || request.status === "acknowledged") {
      const actions = document.createElement("div");
      actions.className = "cleanup-request-actions";
      if (request.status === "pending_acknowledgment") {
        addRequestAction(actions, "Acknowledge", "acknowledge", request.id);
      } else {
        addRequestAction(actions, "Verify cleanup successful", "verify-success", request.id);
        addRequestAction(actions, "Verify unsuccessful", "verify-unsuccessful", request.id);
      }
      item.appendChild(actions);
    }

    requestList.appendChild(item);
  });
}

onSnapshot(requestsRef, (snapshot) => {
  cleanupRequests = snapshot.docs.map((requestDoc) => ({
    ...requestDoc.data(),
    id: requestDoc.id
  }));
  if (requestStatus) {
    requestStatus.textContent = "In-app tracking only; no external cleanup team is notified.";
  }
  renderRequests();
}, (error) => {
  console.error("Could not load in-app cleanup requests:", error);
  if (requestStatus) {
    requestStatus.textContent = "Cleanup requests are unavailable. Check your connection or access permissions.";
  }
});

requestButton?.addEventListener("click", async () => {
  const user = auth.currentUser;
  const cameraSelector = document.getElementById("wasteCameraSelect");
  const frame = document.querySelector("[data-camera-feed-frame]");
  const locationLabel = document.querySelector("[data-camera-sector-label]");
  const cameraId = cameraSelector?.value;
  const cameraDocId = frame?.dataset.cameraDocId;

  if (!user || !cameraId || !cameraDocId) {
    if (requestStatus) {
      requestStatus.textContent = "Select an available camera and sign in before creating a request.";
    }
    return;
  }

  const buttonText = requestButton.querySelector("span");
  const originalLabel = buttonText?.textContent || "Create in-app cleanup request";
  requestButton.disabled = true;
  if (buttonText) buttonText.textContent = "Creating in-app request…";

  try {
    await addDoc(requestsRef, {
      cameraDocId,
      cameraId,
      location: locationLabel?.textContent.trim() || "Unknown location",
      requestedAt: serverTimestamp(),
      requestedByUid: user.uid,
      requestedByEmail: user.email || "",
      status: "pending_acknowledgment"
    });
    if (requestStatus) {
      requestStatus.textContent = "In-app cleanup request created. No external team was notified.";
    }
  } catch (error) {
    console.error("Could not create in-app cleanup request:", error);
    if (requestStatus) {
      requestStatus.textContent = "Request creation failed. Check your connection or access permissions.";
    }
  } finally {
    requestButton.disabled = false;
    if (buttonText) buttonText.textContent = originalLabel;
  }
});

requestList?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-cleanup-action]");
  if (!button || button.disabled) return;

  const request = cleanupRequests.find((item) => item.id === button.dataset.requestId);
  const user = auth.currentUser;
  if (!request || !user) return;

  let updates;
  if (button.dataset.cleanupAction === "acknowledge" && request.status === "pending_acknowledgment") {
    updates = {
      status: "acknowledged",
      acknowledgedAt: serverTimestamp(),
      acknowledgedByUid: user.uid,
      acknowledgedByEmail: user.email || ""
    };
  } else if (
    request.status === "acknowledged" &&
    (button.dataset.cleanupAction === "verify-success" || button.dataset.cleanupAction === "verify-unsuccessful")
  ) {
    updates = {
      status: "verified",
      cleanupOutcome: button.dataset.cleanupAction === "verify-success" ? "successful" : "unsuccessful",
      verifiedAt: serverTimestamp(),
      verifiedByUid: user.uid,
      verifiedByEmail: user.email || ""
    };
  } else {
    return;
  }

  button.disabled = true;
  const originalLabel = button.textContent;
  button.textContent = "Saving…";
  try {
    await updateDoc(doc(db, "cleanup_requests", request.id), updates);
    if (requestStatus) {
      requestStatus.textContent = "Cleanup request updated in RiverSight. This does not notify an external team.";
    }
  } catch (error) {
    console.error("Could not update in-app cleanup request:", error);
    if (requestStatus) {
      requestStatus.textContent = "Request update failed. Check your connection or access permissions.";
    }
    button.disabled = false;
    button.textContent = originalLabel;
  }
});

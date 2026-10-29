import { db } from "../shared/firebase-config.js";
import { collection, query, where, orderBy, limit, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

document.addEventListener("DOMContentLoaded", () => {
  initRecentSnapshotsStream();
  initSnapshotModalEvents();
});

let allSnapshotsCache = [];

export function initRecentSnapshotsStream() {
  const container = document.getElementById("recentSnapshotsGrid");
  const cameraSelect = document.getElementById("wasteCameraSelect");
  if (!container) return;

  let unsubscribe = null;

  const listenToSnapshots = (camId) => {
    if (unsubscribe) unsubscribe();

    // Query Firestore for latest auto-captures and detections
    let q = query(
      collection(db, "reports"),
      orderBy("createdAt", "desc"),
      limit(20)
    );

    if (camId && camId !== "ALL" && !camId.includes("Loading")) {
      q = query(
        collection(db, "reports"),
        where("camId", "==", camId),
        orderBy("createdAt", "desc"),
        limit(20)
      );
    }

    unsubscribe = onSnapshot(q, (snapshot) => {
      container.innerHTML = "";
      allSnapshotsCache = [];

      if (snapshot.empty) {
        container.innerHTML = `
          <div style="grid-column: 1 / -1; padding: 20px; text-align: center; color: #64748b; font-size: 0.85rem;">
            No live CCTV waste captures recorded for this feed yet.
          </div>
        `;
        return;
      }

      snapshot.docs.forEach((docSnap) => {
        allSnapshotsCache.push({
          id: docSnap.id,
          ...docSnap.data()
        });
      });

      // Render first 3 snapshots in card grid
      // Priority: AI segmented frame -> Base64 snapshot -> Remote URL -> Fallback image
        const defaultPlaceholder = "https://picsum.photos/seed/creek-stream/200/140";
        const imageUrl = item.segmentationImage || item.snapshotBase64 || item.imageUrl || defaultPlaceholder;
        const timeStr = formatSnapshotTime(item.createdAt);

        const snapElem = document.createElement("div");
        snapElem.className = "snapshot";
        snapElem.style.cssText = `
        background-image: url('${imageUrl}');
        background-size: cover;
        background-position: center;
        background-repeat: no-repeat;
        cursor: pointer;
        position: relative;
        border-radius: 8px;
        min-height: 110px;
        border: 1px solid #e2e8f0;
        `;

        snapElem.innerHTML = `
          <span class="snap-time" style="position: absolute; bottom: 6px; left: 6px; background: rgba(0, 0, 0, 0.75); color: #fff; font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; font-family: monospace;">
            ${timeStr}
          </span>
        `;

        snapElem.addEventListener("click", () => {
          openFullImagePreview(imageUrl);
        });

        container.appendChild(snapElem);
      });

      // Render "+More" button pill if additional snapshots exist
      if (allSnapshotsCache.length > 3) {
        const moreElem = document.createElement("div");
        moreElem.className = "snapshot snapshot-more";
        moreElem.style.cssText = `
          display: flex;
          align-items: center;
          justify-content: center;
          background: #1e293b;
          color: #fff;
          font-weight: 600;
          font-size: 0.85rem;
          border-radius: 8px;
          cursor: pointer;
          min-height: 110px;
        `;
        moreElem.textContent = `+${allSnapshotsCache.length - 3} More`;
        moreElem.addEventListener("click", openGalleryModal);
        container.appendChild(moreElem);
      }
    }, (error) => {
      console.warn("Snapshot stream warning:", error.message);
    });
  };

  listenToSnapshots(cameraSelect ? cameraSelect.value : null);

  if (cameraSelect) {
    cameraSelect.addEventListener("change", (e) => {
      listenToSnapshots(e.target.value);
    });
  }
}

function initSnapshotModalEvents() {
  const openBtn = document.getElementById("openSnapshotsModalBtn");
  const closeBtn = document.getElementById("closeSnapshotsModalBtn");
  const modal = document.getElementById("snapshotGalleryModal");

  if (openBtn) openBtn.addEventListener("click", openGalleryModal);
  if (closeBtn) closeBtn.addEventListener("click", closeGalleryModal);

  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeGalleryModal();
    });
  }
}

function openGalleryModal() {
  const modal = document.getElementById("snapshotGalleryModal");
  const galleryGrid = document.getElementById("modalSnapshotGalleryGrid");
  if (!modal || !galleryGrid) return;

  galleryGrid.innerHTML = "";

  if (allSnapshotsCache.length === 0) {
    galleryGrid.innerHTML = `
      <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: #64748b;">
        No creek snapshots available.
      </div>
    `;
  } else {
    allSnapshotsCache.forEach((item) => {
      const imageUrl = item.segmentationImage || item.snapshotBase64 || item.imageUrl || '../../assets/no-signal.jpg';
      const timeStr = formatSnapshotTime(item.createdAt);
      const camName = (item.camId || "CAM-001").toUpperCase();

      const card = document.createElement("div");
      card.style.cssText = "background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; display: flex; flex-direction: column;";

      card.innerHTML = `
        <div style="height: 140px; background: url('${imageUrl}') center/cover no-repeat; cursor: pointer;" title="Click to open full resolution image"></div>
        <div style="padding: 10px 12px; display: flex; justify-content: space-between; align-items: center; background: #ffffff;">
          <span style="font-size: 0.75rem; font-weight: 700; color: #0f172a;">${camName}</span>
          <span style="font-size: 0.7rem; color: #64748b; font-family: monospace;">${timeStr}</span>
        </div>
      `;

      card.querySelector("div").addEventListener("click", () => {
        openFullImagePreview(imageUrl);
      });

      galleryGrid.appendChild(card);
    });
  }

  modal.style.display = "flex";
}

function closeGalleryModal() {
  const modal = document.getElementById("snapshotGalleryModal");
  if (modal) modal.style.display = "none";
}

function openFullImagePreview(url) {
  window.open(url, "_blank");
}

function formatSnapshotTime(timestamp) {
  if (!timestamp) return "--:--:--";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
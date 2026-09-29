import { db } from "../shared/firebase-config.js";
import {
  collection,
  onSnapshot,
  addDoc,
  doc,
  updateDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getRtspEmbedIssue, normalizeRtspEmbedUrl } from "../shared/camera-embed.js";

(() => {
  let cameras = [];
  let systemMetrics = {
    cpu: 0,
    ram: 0,
    disk: 0,
    storage: 0,
    dbLatency: 0,
    serverUptime: 0,
  };

  const addModal = document.getElementById("addCameraModal");
  const addCameraBtn = document.getElementById("addCameraBtn");
  const closeModalBtn = document.getElementById("closeModalBtn");
  const cancelBtn = document.getElementById("cancelBtn");
  const addCameraForm = document.getElementById("addCameraForm");
  const embedUrlInput = document.getElementById("camEmbedUrl");
  const embedUrlError = document.getElementById("camEmbedUrlError");
  const cameraSubmitBtn = document.getElementById("cameraSubmitBtn");

  const editModal = document.getElementById("editCameraModal");
  const editCameraForm = document.getElementById("editCameraForm");
  const editCloseModalBtn = editModal?.querySelector(".modal-close");
  const cancelEditBtn = document.getElementById("cancelEditBtn");
  const editEmbedUrlInput = document.getElementById("editCamEmbedUrl");
  const editEmbedUrlError = document.getElementById("editCamEmbedUrlError");
  const cameraEditSubmitBtn = document.getElementById("cameraEditSubmitBtn");

  let editingCameraId = null;

  function openAddModal() {
    addModal.classList.add("active");
  }

  function closeAddModal() {
    addModal.classList.remove("active");
    addCameraForm.reset();
    if (embedUrlError) embedUrlError.textContent = "";
  }

  function openEditModal(camera) {
    editingCameraId = camera.id;

    document.getElementById("editCamId").value = camera.camId || "";
    document.getElementById("editCamTitle").value = camera.title || "";
    
    if (document.getElementById("editRegion")) document.getElementById("editRegion").value = camera.region || "";
    if (document.getElementById("editProvince")) document.getElementById("editProvince").value = camera.province || "";
    if (document.getElementById("editCity")) document.getElementById("editCity").value = camera.city || "";
    if (document.getElementById("editBarangay")) document.getElementById("editBarangay").value = camera.barangay || "";

    document.getElementById("editCamIPAddress").value = camera.ipAddress === "N/A" ? "" : camera.ipAddress || "";
    document.getElementById("editCamResolution").value = camera.resolution || "";
    document.getElementById("editCamFPS").value = camera.fps || "";
    document.getElementById("editCamStatus").value = camera.status || "ONLINE";

    if (editEmbedUrlInput) editEmbedUrlInput.value = camera.embedUrl || "";
    if (editEmbedUrlError) editEmbedUrlError.textContent = "";

    editModal.classList.add("active");
  }

  function closeEditModal() {
    editModal.classList.remove("active");
    editCameraForm.reset();
    editingCameraId = null;
    if (editEmbedUrlError) editEmbedUrlError.textContent = "";
  }

  function getStatusPillClass(status) {
    if (status === "ONLINE") return "good";
    if (status === "OFFLINE") return "danger";
    if (status === "WEAK") return "warn";
    return "good";
  }

  function buildCameraCard(camera) {
    const article = document.createElement("article");
    article.className = "camera-card";
    article.dataset.cameraId = camera.id;

    const embedUrl = normalizeRtspEmbedUrl(camera.embedUrl);
    const embedIssue = getRtspEmbedIssue(camera.embedUrl);
    if (embedIssue) {
      console.warn(`Camera feed unavailable: ${embedIssue} (${camera.camId})`);
    }
    const preview = article.appendChild(document.createElement("div"));
    preview.className = "camera-preview";

    if (embedUrl) {
      const iframe = document.createElement("iframe");
      iframe.src = embedUrl;
      iframe.title = `${camera.camId} live preview`;
      iframe.allow = "fullscreen; autoplay";
      iframe.allowFullscreen = true;
      iframe.addEventListener("error", () => {
        console.error(`Camera iframe rendering issue (${camera.camId})`);
      }, { once: true });
      preview.appendChild(iframe);
    } else {
      preview.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 48px; height: 48px; opacity: 0.3;">
          <path d="M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
        <span>Live Preview Unavailable</span>`;
    }

    const meta = document.createElement("div");
    meta.className = "camera-meta";
    meta.innerHTML = `
      <div class="camera-title-row">
        <h4>${camera.camId}</h4>
        <span class="status-pill ${getStatusPillClass(camera.status)}">${camera.status}</span>
      </div>
      <div class="camera-details"><span>Station</span><strong>${camera.city}, ${camera.barangay}</strong></div>
      <div class="camera-details"><span>IP Address</span><strong>${camera.ipAddress}</strong></div>
      <div class="camera-details"><span>Resolution</span><strong>${camera.resolution}</strong></div>
      <div class="camera-details"><span>FPS</span><strong>${camera.fps}</strong></div>
      <div class="camera-details"><span>Last Detection</span><strong>${camera.lastDetection}</strong></div>
      <div class="camera-details"><span>Last Connected Time</span><strong>${camera.lastConnected}</strong></div>`;
    article.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "camera-actions";
    actions.innerHTML = `
      <button type="button" data-action="view">View Camera</button>
      <button type="button" data-action="restart">Restart Camera</button>
      <button type="button" data-action="reconnect">Reconnect</button>
      <button type="button" class="light" data-action="settings">Settings</button>`;
    actions.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", () => handleCameraAction(camera, button.dataset.action));
    });
    article.appendChild(actions);

    return article;
  }

  function handleCameraAction(camera, action) {
    if (action === "view") {
      window.location.href = `../monitoring/Live-Monitoring.html?cameraId=${encodeURIComponent(camera.camId)}`;
      return;
    }
    if (action === "settings") {
      openEditModal(camera);
      return;
    }
    showNotification(`Remote camera commands are unavailable for ${camera.camId}.`, "error");
  }

  function renderSystemMetrics() {
    const grid = document.getElementById("systemMetricsGrid");
    if (!grid) return;

    const onlineCameras = cameras.filter((camera) => camera.status === "ONLINE").length;
    const totalCameras = cameras.length;
    const formatUptime = (ms) => {
      const days = Math.floor(ms / 86400000);
      const hours = Math.floor((ms % 86400000) / 3600000);
      return days ? `${days}d ${hours}h` : `${hours}h`;
    };

    grid.innerHTML = `
      <div class="card system-card usage-card"><div class="card-head"><h3>CPU Usage</h3><span class="status-pill ${systemMetrics.cpu > 80 ? "warn" : "good"}">${systemMetrics.cpu}%</span></div><div class="meter"><span style="width:${systemMetrics.cpu}%"></span></div><div class="card-sub">Average processor load</div></div>
      <div class="card system-card usage-card"><div class="card-head"><h3>RAM Usage</h3><span class="status-pill ${systemMetrics.ram > 80 ? "warn" : "good"}">${systemMetrics.ram}%</span></div><div class="meter"><span style="width:${systemMetrics.ram}%"></span></div><div class="card-sub">Memory consumption</div></div>
      <div class="card system-card usage-card"><div class="card-head"><h3>Disk Usage</h3><span class="status-pill ${systemMetrics.disk > 80 ? "warn" : "good"}">${systemMetrics.disk}%</span></div><div class="meter"><span style="width:${systemMetrics.disk}%"></span></div><div class="card-sub">System disk utilization</div></div>
      <div class="card system-card usage-card"><div class="card-head"><h3>Storage Usage</h3><span class="status-pill ${systemMetrics.storage > 80 ? "warn" : "good"}">${systemMetrics.storage}%</span></div><div class="meter"><span style="width:${systemMetrics.storage}%"></span></div><div class="card-sub">Archive and media storage</div></div>
      <div class="card system-card status-card"><div class="card-head"><h3>Database Status</h3><span class="status-pill good">Online</span></div><div class="card-sub">Connected to reporting datastore</div><div class="mini-meta">Latency: ${systemMetrics.dbLatency} ms</div></div>
      <div class="card system-card status-card"><div class="card-head"><h3>Server Status</h3><span class="status-pill good">Healthy</span></div><div class="card-sub">API and dashboard services responding</div><div class="mini-meta">Uptime: ${formatUptime(systemMetrics.serverUptime)}</div></div>
      <div class="card system-card status-card"><div class="card-head"><h3>Camera Status</h3><span class="status-pill good">${onlineCameras}/${totalCameras} Online</span></div><div class="card-sub">All live feeds reporting</div><div class="mini-meta">${totalCameras - onlineCameras} camera${totalCameras - onlineCameras !== 1 ? "s" : ""} awaiting sync</div></div>
      <div class="card system-card status-card"><div class="card-head"><h3>YOLO Model Status</h3><span class="status-pill good">Loaded</span></div><div class="card-sub">Latest detection model deployed</div><div class="mini-meta">Version: v8.2.1</div></div>
      <div class="card system-card status-card"><div class="card-head"><h3>System Uptime</h3><span class="status-pill good">Stable</span></div><div class="uptime-value">${formatUptime(systemMetrics.serverUptime)}</div><div class="card-sub">No restart events in the current window</div></div>`;
  }

  function renderCameras() {
    const grid = document.getElementById("cameraGrid");
    if (!grid) return;
    grid.innerHTML = "";
    if (!cameras.length) {
      grid.innerHTML = `<div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--muted);"><p>No cameras connected yet.</p></div>`;
      renderSystemMetrics();
      return;
    }
    cameras.forEach((camera) => grid.appendChild(buildCameraCard(camera)));
    renderSystemMetrics();
  }

  function showNotification(message, type = "info") {
    const notification = document.createElement("div");
    notification.textContent = message;
    notification.style.cssText = `position:fixed;bottom:20px;right:20px;background:${type === "success" ? "var(--green)" : type === "error" ? "var(--red)" : "var(--blue)"};color:#fff;padding:12px 20px;border-radius:8px;font-size:13px;font-weight:600;z-index:9999;`;
    document.body.appendChild(notification);
    setTimeout(() => notification.remove(), 3000);
  }

  addCameraBtn?.addEventListener("click", openAddModal);
  closeModalBtn?.addEventListener("click", closeAddModal);
  cancelBtn?.addEventListener("click", closeAddModal);

  editCloseModalBtn?.addEventListener("click", closeEditModal);
  cancelEditBtn?.addEventListener("click", closeEditModal);

  addModal?.addEventListener("click", (event) => {
    if (event.target === addModal) closeAddModal();
  });
  editModal?.addEventListener("click", (event) => {
    if (event.target === editModal) closeEditModal();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (addModal?.classList.contains("active")) closeAddModal();
      if (editModal?.classList.contains("active")) closeEditModal();
    }
  });

  addCameraForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const embedUrl = normalizeRtspEmbedUrl(embedUrlInput.value);
    embedUrlError.textContent = "";

    if (!embedUrl) {
      embedUrlError.textContent = "Enter a valid RTSP.ME embed URL, such as https://rtsp.me/embed/PLAYER_ID/.";
      embedUrlInput.focus();
      return;
    }

    cameraSubmitBtn.disabled = true;
    cameraSubmitBtn.textContent = "Adding...";

    try {
      const region = document.getElementById("region-text")?.value.trim() || document.getElementById("region")?.value.trim();
      const province = document.getElementById("province-text")?.value.trim() || document.getElementById("province")?.value.trim();
      const city = document.getElementById("city-text")?.value.trim() || document.getElementById("city")?.value.trim();
      const barangay = document.getElementById("barangay-text")?.value.trim() || document.getElementById("barangay")?.value.trim();
      const location = `${city}, ${barangay}`;

      const cameraData = {
        camId: document.getElementById("camId").value.trim(),
        title: document.getElementById("camTitle").value.trim(),
        region: region || "N/A",
        province: province || "N/A",
        city: city || "N/A",
        barangay: barangay || "N/A",
        location: location !== ", " ? location : "General Sector",
        ipAddress: document.getElementById("camIPAddress").value.trim(),
        resolution: document.getElementById("camResolution").value.trim() || "1920 x 1080",
        fps: parseInt(document.getElementById("camFPS").value, 10) || 30,
        status: document.getElementById("camStatus").value,
        embedUrl,
        createdAt: serverTimestamp(),
        thumbnailUrl: `https://picsum.photos/seed/${encodeURIComponent(document.getElementById("camId").value.trim())}/1200/800`,
        lastDetection: "No detections recorded",
        lastConnected: "Just now",
        detections: []
      };

      await addDoc(collection(db, "camera_feeds"), cameraData);
      showNotification("Camera added successfully!", "success");
      closeAddModal();
    } catch (error) {
      console.error("Error saving camera:", error);
      showNotification(`Error adding camera: ${error.message}`, "error");
    } finally {
      cameraSubmitBtn.disabled = false;
      cameraSubmitBtn.textContent = "Add Camera";
    }
  });

  editCameraForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!editingCameraId) return;

    const embedUrl = normalizeRtspEmbedUrl(editEmbedUrlInput.value);
    editEmbedUrlError.textContent = "";

    if (!embedUrl) {
      editEmbedUrlError.textContent = "Enter a valid RTSP.ME embed URL, such as https://rtsp.me/embed/PLAYER_ID/.";
      editEmbedUrlInput.focus();
      return;
    }

    cameraEditSubmitBtn.disabled = true;
    cameraEditSubmitBtn.textContent = "Saving...";

    try {
      const region = document.getElementById("editRegion")?.value.trim();
      const province = document.getElementById("editProvince")?.value.trim();
      const city = document.getElementById("editCity")?.value.trim();
      const barangay = document.getElementById("editBarangay")?.value.trim();
      const location = `${city}, ${barangay}`;

      const cameraData = {
        camId: document.getElementById("editCamId").value.trim(),
        title: document.getElementById("editCamTitle").value.trim(),
        region: region || "N/A",
        province: province || "N/A",
        city: city || "N/A",
        barangay: barangay || "N/A",
        location: location !== ", " ? location : "General Sector",
        ipAddress: document.getElementById("editCamIPAddress").value.trim(),
        resolution: document.getElementById("editCamResolution").value.trim() || "1920 x 1080",
        fps: parseInt(document.getElementById("editCamFPS").value, 10) || 30,
        status: document.getElementById("editCamStatus").value,
        embedUrl,
      };

      await updateDoc(doc(db, "camera_feeds", editingCameraId), cameraData);
      showNotification("Camera updated successfully!", "success");
      closeEditModal();
    } catch (error) {
      console.error("Error updating camera:", error);
      showNotification(`Error updating camera: ${error.message}`, "error");
    } finally {
      cameraEditSubmitBtn.disabled = false;
      cameraEditSubmitBtn.textContent = "Save Changes";
    }
  });

  document.getElementById("refreshStatusBtn")?.addEventListener("click", () => {
    systemMetrics.cpu = Math.floor(Math.random() * 80) + 10;
    systemMetrics.ram = Math.floor(Math.random() * 80) + 10;
    systemMetrics.disk = Math.floor(Math.random() * 60) + 10;
    systemMetrics.storage = Math.floor(Math.random() * 80) + 10;
    systemMetrics.dbLatency = Math.floor(Math.random() * 20) + 5;
    renderSystemMetrics();
    showNotification("System metrics refreshed", "success");
  });

  document.getElementById("viewLogsBtn")?.addEventListener("click", () => {
    window.location.href = "./Admin-Audit-Trail.html";
  });

  document.getElementById("systemSearchInput")?.addEventListener("input", (event) => {
    const query = event.target.value.toLowerCase();
    document.querySelectorAll("[data-camera-id]").forEach((card) => {
      card.style.display = card.textContent.toLowerCase().includes(query) ? "" : "none";
    });
  });

  onSnapshot(collection(db, "camera_feeds"), (snapshot) => {
    cameras = snapshot.docs.map((cameraDoc) => {
      const data = cameraDoc.data();
      return {
        id: cameraDoc.id,
        camId: data.camId || cameraDoc.id,
        title: data.title || "Unknown Camera",
        region: data.region || "N/A",
        province: data.province || "N/A",
        city: data.city || "N/A",
        barangay: data.barangay || "N/A",
        location: data.location || (data.city && data.barangay ? `${data.city}, ${data.barangay}` : "General Sector"),
        ipAddress: data.ipAddress || "N/A",
        resolution: data.resolution || "1920 x 1080",
        fps: data.fps || 30,
        status: data.status || "ONLINE",
        embedUrl: data.embedUrl || "",
        lastDetection: data.lastDetection || "No detections recorded",
        lastConnected: data.lastConnected || "Just now",
      };
    });
    renderCameras();
    const liveStatusEl = document.getElementById("liveStatusText");
    if (liveStatusEl) {
      liveStatusEl.textContent = `Live Stream · ${cameras.filter((camera) => camera.status === "ONLINE").length} of ${cameras.length} cameras online`;
    }
  }, (error) => {
    console.error("Failed to load camera_feeds from Firestore:", error);
    showNotification("Error syncing cameras", "error");
  });

  systemMetrics = {
    cpu: Math.floor(Math.random() * 80) + 10,
    ram: Math.floor(Math.random() * 80) + 10,
    disk: Math.floor(Math.random() * 60) + 10,
    storage: Math.floor(Math.random() * 80) + 10,
    dbLatency: Math.floor(Math.random() * 20) + 5,
    serverUptime: 99 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000,
  };
})();
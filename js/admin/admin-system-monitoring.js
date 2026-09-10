import { db } from "../shared/firebase-config.js";
import {
  collection,
  onSnapshot,
  addDoc,
  doc,
  updateDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { normalizeRtspEmbedUrl } from "../shared/camera-embed.js";

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

  const modal = document.getElementById("addCameraModal");
  const addCameraBtn = document.getElementById("addCameraBtn");
  const closeModalBtn = document.getElementById("closeModalBtn");
  const cancelBtn = document.getElementById("cancelBtn");
  const addCameraForm = document.getElementById("addCameraForm");
  const embedUrlInput = document.getElementById("camEmbedUrl");
  const embedUrlError = document.getElementById("camEmbedUrlError");
  const cameraModalTitle = document.getElementById("cameraModalTitle");
  const cameraSubmitBtn = document.getElementById("cameraSubmitBtn");
  let editingCameraId = null;

  function openModal() {
    editingCameraId = null;
    cameraModalTitle.textContent = "Add New Camera";
    cameraSubmitBtn.textContent = "Add Camera";
    modal.classList.add("active");
  }

  function closeModal() {
    modal.classList.remove("active");
    addCameraForm.reset();
    embedUrlError.textContent = "";
    editingCameraId = null;
    cameraModalTitle.textContent = "Add New Camera";
    cameraSubmitBtn.textContent = "Add Camera";
  }

  function openEditModal(camera) {
    editingCameraId = camera.id;
    document.getElementById("camId").value = camera.camId;
    document.getElementById("camTitle").value = camera.title;
    document.getElementById("camLocation").value = camera.location;
    document.getElementById("camIPAddress").value = camera.ipAddress === "N/A" ? "" : camera.ipAddress;
    document.getElementById("camResolution").value = camera.resolution;
    document.getElementById("camFPS").value = camera.fps;
    document.getElementById("camStatus").value = camera.status;
    document.getElementById("camSectorLabel").value = camera.sectorLabel;
    embedUrlInput.value = camera.embedUrl || "";
    embedUrlError.textContent = "";
    cameraModalTitle.textContent = "Edit Camera";
    cameraSubmitBtn.textContent = "Save Changes";
    modal.classList.add("active");
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
    const preview = article.appendChild(document.createElement("div"));
    preview.className = "camera-preview";

    if (embedUrl) {
      const iframe = document.createElement("iframe");
      iframe.src = embedUrl;
      iframe.title = `${camera.camId} live preview`;
      iframe.allow = "fullscreen; autoplay";
      iframe.allowFullscreen = true;
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
      <div class="camera-details"><span>Station</span><strong>${camera.location}</strong></div>
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
    showNotification(`${action}ing ${camera.camId}...`, "info");
  }

  function renderSystemMetrics() {
    const grid = document.getElementById("systemMetricsGrid");
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

  addCameraBtn.addEventListener("click", openModal);
  closeModalBtn.addEventListener("click", closeModal);
  cancelBtn.addEventListener("click", closeModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal.classList.contains("active")) closeModal();
  });

  addCameraForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = cameraSubmitBtn;
    const embedUrl = normalizeRtspEmbedUrl(embedUrlInput.value);
    embedUrlError.textContent = "";
    if (!embedUrl) {
      embedUrlError.textContent = "Enter a valid RTSP.ME embed URL, such as https://rtsp.me/embed/PLAYER_ID/.";
      embedUrlInput.focus();
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = "Adding...";
    try {
      const location = document.getElementById("camLocation").value.trim();
      const cameraData = {
        camId: document.getElementById("camId").value.trim(),
        title: document.getElementById("camTitle").value.trim(),
        location,
        ipAddress: document.getElementById("camIPAddress").value.trim(),
        resolution: document.getElementById("camResolution").value.trim() || "1920 x 1080",
        fps: parseInt(document.getElementById("camFPS").value, 10) || 30,
        status: document.getElementById("camStatus").value,
        sectorLabel: document.getElementById("camSectorLabel").value.trim() || location,
        embedUrl,
      };

      if (editingCameraId) {
        await updateDoc(doc(db, "camera_feeds", editingCameraId), cameraData);
        showNotification("Camera updated successfully!", "success");
      } else {
        cameraData.createdAt = serverTimestamp();
        cameraData.thumbnailUrl = `https://picsum.photos/seed/${encodeURIComponent(document.getElementById("camId").value.trim())}/1200/800`;
        cameraData.lastDetection = "No detections recorded";
        cameraData.lastConnected = "Just now";
        cameraData.detections = [];
        await addDoc(collection(db, "camera_feeds"), cameraData);
        showNotification("Camera added successfully!", "success");
      }
      closeModal();
    } catch (error) {
      console.error("Error saving camera:", error);
      showNotification(`Error adding camera: ${error.message}`, "error");
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "Add Camera";
    }
  });

  document.getElementById("refreshStatusBtn").addEventListener("click", () => {
    systemMetrics.cpu = Math.floor(Math.random() * 80) + 10;
    systemMetrics.ram = Math.floor(Math.random() * 80) + 10;
    systemMetrics.disk = Math.floor(Math.random() * 60) + 10;
    systemMetrics.storage = Math.floor(Math.random() * 80) + 10;
    systemMetrics.dbLatency = Math.floor(Math.random() * 20) + 5;
    renderSystemMetrics();
    showNotification("System metrics refreshed", "success");
  });

  document.getElementById("systemSearchInput").addEventListener("input", (event) => {
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
        location: data.location || "General Sector",
        ipAddress: data.ipAddress || "N/A",
        resolution: data.resolution || "1920 x 1080",
        fps: data.fps || 30,
        status: data.status || "ONLINE",
        sectorLabel: data.sectorLabel || data.location || "Monitoring Area",
        embedUrl: data.embedUrl || "",
        lastDetection: data.lastDetection || "No detections recorded",
        lastConnected: data.lastConnected || "Just now",
      };
    });
    renderCameras();
    document.getElementById("liveStatusText").textContent = `Live Stream · ${cameras.filter((camera) => camera.status === "ONLINE").length} of ${cameras.length} cameras online`;
  }, (error) => {
    console.error("Firestore sync error:", error);
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

import { auth, db } from "../shared/firebase-config.js";
import { 
  collection, 
  onSnapshot, 
  addDoc, 
  updateDoc,
  doc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

(function () {
  let cameras = [];
  let systemMetrics = {
    cpu: 0,
    ram: 0,
    disk: 0,
    storage: 0,
    dbLatency: 0,
    serverUptime: 0,
    camerasOnline: 0,
    yoloStatus: 'Loaded'
  };

  // ============ Modal Management ============
  const modal = document.getElementById('addCameraModal');
  const addCameraBtn = document.getElementById('addCameraBtn');
  const closeModalBtn = document.getElementById('closeModalBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const addCameraForm = document.getElementById('addCameraForm');

  function openModal() {
    modal.classList.add('active');
  }

  function closeModal() {
    modal.classList.remove('active');
    addCameraForm.reset();
  }

  addCameraBtn.addEventListener('click', openModal);
  closeModalBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);

  // Close modal on outside click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeModal();
    }
  });

  // Close modal on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('active')) {
      closeModal();
    }
  });

  // ============ Camera Card Builder ============
  function getStatusPillClass(status) {
    switch (status) {
      case 'ONLINE':
        return 'good';
      case 'OFFLINE':
        return 'danger';
      case 'WEAK':
        return 'warn';
      default:
        return 'good';
    }
  }

  function buildCameraCard(camera) {
    const article = document.createElement('article');
    article.className = 'camera-card';
    article.dataset.cameraId = camera.id;

    const lastDetection = camera.lastDetection || 'No detections recorded';
    const lastConnected = camera.lastConnected || 'Never';
    const ipAddress = camera.ipAddress || 'N/A';
    const resolution = camera.resolution || '1920 x 1080';
    const fps = camera.fps || '30';
    const pillClass = getStatusPillClass(camera.status);

    article.innerHTML = `
      <div class="camera-preview">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 48px; height: 48px; opacity: 0.3;">
          <path d="M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
        <span>Live Preview Unavailable</span>
      </div>
      <div class="camera-meta">
        <div class="camera-title-row">
          <h4>${camera.camId}</h4>
          <span class="status-pill ${pillClass}">${camera.status}</span>
        </div>
        <div class="camera-details">
          <span>Station</span>
          <strong>${camera.location || 'N/A'}</strong>
        </div>
        <div class="camera-details">
          <span>IP Address</span>
          <strong>${ipAddress}</strong>
        </div>
        <div class="camera-details">
          <span>Resolution</span>
          <strong>${resolution}</strong>
        </div>
        <div class="camera-details">
          <span>FPS</span>
          <strong>${fps}</strong>
        </div>
        <div class="camera-details">
          <span>Last Detection</span>
          <strong>${lastDetection}</strong>
        </div>
        <div class="camera-details">
          <span>Last Connected Time</span>
          <strong>${lastConnected}</strong>
        </div>
      </div>
      <div class="camera-actions">
        <button type="button" data-action="view">View Camera</button>
        <button type="button" data-action="restart">Restart Camera</button>
        <button type="button" data-action="reconnect">Reconnect</button>
        <button type="button" class="light" data-action="settings">Settings</button>
      </div>
    `;

    // Add action listeners
    const actionButtons = article.querySelectorAll('[data-action]');
    actionButtons.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const action = btn.dataset.action;
        handleCameraAction(camera, action);
      });
    });

    return article;
  }

  function handleCameraAction(camera, action) {
    console.log(`Action "${action}" triggered for camera:`, camera.camId);
    
    switch (action) {
      case 'view':
        // Redirect to monitoring page with camera ID
        window.location.href = `./Live-Monitoring.html?cameraId=${encodeURIComponent(camera.camId)}`;
        break;
      case 'restart':
        showNotification(`Restarting camera ${camera.camId}...`, 'info');
        // TODO: Implement restart logic via Firebase
        break;
      case 'reconnect':
        showNotification(`Reconnecting camera ${camera.camId}...`, 'info');
        // TODO: Implement reconnect logic via Firebase
        break;
      case 'settings':
        showNotification(`Opening settings for ${camera.camId}...`, 'info');
        // TODO: Implement settings modal
        break;
    }
  }

  // ============ System Metrics Renderer ============
  function renderSystemMetrics() {
    const grid = document.getElementById('systemMetricsGrid');
    
    const onlineCameras = cameras.filter(c => c.status === 'ONLINE').length;
    const totalCameras = cameras.length;

    const metricsHTML = `
      <div class="card system-card usage-card">
        <div class="card-head">
          <h3>CPU Usage</h3>
          <span class="status-pill ${systemMetrics.cpu > 80 ? 'warn' : 'good'}">${systemMetrics.cpu}%</span>
        </div>
        <div class="meter"><span style="width:${systemMetrics.cpu}%"></span></div>
        <div class="card-sub">Average processor load</div>
      </div>

      <div class="card system-card usage-card">
        <div class="card-head">
          <h3>RAM Usage</h3>
          <span class="status-pill ${systemMetrics.ram > 80 ? 'warn' : 'good'}">${systemMetrics.ram}%</span>
        </div>
        <div class="meter"><span style="width:${systemMetrics.ram}%"></span></div>
        <div class="card-sub">Memory consumption</div>
      </div>

      <div class="card system-card usage-card">
        <div class="card-head">
          <h3>Disk Usage</h3>
          <span class="status-pill ${systemMetrics.disk > 80 ? 'warn' : 'good'}">${systemMetrics.disk}%</span>
        </div>
        <div class="meter"><span style="width:${systemMetrics.disk}%"></span></div>
        <div class="card-sub">System disk utilization</div>
      </div>

      <div class="card system-card usage-card">
        <div class="card-head">
          <h3>Storage Usage</h3>
          <span class="status-pill ${systemMetrics.storage > 80 ? 'warn' : 'good'}">${systemMetrics.storage}%</span>
        </div>
        <div class="meter"><span style="width:${systemMetrics.storage}%"></span></div>
        <div class="card-sub">Archive and media storage</div>
      </div>

      <div class="card system-card status-card">
        <div class="card-head">
          <h3>Database Status</h3>
          <span class="status-pill good">Online</span>
        </div>
        <div class="card-sub">Connected to reporting datastore</div>
        <div class="mini-meta">Latency: ${systemMetrics.dbLatency} ms</div>
      </div>

      <div class="card system-card status-card">
        <div class="card-head">
          <h3>Server Status</h3>
          <span class="status-pill good">Healthy</span>
        </div>
        <div class="card-sub">API and dashboard services responding</div>
        <div class="mini-meta">Uptime: ${formatUptime(systemMetrics.serverUptime)}</div>
      </div>

      <div class="card system-card status-card">
        <div class="card-head">
          <h3>Camera Status</h3>
          <span class="status-pill good">${onlineCameras}/${totalCameras} Online</span>
        </div>
        <div class="card-sub">All live feeds reporting</div>
        <div class="mini-meta">${totalCameras - onlineCameras} camera${totalCameras - onlineCameras !== 1 ? 's' : ''} awaiting sync</div>
      </div>

      <div class="card system-card status-card">
        <div class="card-head">
          <h3>YOLO Model Status</h3>
          <span class="status-pill good">Loaded</span>
        </div>
        <div class="card-sub">Latest detection model deployed</div>
        <div class="mini-meta">Version: v8.2.1</div>
      </div>

      <div class="card system-card status-card">
        <div class="card-head">
          <h3>System Uptime</h3>
          <span class="status-pill good">Stable</span>
        </div>
        <div class="uptime-value">${formatUptime(systemMetrics.serverUptime)}</div>
        <div class="card-sub">No restart events in the current window</div>
      </div>
    `;

    grid.innerHTML = metricsHTML;
  }

  function formatUptime(ms) {
    if (ms === 0) return '0h 0m';
    const days = Math.floor(ms / (1000 * 60 * 60 * 24));
    const hours = Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
    
    if (days > 0) {
      return `${days}d ${hours}h`;
    }
    return `${hours}h ${minutes}m`;
  }

  // ============ Camera Grid Renderer ============
  function renderCameras() {
    const grid = document.getElementById('cameraGrid');
    
    if (cameras.length === 0) {
      grid.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--muted);">
          <p>No cameras connected yet. <a href="#" id="addFirstCamera" style="color: var(--blue); text-decoration: none; font-weight: 600;">Add one now</a></p>
        </div>
      `;
      document.getElementById('addFirstCamera')?.addEventListener('click', (e) => {
        e.preventDefault();
        openModal();
      });
      return;
    }

    grid.innerHTML = '';
    cameras.forEach((camera) => {
      grid.appendChild(buildCameraCard(camera));
    });

    renderSystemMetrics();
  }

  // ============ Add Camera Handler ============
  addCameraForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const submitBtn = addCameraForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Adding...';

    try {
      const formData = {
        camId: document.getElementById('camId').value,
        title: document.getElementById('camTitle').value,
        location: document.getElementById('camLocation').value,
        ipAddress: document.getElementById('camIPAddress').value,
        resolution: document.getElementById('camResolution').value || '1920 x 1080',
        fps: parseInt(document.getElementById('camFPS').value) || 30,
        status: document.getElementById('camStatus').value,
        sectorLabel: document.getElementById('camSectorLabel').value || document.getElementById('camLocation').value,
        thumbnailUrl: 'https://picsum.photos/seed/' + document.getElementById('camId').value + '/1200/800',
        createdAt: serverTimestamp(),
        lastDetection: 'No detections recorded',
        lastConnected: 'Just now',
        detections: []
      };

      await addDoc(collection(db, 'camera_feeds'), formData);

      showNotification(`Camera ${formData.camId} added successfully!`, 'success');
      closeModal();
    } catch (error) {
      console.error('Error adding camera:', error);
      showNotification(`Error adding camera: ${error.message}`, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Add Camera';
    }
  });

  // ============ Refresh Status Handler ============
  document.getElementById('refreshStatusBtn').addEventListener('click', () => {
    const btn = document.getElementById('refreshStatusBtn');
    const originalHTML = btn.innerHTML;
    btn.disabled = true;

    // Add rotating animation
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 16px; height: 16px; display: inline; margin-right: 6px; animation: spin 1s linear infinite;">
        <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
      </svg>
      Refreshing...
    `;

    // Simulate refresh delay
    setTimeout(() => {
      btn.innerHTML = originalHTML;
      btn.disabled = false;
      showNotification('System metrics refreshed', 'success');
      
      // Update mock metrics
      systemMetrics.cpu = Math.floor(Math.random() * 80) + 10;
      systemMetrics.ram = Math.floor(Math.random() * 80) + 10;
      systemMetrics.disk = Math.floor(Math.random() * 60) + 10;
      systemMetrics.storage = Math.floor(Math.random() * 80) + 10;
      systemMetrics.dbLatency = Math.floor(Math.random() * 20) + 5;
      
      renderSystemMetrics();
    }, 1500);
  });

  // ============ Notification System ============
  function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;
    notification.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: ${type === 'success' ? 'var(--green)' : type === 'error' ? 'var(--red)' : 'var(--blue)'};
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      z-index: 9999;
      animation: slideIn 0.3s ease-out;
    `;

    document.body.appendChild(notification);

    setTimeout(() => {
      notification.style.animation = 'slideOut 0.3s ease-out';
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  }

  // Add animation styles
  const style = document.createElement('style');
  style.textContent = `
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    @keyframes slideIn {
      from { transform: translateX(400px); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideOut {
      from { transform: translateX(0); opacity: 1; }
      to { transform: translateX(400px); opacity: 0; }
    }
  `;
  document.head.appendChild(style);

  // ============ Initialize Firestore Listener ============
  function initializeFirestoreListener() {
    const cameraCollectionRef = collection(db, 'camera_feeds');

    onSnapshot(cameraCollectionRef, (snapshot) => {
      cameras = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        cameras.push({
          id: doc.id,
          camId: data.camId || doc.id,
          title: data.title || 'Unknown Camera',
          location: data.location || 'General Sector',
          ipAddress: data.ipAddress || 'N/A',
          resolution: data.resolution || '1920 x 1080',
          fps: data.fps || 30,
          status: data.status || 'ONLINE',
          sectorLabel: data.sectorLabel || data.location || 'Monitoring Area',
          lastDetection: data.lastDetection || 'No detections recorded',
          lastConnected: data.lastConnected || 'Just now',
          detections: data.detections || []
        });
      });

      renderCameras();
      updateLiveStatus();
    }, (error) => {
      console.error('Firestore sync error:', error);
      showNotification('Error syncing cameras', 'error');
    });
  }

  // ============ Update Live Status Text ============
  function updateLiveStatus() {
    const statusText = document.getElementById('liveStatusText');
    const onlineCameras = cameras.filter(c => c.status === 'ONLINE').length;
    statusText.textContent = `Live Stream · ${onlineCameras} of ${cameras.length} cameras online`;
  }

  // ============ Search Functionality ============
  document.getElementById('systemSearchInput').addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    const cameraCards = document.querySelectorAll('[data-camera-id]');
    
    cameraCards.forEach((card) => {
      const title = card.querySelector('h4')?.textContent.toLowerCase() || '';
      const shouldShow = title.includes(query);
      card.style.display = shouldShow ? '' : 'none';
    });
  });

  // ============ Initialize on Load ============
  document.addEventListener('DOMContentLoaded', () => {
    initializeFirestoreListener();
    
    // Initialize with mock metrics
    systemMetrics = {
      cpu: Math.floor(Math.random() * 80) + 10,
      ram: Math.floor(Math.random() * 80) + 10,
      disk: Math.floor(Math.random() * 60) + 10,
      storage: Math.floor(Math.random() * 80) + 10,
      dbLatency: Math.floor(Math.random() * 20) + 5,
      serverUptime: 99 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000,
      camerasOnline: 0,
      yoloStatus: 'Loaded'
    };
  });
})();

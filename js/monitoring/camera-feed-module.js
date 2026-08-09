import { auth, db } from "../shared/firebase-config.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

(function () {
  let cameras = [];
  let cameraLookup = {};

  const modeStorageKey = 'riversightViewMode';
  const cameraStorageKey = 'riversightSelectedCameraId';
  const MAX_ZOOM = 8;
  const MIN_ZOOM = 1;
  const ZOOM_STEP = 0.25;
  
  const spotlightState = {
    activeCameraId: null,
    mainZoom: MIN_ZOOM,
    mainPanX: 0,
    mainPanY: 0
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatCurrentTimestamp(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  function updateCamTimeLabels() {
    document.querySelectorAll('.cam-time').forEach((label) => {
      label.textContent = formatCurrentTimestamp();
    });
  }

  function readStoredValue(key, fallback) {
    try {
      const value = sessionStorage.getItem(key);
      return value || fallback;
    } catch (error) {
      return fallback;
    }
  }

  function persistValue(key, value) {
    try {
      sessionStorage.setItem(key, value);
    } catch (error) {
      console.warn('Unable to persist session value.', error);
    }
  }

  function getCameraById(cameraId) {
    return cameraLookup[cameraId] || cameras[0];
  }

  function resetMainStageZoom() {
    spotlightState.mainZoom = MIN_ZOOM;
    spotlightState.mainPanX = 0;
    spotlightState.mainPanY = 0;
  }

  function getInitialState() {
    if (cameras.length === 0) return { cameraId: null, viewMode: 'grid' };
    const params = new URLSearchParams(window.location.search);
    const cameraId = params.get('cameraId') || readStoredValue(cameraStorageKey, cameras[0].id);
    const viewMode = readStoredValue(modeStorageKey, 'grid');

    return {
      cameraId: getCameraById(cameraId) ? getCameraById(cameraId).id : cameras[0].id,
      viewMode: viewMode === 'fullscreen' ? 'fullscreen' : 'grid'
    };
  }

  function getViewModeButtons() {
    return Array.from(document.querySelectorAll('[data-view-mode]'));
  }

  function updateViewModeUI(viewMode) {
    getViewModeButtons().forEach((button) => {
      const isActive = button.dataset.viewMode === viewMode;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });
  }

  function updateBodyMode(viewMode) {
    document.body.classList.toggle('is-fullscreen', viewMode === 'fullscreen');
  }

  function updateFullscreenOverlay(viewMode) {
    let overlay = document.querySelector('[data-exit-fullscreen]');

    if (viewMode === 'fullscreen') {
      if (!overlay) {
        overlay = document.createElement('button');
        overlay.className = 'fullscreen-exit-btn';
        overlay.type = 'button';
        overlay.dataset.exitFullscreen = 'true';
        overlay.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">
            <path d="M6 6l12 12"/><path d="M18 6 6 18"/>
          </svg>
        `;
        overlay.setAttribute('aria-label', 'Exit full screen');
        document.body.appendChild(overlay);
      }
      return;
    }

    if (overlay) {
      overlay.remove();
    }
  }

  function createWasteDetectionButton(camera, isCompact = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `feed-action-btn${isCompact ? ' feed-action-btn--compact' : ''}`;
    button.dataset.wasteDetectionAction = 'true';
    button.setAttribute('aria-label', `View ${camera.id} in Waste Detection`);
    button.title = `View ${camera.id} in Waste Detection`;
    button.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z"/>
        <path d="m16 16 4 4"/>
      </svg>
      ${isCompact ? '' : '<span>View in Waste Detection</span>'}
    `;

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      navigateToWasteDetection(camera.id);
    });

    return button;
  }

  function buildFeedCard(camera, isActive) {
    const article = document.createElement('article');
    article.className = `feed-card${isActive ? ' feed-card--active' : ''}`;
    article.dataset.cameraId = camera.id;
    article.setAttribute('aria-label', `${camera.title} camera tile`);

    article.innerHTML = `
      <div class="feed-thumb" style="background-image:url('${camera.image}')">
        <div class="feed-overlay-bottom">
          <div class="cam-id">${camera.id}</div>
          <div class="cam-title">${camera.title}</div>
        </div>
        <span class="cam-time">${formatCurrentTimestamp()}</span>
        <span class="feed-card-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">
            <path d="M5 5h8v8H5z"/><path d="M11 5h8v8h-8z"/><path d="M5 11h8v8H5z"/><path d="M11 11h8v8h-8z"/>
          </svg>
        </span>
      </div>
    `;

    const thumb = article.querySelector('.feed-thumb');
    thumb.appendChild(createWasteDetectionButton(camera));

    return article;
  }

  function buildMainStageTile(camera) {
    const article = document.createElement('article');
    article.className = 'feed-card feed-card--spotlight-main';
    article.dataset.cameraId = camera.id;
    article.setAttribute('role', 'group');
    article.setAttribute('aria-label', `${camera.title} main stage`);

    article.innerHTML = `
      <div class="feed-tile-frame" data-feed-frame>
        <div class="feed-visual-layer" data-feed-layer>
          <img src="${camera.image}" alt="Live camera feed for ${camera.title}" class="feed-img feed-img--zoomable" data-feed-image>
          <div class="feed-overlay-layer">
            <div class="main-stage-badges">
              <div class="main-stage-badge overlay-pill feed-tag feed-tag-live"><span class="rec-dot"></span> LIVE 4K FEED</div>
              <div class="main-stage-badge overlay-pill feed-tag feed-tag-rec">● REC</div>
            </div>
            <div class="feed-sector-label overlay-pill">${camera.sectorLabel}</div>
            ${(camera.detections || []).map((detection) => `
              <div class="detect-box ${detection.className}" style="top:${detection.style?.top || '10%'}; left:${detection.style?.left || '10%'}; width:${detection.style?.width || '20%'}; height:${detection.style?.height || '20%'};">
                <span class="detect-label overlay-pill ${detection.className === 'box-orange' ? 'label-orange' : 'label-red'}">${detection.label}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="feed-tile-labels">
          <div class="feed-overlay-bottom">
            <div class="cam-id">${camera.id}</div>
            <div class="cam-title">${camera.title}</div>
          </div>
          <span class="cam-time overlay-pill">${formatCurrentTimestamp()}</span>
        </div>

        <div class="feed-tile-controls" data-tile-controls>
          <button class="feed-zoom-btn" type="button" data-zoom-out aria-label="Zoom out">−</button>
          <button class="feed-zoom-btn" type="button" data-zoom-in aria-label="Zoom in">+</button>
          <button class="feed-zoom-btn feed-zoom-btn--secondary" type="button" data-reset-zoom aria-label="Reset zoom">↺</button>
        </div>
        <div class="feed-action-slot"></div>
        <div class="feed-zoom-indicator" data-zoom-label>1.0x</div>
      </div>
    `;

    const frame = article.querySelector('[data-feed-frame]');
    const feedLayer = article.querySelector('[data-feed-layer]');
    const feedImage = article.querySelector('[data-feed-image]');
    const zoomLabel = article.querySelector('[data-zoom-label]');
    const zoomInButton = article.querySelector('[data-zoom-in]');
    const zoomOutButton = article.querySelector('[data-zoom-out]');
    const resetButton = article.querySelector('[data-reset-zoom]');
    let dragActive = false;
    let startX = 0, startY = 0, startPanX = 0, startPanY = 0, autoHideTimer = null;

    const setZoomLabel = () => {
      if (spotlightState.mainZoom > MIN_ZOOM) {
        zoomLabel.textContent = `${spotlightState.mainZoom.toFixed(1)}x`;
        zoomLabel.classList.add('is-visible');
        window.clearTimeout(autoHideTimer);
        autoHideTimer = window.setTimeout(() => zoomLabel.classList.remove('is-visible'), 1100);
      } else {
        zoomLabel.classList.remove('is-visible');
      }
    };

    const clampPan = () => {
      const frameRect = frame.getBoundingClientRect();
      const maxX = Math.max(0, (frameRect.width * spotlightState.mainZoom - frameRect.width) / 2);
      const maxY = Math.max(0, (frameRect.height * spotlightState.mainZoom - frameRect.height) / 2);
      spotlightState.mainPanX = clamp(spotlightState.mainPanX, -maxX, maxX);
      spotlightState.mainPanY = clamp(spotlightState.mainPanY, -maxY, maxY);
    };

    const applyTransform = () => {
      feedLayer.style.transform = `translate(${spotlightState.mainPanX}px, ${spotlightState.mainPanY}px)`;
      feedLayer.style.willChange = 'transform';
      feedImage.style.transform = `scale(${spotlightState.mainZoom})`;
      feedImage.style.willChange = 'transform';
      article.classList.toggle('feed-card--zoomed', spotlightState.mainZoom > MIN_ZOOM);
      setZoomLabel();
    };

    const setZoom = (nextZoom) => {
      spotlightState.mainZoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
      if (spotlightState.mainZoom === MIN_ZOOM) {
        spotlightState.mainPanX = 0;
        spotlightState.mainPanY = 0;
      } else {
        clampPan();
      }
      applyTransform();
    };

    zoomInButton.addEventListener('click', (e) => { e.stopPropagation(); setZoom(spotlightState.mainZoom + ZOOM_STEP); });
    zoomOutButton.addEventListener('click', (e) => { e.stopPropagation(); setZoom(spotlightState.mainZoom - ZOOM_STEP); });
    resetButton.addEventListener('click', (e) => { e.stopPropagation(); spotlightState.mainZoom = MIN_ZOOM; spotlightState.mainPanX = 0; spotlightState.mainPanY = 0; applyTransform(); });

    const actionSlot = article.querySelector('.feed-action-slot');
    actionSlot.appendChild(createWasteDetectionButton(camera));

    applyTransform();
    return article;
  }

  function buildThumbnailTile(camera) {
    const article = document.createElement('button');
    article.type = 'button';
    article.className = `feed-card feed-card--spotlight-thumb${spotlightState.activeCameraId === camera.id ? ' is-active' : ''}`;
    article.dataset.cameraId = camera.id;

    article.innerHTML = `
      <div class="thumbnail-tile-inner">
        <div class="thumbnail-tile-media">
          <img src="${camera.image}" alt="Live camera feed for ${camera.title}">
        </div>
        <div class="thumbnail-overlay">
          <span class="cam-time">${formatCurrentTimestamp()}</span>
          <div class="thumbnail-overlay-bottom">
            <div class="cam-id">${camera.id}</div>
            <div class="cam-title">${camera.title}</div>
          </div>
          <div class="thumbnail-action-slot"></div>
        </div>
      </div>
    `;

    article.addEventListener('click', (event) => {
      if (event.target.closest('[data-waste-detection-action]')) return;
      event.stopPropagation();
      spotlightState.activeCameraId = camera.id;
      resetMainStageZoom();
      renderLiveMonitoringPage({ viewMode: 'fullscreen', cameraId: camera.id });
    });

    const actionSlot = article.querySelector('.thumbnail-action-slot');
    actionSlot.appendChild(createWasteDetectionButton(camera, true));

    return article;
  }

  function renderLiveMonitoringPage(state) {
    const container = document.getElementById('feedsGrid');
    if (!container || cameras.length === 0) return;

    updateBodyMode(state.viewMode);
    updateViewModeUI(state.viewMode);
    updateFullscreenOverlay(state.viewMode);
    container.classList.toggle('feeds-grid--fullscreen', state.viewMode === 'fullscreen');
    container.innerHTML = '';

    updateCamTimeLabels();

    if (state.viewMode === 'fullscreen') {
      const mainCamera = getCameraById(spotlightState.activeCameraId || state.cameraId);
      const thumbnails = cameras.filter((cam) => cam.id !== mainCamera.id);
      const spotlightShell = document.createElement('div');
      spotlightShell.className = 'spotlight-shell';

      const mainStage = document.createElement('div');
      mainStage.className = 'spotlight-main-stage';
      mainStage.appendChild(buildMainStageTile(mainCamera));

      const thumbnailStrip = document.createElement('div');
      thumbnailStrip.className = 'spotlight-thumbnails';
      thumbnails.forEach((cam) => thumbnailStrip.appendChild(buildThumbnailTile(cam)));

      spotlightShell.appendChild(mainStage);
      spotlightShell.appendChild(thumbnailStrip);
      container.appendChild(spotlightShell);
      return;
    }

    cameras.forEach((camera) => {
      const isActive = camera.id === state.cameraId;
      container.appendChild(buildFeedCard(camera, isActive));
    });
  }

  function navigateToWasteDetection(cameraId) {
    persistValue(cameraStorageKey, cameraId);
    window.location.href = `./Waste-Management.html?cameraId=${encodeURIComponent(cameraId)}`;
  }

  function attachViewModeHandlers(state) {
    getViewModeButtons().forEach((button) => {
      button.addEventListener('click', () => {
        const nextMode = button.dataset.viewMode === 'fullscreen' ? 'fullscreen' : 'grid';
        state.viewMode = nextMode;
        persistValue(modeStorageKey, nextMode);
        renderLiveMonitoringPage(state);
      });
    });

    document.addEventListener('click', (event) => {
      if (event.target.closest('[data-exit-fullscreen]')) {
        event.preventDefault();
        state.viewMode = 'grid';
        persistValue(modeStorageKey, 'grid');
        renderLiveMonitoringPage(state);
      }
    });
  }

  // --- Real-Time Firestore Sync ---
// --- Real-Time Firestore Sync ---
  function initializeFirestoreListener() {
    updateCamTimeLabels();
    window.clearInterval(window.__riversightCamTimeTimer);
    window.__riversightCamTimeTimer = window.setInterval(updateCamTimeLabels, 1000);

    const cameraCollectionRef = collection(db, "camera_feeds");

    onSnapshot(cameraCollectionRef, (snapshot) => {
      cameras = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        cameras.push({
          id: data.camId || doc.id,
          title: data.title || "Unknown Creek",
          location: data.location || "General Sector",
          image: data.thumbnailUrl || data.image || "https://picsum.photos/seed/default/1200/800",
          time: data.timestamp || formatCurrentTimestamp(),
          status: data.status || "ONLINE",
          statusClass: data.statusClass ? data.statusClass : (data.status === 'OFFLINE' ? 'red' : (data.status === 'WEAK' ? 'orange' : 'green')),
          sectorLabel: data.sectorLabel || data.location || "Monitoring Area",
          detections: data.detections || []
        });
      });

      cameraLookup = Object.fromEntries(cameras.map((cam) => [cam.id, cam]));

      // 1. DYNAMICALLY UPDATE SOURCE COUNT TEXT
      const countLabel = document.getElementById('activeSourcesCount');
      if (countLabel) {
        countLabel.textContent = `${cameras.length} Active Source${cameras.length === 1 ? '' : 's'}`;
      }

      // 2. DYNAMICALLY UPDATE SIDEBAR SELECTOR LIST
      const sidebarContainer = document.getElementById('sidebarFeedSelector');
      if (sidebarContainer) {
        // Keep only the label element, remove old listings
        const labelEl = sidebarContainer.querySelector('.feed-selector-label');
        sidebarContainer.innerHTML = '';
        if (labelEl) sidebarContainer.appendChild(labelEl);

        cameras.forEach((camera) => {
          const state = getInitialState();
          const isSelected = camera.id === state.cameraId;
          
          const a = document.createElement('a');
          a.href = `./Live-Monitoring.html?cameraId=${encodeURIComponent(camera.id)}`;
          a.className = `feed-item ${isSelected ? 'active' : ''}`;
          a.innerHTML = `
            <span class="feed-dot ${camera.statusClass}"></span>
            <span class="feed-name">${camera.id}</span>
            <span class="feed-status">${camera.status}</span>
          `;
          sidebarContainer.appendChild(a);
        });
      }

      if (cameras.length > 0) {
        if (!spotlightState.activeCameraId) {
          spotlightState.activeCameraId = cameras[0].id;
        }
        const state = getInitialState();
        persistValue(cameraStorageKey, state.cameraId);

        if (document.body.dataset.page === 'live-monitoring') {
          renderLiveMonitoringPage(state);
          attachViewModeHandlers(state);
        }
      } else {
        // Clear grid view frame if collection holds zero documents
        const container = document.getElementById('feedsGrid');
        if (container) container.innerHTML = '<div style="padding:2rem;color:var(--text-muted)">No active operational sources connected.</div>';
      }
    }, (error) => {
      console.error("Firestore sync error:", error);
    });
  }
    document.addEventListener('DOMContentLoaded', initializeFirestoreListener);
})();
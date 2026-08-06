(function () {
  const cameras = [
    {
      id: 'CAM-001',
      title: 'Buwaya Creek (Main)',
      location: 'Main North Inlet Sector',
      image: 'https://picsum.photos/seed/cam001/1200/800',
      time: '2023-10-19 14:28:45',
      status: 'ONLINE',
      statusClass: 'green',
      sectorLabel: 'Main North Inlet Sector',
      detections: [
        { label: 'Plastic Bottle - 94.2%', className: 'box-red', style: { top: '38%', left: '6%', width: '15%', height: '22%' } },
        { label: 'Styrofoam Block - 91.0%', className: 'box-red', style: { top: '20%', left: '38%', width: '22%', height: '24%' } },
        { label: 'Organic Debris - 84.5%', className: 'box-orange', style: { top: '44%', left: '52%', width: '20%', height: '20%' } }
      ]
    },
    {
      id: 'CAM-002',
      title: 'Buwaya Creek (North)',
      location: 'North Channel',
      image: 'https://picsum.photos/seed/cam002/1200/800',
      time: '2023-10-19 14:28:45',
      status: 'ONLINE',
      statusClass: 'green',
      sectorLabel: 'North Channel',
      detections: [
        { label: 'Floating Debris - 87.4%', className: 'box-orange', style: { top: '28%', left: '16%', width: '18%', height: '24%' } },
        { label: 'Plastic Bag Cluster - 90.1%', className: 'box-red', style: { top: '40%', left: '48%', width: '22%', height: '20%' } }
      ]
    },
    {
      id: 'CAM-003',
      title: 'Tres Kantos Creek',
      location: 'East Basin',
      image: 'https://picsum.photos/seed/cam003/1200/800',
      time: '2023-10-19 14:28:45',
      status: 'ONLINE',
      statusClass: 'red',
      sectorLabel: 'East Basin',
      detections: [
        { label: 'Styrofoam Block - 92.6%', className: 'box-red', style: { top: '24%', left: '20%', width: '26%', height: '24%' } },
        { label: 'Branch Debris - 81.8%', className: 'box-orange', style: { top: '50%', left: '54%', width: '18%', height: '20%' } }
      ]
    },
    {
      id: 'CAM-004',
      title: 'Marilag Creek',
      location: 'West Outflow',
      image: 'https://picsum.photos/seed/cam004/1200/800',
      time: '2023-10-19 14:28:45',
      status: 'WEAK',
      statusClass: 'orange',
      sectorLabel: 'West Outflow',
      detections: [
        { label: 'Organic Debris - 83.0%', className: 'box-orange', style: { top: '34%', left: '12%', width: '18%', height: '20%' } },
        { label: 'Plastic Bottle - 88.4%', className: 'box-red', style: { top: '46%', left: '42%', width: '22%', height: '22%' } }
      ]
    }
  ];

  const cameraLookup = Object.fromEntries(cameras.map((camera) => [camera.id, camera]));
  const modeStorageKey = 'riversightViewMode';
  const cameraStorageKey = 'riversightSelectedCameraId';
  const MAX_ZOOM = 8;
  const MIN_ZOOM = 1;
  const ZOOM_STEP = 0.25;
  const spotlightState = {
    activeCameraId: cameras[0].id,
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

  function getTileState(cameraId) {
    if (!tileStates[cameraId]) {
      tileStates[cameraId] = { zoom: MIN_ZOOM, panX: 0, panY: 0 };
    }

    return tileStates[cameraId];
  }

  function resetMainStageZoom() {
    spotlightState.mainZoom = MIN_ZOOM;
    spotlightState.mainPanX = 0;
    spotlightState.mainPanY = 0;
  }

  function getInitialState() {
    const params = new URLSearchParams(window.location.search);
    const cameraId = params.get('cameraId') || readStoredValue(cameraStorageKey, cameras[0].id);
    const viewMode = readStoredValue(modeStorageKey, 'grid');

    return {
      cameraId: getCameraById(cameraId).id,
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
            ${camera.detections.map((detection) => `
              <div class="detect-box ${detection.className}" style="top:${detection.style.top}; left:${detection.style.left}; width:${detection.style.width}; height:${detection.style.height};">
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
    let startX = 0;
    let startY = 0;
    let startPanX = 0;
    let startPanY = 0;
    let autoHideTimer = null;

    const setZoomLabel = () => {
      if (spotlightState.mainZoom > MIN_ZOOM) {
        zoomLabel.textContent = `${spotlightState.mainZoom.toFixed(1)}x`;
        zoomLabel.classList.add('is-visible');
        window.clearTimeout(autoHideTimer);
        autoHideTimer = window.setTimeout(() => {
          zoomLabel.classList.remove('is-visible');
        }, 1100);
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
      feedLayer.style.transformOrigin = 'center center';
      feedLayer.style.willChange = 'transform';
      feedImage.style.transform = `scale(${spotlightState.mainZoom})`;
      feedImage.style.transformOrigin = 'center center';
      feedImage.style.willChange = 'transform';
      article.classList.toggle('feed-card--zoomed', spotlightState.mainZoom > MIN_ZOOM);
      setZoomLabel();
    };

    const resetView = () => {
      spotlightState.mainZoom = MIN_ZOOM;
      spotlightState.mainPanX = 0;
      spotlightState.mainPanY = 0;
      applyTransform();
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

    const stopTileInteraction = (event) => {
      event.stopPropagation();
    };

    zoomInButton.addEventListener('click', (event) => {
      stopTileInteraction(event);
      setZoom(spotlightState.mainZoom + ZOOM_STEP);
    });

    zoomOutButton.addEventListener('click', (event) => {
      stopTileInteraction(event);
      setZoom(spotlightState.mainZoom - ZOOM_STEP);
    });

    resetButton.addEventListener('click', (event) => {
      stopTileInteraction(event);
      resetView();
    });

    frame.addEventListener('wheel', (event) => {
      if (spotlightState.mainZoom === MIN_ZOOM && event.deltaY > 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const direction = event.deltaY < 0 ? 1 : -1;
      setZoom(spotlightState.mainZoom + direction * ZOOM_STEP);
    }, { passive: false });

    frame.addEventListener('pointerdown', (event) => {
      if (spotlightState.mainZoom <= MIN_ZOOM) {
        return;
      }
      dragActive = true;
      event.preventDefault();
      event.stopPropagation();
      startX = event.clientX;
      startY = event.clientY;
      startPanX = spotlightState.mainPanX;
      startPanY = spotlightState.mainPanY;
      frame.setPointerCapture(event.pointerId);
      article.classList.add('is-dragging');
    });

    frame.addEventListener('pointermove', (event) => {
      if (!dragActive) {
        return;
      }
      event.preventDefault();
      const deltaX = event.clientX - startX;
      const deltaY = event.clientY - startY;
      spotlightState.mainPanX = startPanX + deltaX;
      spotlightState.mainPanY = startPanY + deltaY;
      clampPan();
      applyTransform();
    });

    const endDrag = () => {
      if (!dragActive) {
        return;
      }
      dragActive = false;
      article.classList.remove('is-dragging');
    };

    frame.addEventListener('pointerup', endDrag);
    frame.addEventListener('pointerleave', endDrag);
    frame.addEventListener('pointercancel', endDrag);

    article.addEventListener('mouseenter', () => {
      article.classList.add('feed-card--hovered');
    });

    article.addEventListener('mouseleave', () => {
      article.classList.remove('feed-card--hovered');
    });

    article.addEventListener('click', (event) => {
      if (event.target.closest('[data-tile-controls], [data-zoom-in], [data-zoom-out], [data-reset-zoom], [data-waste-detection-action]')) {
        return;
      }
      if (dragActive) {
        dragActive = false;
        article.classList.remove('is-dragging');
      }
    });

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
    article.setAttribute('aria-label', `Show ${camera.title}`);

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
      if (event.target.closest('[data-waste-detection-action]')) {
        return;
      }
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
    if (!container) {
      return;
    }

    updateBodyMode(state.viewMode);
    updateViewModeUI(state.viewMode);
    updateFullscreenOverlay(state.viewMode);
    container.classList.toggle('feeds-grid--fullscreen', state.viewMode === 'fullscreen');
    container.innerHTML = '';

    updateCamTimeLabels();

    if (state.viewMode === 'fullscreen') {
      const mainCamera = getCameraById(spotlightState.activeCameraId || state.cameraId);
      const thumbnails = cameras.filter((camera) => camera.id !== mainCamera.id);
      const spotlightShell = document.createElement('div');
      spotlightShell.className = 'spotlight-shell';

      const mainStage = document.createElement('div');
      mainStage.className = 'spotlight-main-stage';
      mainStage.appendChild(buildMainStageTile(mainCamera));

      const thumbnailStrip = document.createElement('div');
      thumbnailStrip.className = 'spotlight-thumbnails';
      thumbnails.forEach((camera) => {
        thumbnailStrip.appendChild(buildThumbnailTile(camera));
      });

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

  function renderWasteDetectionPage(state) {
    const frame = document.querySelector('[data-camera-feed-frame]');
    const title = document.querySelector('[data-camera-title]');
    const streamTag = document.querySelector('[data-camera-stream-tag]');
    const sectionLabel = document.querySelector('[data-camera-sector-label]');
    const detailLabel = document.querySelector('[data-camera-detail-label]');
    const camera = getCameraById(state.cameraId);

    if (frame) {
      frame.innerHTML = `
        <img src="${camera.image}" alt="Live camera feed for ${camera.title}" class="feed-img">
        <div class="feed-tag feed-tag-live"><span class="rec-dot"></span> LIVE 4K FEED</div>
        <div class="feed-tag feed-tag-rec">● REC</div>
        <div class="feed-sector-label">${camera.sectorLabel}</div>
        ${camera.detections.map((detection) => `
          <div class="detect-box ${detection.className}" style="top:${detection.style.top}; left:${detection.style.left}; width:${detection.style.width}; height:${detection.style.height};">
            <span class="detect-label ${detection.className === 'box-orange' ? 'label-orange' : 'label-red'}">${detection.label}</span>
          </div>
        `).join('')}
      `;
    }

    if (title) {
      title.textContent = `AI Waste Detection Console · ${camera.id}`;
    }

    if (streamTag) {
      streamTag.textContent = `ACTIVE STREAM: ${camera.id}`;
    }

    if (sectionLabel) {
      sectionLabel.textContent = camera.sectorLabel;
    }

    if (detailLabel) {
      detailLabel.textContent = camera.title;
    }
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

  function initializePage() {
    const state = getInitialState();
    updateCamTimeLabels();
    window.clearInterval(window.__riversightCamTimeTimer);
    window.__riversightCamTimeTimer = window.setInterval(updateCamTimeLabels, 1000);
    persistValue(cameraStorageKey, state.cameraId);

    if (document.body.dataset.page === 'live-monitoring') {
      renderLiveMonitoringPage(state);
      attachViewModeHandlers(state);
      return;
    }

    if (document.body.dataset.page === 'waste-detection') {
      renderWasteDetectionPage(state);
    }
  }

  document.addEventListener('DOMContentLoaded', initializePage);
})();

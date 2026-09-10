import { db } from "../shared/firebase-config.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { normalizeRtspEmbedUrl } from "../shared/camera-embed.js";

(() => {
  const modeStorageKey = "riversightViewMode";
  const cameraStorageKey = "riversightSelectedCameraId";
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 8;
  const ZOOM_STEP = 0.25;
  let cameras = [];
  let cameraLookup = {};
  let currentState = { cameraId: null, viewMode: "grid" };
  const spotlightState = { activeCameraId: null, mainZoom: MIN_ZOOM };

  const readStoredValue = (key, fallback) => {
    try {
      return sessionStorage.getItem(key) || fallback;
    } catch {
      return fallback;
    }
  };

  const persistValue = (key, value) => {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // Storage is optional for the monitoring display.
    }
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function formatCurrentTimestamp(date = new Date()) {
    return date.toLocaleString("en-CA", { hour12: false }).replace(",", "");
  }

  function getCameraById(cameraId) {
    return cameraLookup[cameraId] || cameras[0] || null;
  }

  function getInitialState() {
    if (!cameras.length) return { cameraId: null, viewMode: "grid" };
    const queryCameraId = new URLSearchParams(window.location.search).get("cameraId");
    const storedCameraId = readStoredValue(cameraStorageKey, cameras[0].id);
    const selected = getCameraById(queryCameraId || storedCameraId) || cameras[0];
    return {
      cameraId: selected.id,
      viewMode: readStoredValue(modeStorageKey, "grid") === "fullscreen" ? "fullscreen" : "grid",
    };
  }

  function updateBodyMode(viewMode) {
    document.body.classList.toggle("is-fullscreen", viewMode === "fullscreen");
    document.querySelectorAll("[data-view-mode]").forEach((button) => {
      const active = button.dataset.viewMode === viewMode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function updateFullscreenOverlay(viewMode) {
    let button = document.querySelector("[data-exit-fullscreen]");
    if (viewMode === "fullscreen" && !button) {
      button = document.createElement("button");
      button.className = "fullscreen-exit-btn";
      button.type = "button";
      button.dataset.exitFullscreen = "true";
      button.setAttribute("aria-label", "Exit full screen");
      button.innerHTML = "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\"><path d=\"M6 6l12 12\"/><path d=\"M18 6 6 18\"/></svg>";
      document.body.appendChild(button);
    } else if (viewMode !== "fullscreen" && button) {
      button.remove();
    }
  }

  function createMedia(camera, className = "feed-media") {
    const embedUrl = normalizeRtspEmbedUrl(camera.embedUrl);
    if (embedUrl) {
      const iframe = document.createElement("iframe");
      iframe.className = `${className} feed-media-iframe`;
      iframe.src = embedUrl;
      iframe.title = `Live camera feed for ${camera.title}`;
      iframe.allow = "fullscreen; autoplay";
      iframe.allowFullscreen = true;
      return { element: iframe, isIframe: true };
    }

    const imageUrl = camera.image;
    if (imageUrl) {
      const image = document.createElement("img");
      image.className = `${className} feed-media-image`;
      image.src = imageUrl;
      image.alt = `Live camera feed for ${camera.title}`;
      return { element: image, isIframe: false };
    }

    const fallback = document.createElement("div");
    fallback.className = `${className} feed-media-unavailable`;
    fallback.textContent = "Live Preview Unavailable";
    return { element: fallback, isIframe: false };
  }

  function createWasteDetectionButton(camera, compact = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `feed-action-btn${compact ? " feed-action-btn--compact" : ""}`;
    button.dataset.wasteDetectionAction = "true";
    button.title = `View ${camera.id} in Waste Detection`;
    button.setAttribute("aria-label", `View ${camera.id} in Waste Detection`);
    button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z"/><path d="m16 16 4 4"/></svg>${compact ? "" : "<span>View in Waste Detection</span>"}`;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      persistValue(cameraStorageKey, camera.id);
      window.location.href = `./Waste-Management.html?cameraId=${encodeURIComponent(camera.id)}`;
    });
    return button;
  }

  function addCameraLabels(container, camera, spotlight = false) {
    const labels = document.createElement("div");
    labels.className = spotlight ? "feed-tile-labels" : "feed-overlay-bottom";
    labels.innerHTML = `<div class="cam-id">${camera.id}</div><div class="cam-title">${camera.title}</div>`;
    container.appendChild(labels);
  }

  function buildGridCard(camera, isActive) {
    const card = document.createElement("article");
    card.className = `feed-card${isActive ? " feed-card--active" : ""}`;
    card.dataset.cameraId = camera.id;
    card.setAttribute("aria-label", `${camera.title} camera tile`);

    const thumb = document.createElement("div");
    thumb.className = "feed-thumb";
    const media = createMedia(camera);
    thumb.appendChild(media.element);
    addCameraLabels(thumb, camera);
    const time = document.createElement("span");
    time.className = "cam-time";
    time.textContent = formatCurrentTimestamp();
    thumb.appendChild(time);
    thumb.appendChild(createWasteDetectionButton(camera));
    card.appendChild(thumb);
    return card;
  }

  function buildSpotlightMain(camera) {
    const card = document.createElement("article");
    card.className = "feed-card feed-card--spotlight-main";
    card.dataset.cameraId = camera.id;
    const frame = document.createElement("div");
    frame.className = "feed-tile-frame";
    const visual = document.createElement("div");
    visual.className = "feed-visual-layer";
    const media = createMedia(camera);
    visual.appendChild(media.element);
    frame.appendChild(visual);

    const overlay = document.createElement("div");
    overlay.className = "feed-overlay-layer";
    overlay.innerHTML = `<div class="main-stage-badges"><div class="main-stage-badge overlay-pill feed-tag feed-tag-live"><span class="rec-dot"></span> LIVE FEED</div><div class="main-stage-badge overlay-pill feed-tag feed-tag-rec">${camera.status}</div></div><div class="feed-sector-label overlay-pill">${camera.location || camera.sectorLabel}</div>`;
    frame.appendChild(overlay);
    addCameraLabels(frame, camera, true);

    const time = document.createElement("span");
    time.className = "cam-time overlay-pill spotlight-time";
    time.textContent = formatCurrentTimestamp();
    frame.querySelector(".feed-tile-labels").appendChild(time);

    const actionSlot = document.createElement("div");
    actionSlot.className = "feed-action-slot";
    actionSlot.appendChild(createWasteDetectionButton(camera));
    frame.appendChild(actionSlot);

    if (!media.isIframe) {
      const controls = document.createElement("div");
      controls.className = "feed-tile-controls";
      controls.innerHTML = `<button class="feed-zoom-btn" type="button" data-zoom-out aria-label="Zoom out">−</button><button class="feed-zoom-btn" type="button" data-zoom-in aria-label="Zoom in">+</button><button class="feed-zoom-btn feed-zoom-btn--secondary" type="button" data-reset-zoom aria-label="Reset zoom">↺</button>`;
      frame.appendChild(controls);
      const zoomLabel = document.createElement("div");
      zoomLabel.className = "feed-zoom-indicator";
      frame.appendChild(zoomLabel);
      bindImageZoom(card, visual, media.element, controls, zoomLabel);
    }

    card.appendChild(frame);
    return card;
  }

  function bindImageZoom(card, visual, image, controls, label) {
    const setZoom = (value) => {
      spotlightState.mainZoom = clamp(value, MIN_ZOOM, MAX_ZOOM);
      image.style.transform = `scale(${spotlightState.mainZoom})`;
      card.classList.toggle("feed-card--zoomed", spotlightState.mainZoom > MIN_ZOOM);
      label.textContent = `${spotlightState.mainZoom.toFixed(1)}x`;
      label.classList.toggle("is-visible", spotlightState.mainZoom > MIN_ZOOM);
    };
    controls.querySelector("[data-zoom-in]").addEventListener("click", (event) => { event.stopPropagation(); setZoom(spotlightState.mainZoom + ZOOM_STEP); });
    controls.querySelector("[data-zoom-out]").addEventListener("click", (event) => { event.stopPropagation(); setZoom(spotlightState.mainZoom - ZOOM_STEP); });
    controls.querySelector("[data-reset-zoom]").addEventListener("click", (event) => { event.stopPropagation(); setZoom(MIN_ZOOM); });
    setZoom(MIN_ZOOM);
  }

  function buildSpotlightThumbnail(camera) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `feed-card feed-card--spotlight-thumb${spotlightState.activeCameraId === camera.id ? " is-active" : ""}`;
    const inner = document.createElement("div");
    inner.className = "thumbnail-tile-inner";
    const media = createMedia(camera, "thumbnail-media");
    inner.appendChild(media.element);
    const overlay = document.createElement("div");
    overlay.className = "thumbnail-overlay";
    overlay.innerHTML = `<span class="cam-time">${formatCurrentTimestamp()}</span><div class="thumbnail-overlay-bottom"><div class="cam-id">${camera.id}</div><div class="cam-title">${camera.title}</div></div>`;
    overlay.appendChild(createWasteDetectionButton(camera, true));
    inner.appendChild(overlay);
    button.appendChild(inner);
    button.addEventListener("click", (event) => {
      if (event.target.closest("[data-waste-detection-action]")) return;
      spotlightState.activeCameraId = camera.id;
      renderLiveMonitoringPage({ viewMode: "fullscreen", cameraId: camera.id });
    });
    return button;
  }

  function renderLiveMonitoringPage(state) {
    const container = document.getElementById("feedsGrid");
    if (!container || !cameras.length) return;
    currentState = state;
    updateBodyMode(state.viewMode);
    updateFullscreenOverlay(state.viewMode);
    container.classList.toggle("feeds-grid--fullscreen", state.viewMode === "fullscreen");
    container.replaceChildren();

    if (state.viewMode === "fullscreen") {
      const mainCamera = getCameraById(spotlightState.activeCameraId || state.cameraId);
      const shell = document.createElement("div");
      shell.className = "spotlight-shell";
      const stage = document.createElement("div");
      stage.className = "spotlight-main-stage";
      stage.appendChild(buildSpotlightMain(mainCamera));
      const thumbs = document.createElement("div");
      thumbs.className = "spotlight-thumbnails";
      cameras.filter((camera) => camera.id !== mainCamera.id).forEach((camera) => thumbs.appendChild(buildSpotlightThumbnail(camera)));
      shell.append(stage, thumbs);
      container.appendChild(shell);
      return;
    }

    cameras.forEach((camera) => container.appendChild(buildGridCard(camera, camera.id === state.cameraId)));
  }

  function renderSidebar() {
    const sidebar = document.getElementById("sidebarFeedSelector");
    if (!sidebar) return;
    const label = sidebar.querySelector(".feed-selector-label");
    sidebar.replaceChildren();
    if (label) sidebar.appendChild(label);
    cameras.forEach((camera) => {
      const link = document.createElement("a");
      link.className = `feed-item${camera.id === currentState.cameraId ? " active" : ""}`;
      link.href = `./Live-Monitoring.html?cameraId=${encodeURIComponent(camera.id)}`;
      link.innerHTML = `<span class="feed-dot ${camera.statusClass}"></span><span class="feed-name">${camera.id}</span><span class="feed-status">${camera.status}</span>`;
      sidebar.appendChild(link);
    });
  }

  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-exit-fullscreen]")) {
      persistValue(modeStorageKey, "grid");
      renderLiveMonitoringPage({ viewMode: "grid", cameraId: currentState.cameraId });
    }
  });

  document.querySelectorAll("[data-view-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      const viewMode = button.dataset.viewMode === "fullscreen" ? "fullscreen" : "grid";
      persistValue(modeStorageKey, viewMode);
      renderLiveMonitoringPage({ viewMode, cameraId: currentState.cameraId });
    });
  });

  document.addEventListener("DOMContentLoaded", () => {
    onSnapshot(collection(db, "camera_feeds"), (snapshot) => {
      cameras = snapshot.docs.map((cameraDoc) => {
        const data = cameraDoc.data();
        return {
          id: data.camId || cameraDoc.id,
          title: data.title || data.camId || "Unknown Camera",
          location: data.location || data.sectorLabel || "General Sector",
          sectorLabel: data.sectorLabel || data.location || "Monitoring Area",
          status: data.status || "ONLINE",
          statusClass: data.status === "OFFLINE" ? "red" : data.status === "WEAK" ? "orange" : "green",
          embedUrl: data.embedUrl || "",
          image: data.thumbnailUrl || data.image || "",
        };
      });
      cameraLookup = Object.fromEntries(cameras.map((camera) => [camera.id, camera]));
      const count = document.getElementById("activeSourcesCount");
      if (count) count.textContent = `${cameras.length} Active Source${cameras.length === 1 ? "" : "s"}`;
      if (!cameras.length) {
        document.getElementById("feedsGrid")?.replaceChildren(Object.assign(document.createElement("div"), { textContent: "No active operational sources connected." }));
        return;
      }
      const state = getInitialState();
      spotlightState.activeCameraId = spotlightState.activeCameraId || state.cameraId;
      currentState = state;
      persistValue(cameraStorageKey, state.cameraId);
      renderSidebar();
      renderLiveMonitoringPage(state);
    }, (error) => console.error("Firestore sync error:", error));
  });
})();

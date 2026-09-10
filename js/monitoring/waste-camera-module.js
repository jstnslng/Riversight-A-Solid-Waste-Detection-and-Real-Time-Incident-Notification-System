import { db } from "../shared/firebase-config.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getRtspEmbedIssue, normalizeRtspEmbedUrl } from "../shared/camera-embed.js";

(() => {
  const selector = document.getElementById("wasteCameraSelect");
  const frame = document.querySelector("[data-camera-feed-frame]");
  const title = document.querySelector("[data-camera-title]");
  const streamTag = document.querySelector("[data-camera-stream-tag]");
  const sectorLabel = document.querySelector("[data-camera-sector-label]");
  const reportsLink = document.querySelector("[data-incident-eval-link]");
  let cameras = [];

  function createMedia(camera) {
    const embedUrl = normalizeRtspEmbedUrl(camera.embedUrl);
    const embedIssue = getRtspEmbedIssue(camera.embedUrl);
    if (embedIssue) {
      console.warn(`Camera feed unavailable: ${embedIssue} (${camera.id})`);
    }
    if (embedUrl) {
      const iframe = document.createElement("iframe");
      iframe.className = "feed-img feed-img--iframe";
      iframe.src = embedUrl;
      iframe.title = `Live camera feed for ${camera.title}`;
      iframe.allow = "fullscreen; autoplay";
      iframe.allowFullscreen = true;
      iframe.addEventListener("error", () => {
        console.error(`Camera iframe rendering issue (${camera.id})`);
      }, { once: true });
      return iframe;
    }

    if (camera.image) {
      const image = document.createElement("img");
      image.className = "feed-img";
      image.src = camera.image;
      image.alt = `Live camera feed for ${camera.title}`;
      return image;
    }

    const fallback = document.createElement("div");
    fallback.className = "feed-img feed-img--unavailable";
    fallback.textContent = "Live Preview Unavailable";
    return fallback;
  }

  function selectCamera(cameraId) {
    const camera = cameras.find((item) => item.id === cameraId) || cameras[0];
    if (!camera || !frame) return;

    frame.querySelectorAll(".feed-img").forEach((media) => media.remove());
    frame.insertBefore(createMedia(camera), frame.firstChild);

    if (title) title.textContent = `${camera.title} Waste Detection`;
    if (streamTag) streamTag.textContent = `ACTIVE STREAM: ${camera.id} · ${camera.status}`;
    if (sectorLabel) sectorLabel.textContent = camera.location || camera.sectorLabel;
    if (reportsLink) reportsLink.href = `./Incident-Reports.html?cameraId=${encodeURIComponent(camera.id)}`;
  }

  function showUnavailableFeed() {
    if (!frame) return;
    frame.querySelectorAll(".feed-img").forEach((media) => media.remove());
    const fallback = document.createElement("div");
    fallback.className = "feed-img feed-img--unavailable";
    fallback.textContent = "Live Preview Unavailable";
    frame.insertBefore(fallback, frame.firstChild);
  }

  function renderSelector() {
    selector.replaceChildren();
    cameras.forEach((camera) => {
      const option = document.createElement("option");
      option.value = camera.id;
      option.textContent = `${camera.id} · ${camera.title}`;
      selector.appendChild(option);
    });

    const requestedId = new URLSearchParams(window.location.search).get("cameraId");
    const selectedId = cameras.some((camera) => camera.id === requestedId) ? requestedId : cameras[0]?.id;
    if (selectedId) {
      selector.value = selectedId;
      selectCamera(selectedId);
    }
  }

  if (selector) selector.addEventListener("change", () => selectCamera(selector.value));

  onSnapshot(collection(db, "camera_feeds"), (snapshot) => {
    cameras = snapshot.docs.map((cameraDoc) => {
      const data = cameraDoc.data();
      return {
        id: data.camId || cameraDoc.id,
        title: data.title || data.camId || "Unknown Camera",
        location: data.location || data.sectorLabel || "General Sector",
        sectorLabel: data.sectorLabel || data.location || "Monitoring Area",
        status: data.status || "ONLINE",
        embedUrl: data.embedUrl || "",
        image: data.thumbnailUrl || data.image || "",
      };
    });

    if (!selector) return;
    if (!cameras.length) {
      console.warn("Camera record missing: camera_feeds is empty");
      selector.replaceChildren(new Option("No cameras configured", ""));
      showUnavailableFeed();
      if (title) title.textContent = "AI Waste Detection Console";
      if (streamTag) streamTag.textContent = "NO ACTIVE CAMERA FEEDS";
      return;
    }
    renderSelector();
  }, (error) => {
    console.error("Failed to load camera_feeds from Firestore (Waste Detection):", error);
    if (selector) selector.replaceChildren(new Option("Camera feeds unavailable", ""));
    showUnavailableFeed();
  });
})();

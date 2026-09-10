import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { db } from "../shared/firebase-config.js";
import { normalizeRtspEmbedUrl } from "../shared/camera-embed.js";

const cameraGrid = document.getElementById("dashboardCameraGrid");

function createText(tagName, text, className) {
  const element = document.createElement(tagName);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function createCameraCard(camera) {
  const card = document.createElement("article");
  card.className = "dashboard-camera-item";

  const preview = document.createElement("div");
  preview.className = "dashboard-camera-preview";
  const embedUrl = normalizeRtspEmbedUrl(camera.embedUrl);

  if (embedUrl) {
    const iframe = document.createElement("iframe");
    iframe.src = embedUrl;
    iframe.title = `${camera.title} live preview`;
    iframe.allow = "fullscreen; autoplay";
    iframe.allowFullscreen = true;
    preview.appendChild(iframe);
  } else {
    preview.appendChild(createText("span", "Live Preview Unavailable", "dashboard-camera-unavailable"));
  }

  const details = document.createElement("div");
  details.className = "dashboard-camera-details";
  details.appendChild(createText("strong", camera.title, "dashboard-camera-title"));
  details.appendChild(createText("span", camera.location, "dashboard-camera-location"));
  details.appendChild(createText("span", camera.status, `dashboard-camera-status ${camera.status.toLowerCase()}`));

  card.append(preview, details);
  return card;
}

function renderCameras(snapshot) {
  cameraGrid.replaceChildren();
  if (snapshot.empty) {
    cameraGrid.appendChild(createText("div", "No cameras configured yet.", "dashboard-camera-empty"));
    return;
  }

  snapshot.forEach((cameraDoc) => {
    const data = cameraDoc.data();
    cameraGrid.appendChild(createCameraCard({
      title: data.title || data.camId || cameraDoc.id,
      location: data.location || "General Sector",
      status: data.status || "ONLINE",
      embedUrl: data.embedUrl || "",
    }));
  });
}

if (cameraGrid) {
  onSnapshot(collection(db, "camera_feeds"), renderCameras, (error) => {
    console.error("Failed to load dashboard camera feeds:", error);
    cameraGrid.replaceChildren(createText("div", "Camera feeds unavailable.", "dashboard-camera-empty"));
  });
}

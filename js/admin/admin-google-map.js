import { sampleDetections } from "./detection-data.js";

const DEFAULT_CENTER = { lat: 14.626659, lng: 121.06528 };
const MAP_SCRIPT_ID = "google-maps-javascript-api";

function getApiKey() {
  // Configure VITE_GOOGLE_MAPS_API_KEY in the deployment environment. Static hosting
  // should expose it as window.__RIVERSIGHT_ENV__.VITE_GOOGLE_MAPS_API_KEY.
  return window.__RIVERSIGHT_ENV__?.VITE_GOOGLE_MAPS_API_KEY || "";
}

function setMapStatus(statusElement, message) {
  statusElement.textContent = message;
  statusElement.hidden = false;
}

function loadGoogleMaps(apiKey) {
  if (window.google?.maps?.importLibrary) {
    return Promise.resolve(window.google.maps);
  }

  return new Promise((resolve, reject) => {
    const existingScript = document.getElementById(MAP_SCRIPT_ID);
    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(window.google.maps), { once: true });
      existingScript.addEventListener("error", () => reject(new Error("Google Maps failed to load.")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.id = MAP_SCRIPT_ID;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(window.google.maps);
    script.onerror = () => reject(new Error("Google Maps failed to load."));
    document.head.appendChild(script);
  });
}

function markerColor(severity) {
  return { Low: "#1a9e57", Medium: "#e0a020", High: "#d33c3c" }[severity] || "#111111";
}

function createMarkerContent(detection) {
  const marker = document.createElement("div");
  marker.className = `river-marker river-marker-${detection.severity.toLowerCase()}`;
  marker.title = `${detection.cameraId}: ${detection.detectionType}`;
  marker.style.backgroundColor = markerColor(detection.severity);
  return marker;
}

function infoContent(detection) {
  const content = document.createElement("div");
  content.className = `map-info-window map-info-${detection.severity.toLowerCase()}`;

  const cameraLabel = document.createElement("strong");
  cameraLabel.textContent = detection.cameraId;
  content.appendChild(cameraLabel);

  ["Detection:", "Severity Level:", "Confidence:", "Detected:"].forEach((label) => {
    const row = document.createElement("div");
    row.append(document.createTextNode(`${label} `), document.createElement("b"));
    content.appendChild(row);
  });

  return content;
}

async function initializeMap() {
  const mapElement = document.getElementById("riverSightMap");
  const statusElement = document.getElementById("mapStatus");
  if (!mapElement || !statusElement) return;

  const apiKey = getApiKey();
  if (!apiKey) {
    setMapStatus(statusElement, "Map unavailable - configure Google Maps API key");
    return;
  }

  try {
    const googleMaps = await loadGoogleMaps(apiKey);
    const [{ Map }, { AdvancedMarkerElement }] = await Promise.all([
      googleMaps.importLibrary("maps"),
      googleMaps.importLibrary("marker"),
    ]);
    const map = new Map(mapElement, {
      center: DEFAULT_CENTER,
      zoom: 13,
      mapId: "DEMO_MAP_ID",
      mapTypeId: "satellite",
      streetViewControl: false,
      mapTypeControl: false,
      fullscreenControl: false,
    });
    const infoWindow = new googleMaps.InfoWindow();
    const markers = sampleDetections.map((detection) => {
      const marker = new AdvancedMarkerElement({
        map,
        position: { lat: detection.latitude, lng: detection.longitude },
        title: detection.cameraId,
        content: createMarkerContent(detection),
      });
      marker.addListener("click", () => {
        infoWindow.setContent(infoContent(detection));
        infoWindow.open({ map, anchor: marker });
      });
      return marker;
    });

    document.querySelectorAll("[data-map-type]").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll("[data-map-type]").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        map.setMapTypeId(button.dataset.mapType);
      });
    });

    const liveButton = document.querySelector(".live-map-pill");
    liveButton?.addEventListener("click", () => {
      const isLive = liveButton.getAttribute("aria-pressed") === "true";
      liveButton.setAttribute("aria-pressed", String(!isLive));
      liveButton.classList.toggle("is-off", isLive);
      markers.forEach((marker) => { marker.map = isLive ? null : map; });
    });

    statusElement.hidden = true;
  } catch (error) {
    console.error(error);
    setMapStatus(statusElement, "Map unavailable - check the Google Maps API configuration");
  }
}

initializeMap();
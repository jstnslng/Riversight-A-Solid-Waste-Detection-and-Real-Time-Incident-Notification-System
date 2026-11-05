const status = document.querySelector("[data-processor-status]");
const label = document.querySelector("[data-processor-label]");
const detail = document.querySelector("[data-processor-detail]");
const updated = document.querySelector("[data-processor-updated]");
const backend = document.querySelector('meta[name="riversight-ai-backend"]')?.content?.replace(/\/+$/, "");

function render(kind, text, lastUpdate) {
  if (label) label.textContent = `AI Processor Status: ${kind}`;
  if (detail) detail.textContent = text;
  if (updated) updated.textContent = lastUpdate ? `LAST UPDATE: ${lastUpdate}` : "LAST UPDATE: —";
  if (status) status.dataset.processorState = kind.toLowerCase();
}

async function checkHealth() {
  const cameraDocId = document.querySelector("[data-camera-feed-frame]")?.dataset.cameraDocId;
  if (!backend || !cameraDocId || !window.riversightAIIdToken) {
    render("UNAVAILABLE", "Bridge configuration is incomplete", null);
    return;
  }
  try {
    const request = async (forceRefresh = false) => {
      const token = await window.riversightAIIdToken(forceRefresh);
      return fetch(`${backend}/feed-health?cameraDocId=${encodeURIComponent(cameraDocId)}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store"
      });
    };
    let response = await request();
    if (response.status === 401 || response.status === 403) response = await request(true);
    if (!response.ok) throw new Error(`health_${response.status}`);
    const health = await response.json();
    const last = health.lastInferenceAt ? new Date(health.lastInferenceAt) : null;
    const age = last ? Date.now() - last.getTime() : Infinity;
    if (health.status === "ok" && health.cameraDocId === cameraDocId
      && health.latestFrameAvailable && age < 15000) {
      render("ONLINE", "Nodes synchronized", last.toLocaleTimeString());
    } else {
      render("DEGRADED", health.status === "ok" ? "Inference data is stale or mismatched"
        : "Inference unavailable",
        last?.toLocaleTimeString() || null);
    }
  } catch (error) {
    console.error("Could not read AI processor health:", error);
    render("OFFLINE", "Bridge health check failed", null);
  }
}

document.addEventListener("riversight:camera-selected", checkHealth);
document.addEventListener("riversight:ai-auth-changed", checkHealth);
setInterval(checkHealth, 15000);
checkHealth();

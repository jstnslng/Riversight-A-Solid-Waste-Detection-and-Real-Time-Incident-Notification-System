/* One camera display: exact-frame AI first, selected camera's live feed fallback. */
(() => {
  const frame = document.querySelector('[data-camera-feed-frame]');
  const image = document.querySelector('[data-segmentation-image]');
  const status = document.querySelector('[data-segmentation-status]');
  const source = document.querySelector('[data-feed-source-label]');
  if (!frame || !image || !status) return;
  const configuredBase = document.querySelector('meta[name="riversight-ai-backend"]')?.content?.trim();
  const secure = Boolean(configuredBase) || window.location.protocol === 'https:';
  let base = 'http://127.0.0.1:5001';
  let configurationValid = !secure;
  if (configuredBase) {
    try {
      const parsed = new URL(configuredBase);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search
          || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) throw new Error();
      base = parsed.origin;
      configurationValid = true;
    } catch { configurationValid = false; }
  }
  const staleMs = 15000;
  const unavailable = 'AI detection unavailable — showing live camera feed';
  if (window.location.protocol === 'file:') {
    console.warn('RiverSight AI segmentation requires the site to be served over HTTP. Open http://127.0.0.1:8000/lib/monitoring/Waste-Management.html through the local development server instead of file://.');
  }
  let busy = false, stopped = false, generation = 0;
  let timer, expiryTimer, controller, currentUrl, streamUrl, streamTimer, streamId;
  let streamLoaded = false;
  let streamExpires = 0;

  function fallback(message) {
    clearTimeout(expiryTimer);
    clearTimeout(streamTimer);
    image.onload = image.onerror = null;
    streamUrl = null;
    streamId = null;
    streamExpires = 0;
    streamLoaded = false;
    frame.classList.remove('is-ai-active');
    image.hidden = true;
    status.textContent = message;
    if (source) source.textContent = 'LIVE CAMERA';
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = null;
    image.removeAttribute('src');
  }
  function fresh(value) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && Date.now() - timestamp < staleMs && timestamp <= Date.now() + 5000;
  }
  async function showStream(cameraId, version, timestamp, trackingEnabled, options, stillCurrent) {
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => fallback(unavailable), Math.max(0, staleMs - (Date.now() - Date.parse(timestamp))));
    if (streamUrl && (!secure || Date.now() < streamExpires)) return;
    if (streamUrl) {
      fallback('Renewing secure AI stream...');
      // fallback clears timers; retain freshness protection during renewal.
      expiryTimer = setTimeout(() => fallback(unavailable), Math.max(0, staleMs - (Date.now() - Date.parse(timestamp))));
    }
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = null;
    // Non-secret connection identity lets health detect a closed multipart image,
    // even in browsers that do not fire another image event after its first part.
    streamId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let url = `${base}/segmentation-stream.mjpg?cameraDocId=${encodeURIComponent(cameraId)}&streamId=${streamId}`;
    if (secure) {
      const response = await fetch(`${base}/stream-ticket?cameraDocId=${encodeURIComponent(cameraId)}`,
        {...options, method: 'POST'});
      if (!response.ok) throw new Error('Unavailable');
      const result = await response.json();
      if (!stillCurrent()) return;
      if (!fresh(timestamp)) throw new Error('Stale');
      if (!/^[A-Za-z0-9_-]{40,64}$/.test(result.ticket)) throw new Error('Unavailable');
      url += `&ticket=${encodeURIComponent(result.ticket)}`;
      streamExpires = Date.now() + 55000;
    }
    streamUrl = url;
    const current = () => !stopped && !document.hidden && generation === version
      && frame.dataset.cameraDocId === cameraId && streamUrl === url;
    image.onload = () => {
      if (!current()) return;
      clearTimeout(streamTimer);
      streamLoaded = true;
      image.hidden = false;
      frame.classList.add('is-ai-active');
      status.textContent = trackingEnabled
        ? '● YOLOv8n-seg + Tracking — positions estimated; confidence from last YOLO result'
        : '● YOLOv8n-seg ACTIVE — live camera; exact results in evidence snapshot';
      if (source) source.textContent = trackingEnabled ? 'AI LIVE + TRACKING' : 'AI LIVE STREAM';
    };
    image.onerror = () => { if (current()) fallback(unavailable); };
    streamTimer = setTimeout(() => { if (current()) fallback(unavailable); }, 8000);
    // CORS mode sends Origin and excludes cross-origin credentials. The server
    // also validates the selected document ID before starting this response.
    image.crossOrigin = 'anonymous';
    image.src = url;
  }
  async function poll() {
    if (busy || stopped || document.hidden) return;
    const cameraId = frame.dataset.cameraDocId;
    if (!cameraId) {
      fallback('Waiting for camera selection...');
      timer = setTimeout(poll, 1500);
      return;
    }
    const version = generation;
    busy = true;
    const request = controller = new AbortController();
    const timeout = setTimeout(() => request.abort(), 8000);
    const stillCurrent = () => !stopped && !document.hidden && version === generation
      && cameraId === frame.dataset.cameraDocId && !request.signal.aborted;
    let nextUrl;
    try {
      if (!configurationValid) throw new Error('Backend configuration required');
      const options = {cache: 'no-store', credentials: 'omit', signal: request.signal};
      if (secure) {
        if (!window.riversightAIIdToken) throw new Error('Authentication unavailable');
        const token = await window.riversightAIIdToken();
        if (!stillCurrent()) return;
        options.headers = {Authorization: `Bearer ${token}`};
      }
      const identity = secure ? `&cameraDocId=${encodeURIComponent(cameraId)}` : '';
      const healthResponse = await fetch(`${base}/${secure ? 'feed-health' : 'health'}?t=${Date.now()}${identity}${streamId ? `&streamId=${streamId}` : ''}`, options);
      if (!healthResponse.ok) throw new Error('Unavailable');
      const health = await healthResponse.json();
      if (!stillCurrent()) return;
      if (!health.cameraDocId || health.cameraDocId !== cameraId) {
        fallback('AI processing is not active for this camera');
        return;
      }
      if (!health.latestFrameAvailable) {
        fallback(unavailable);
        return;
      }
      if (health.status !== 'ok' || !fresh(health.lastInferenceAt)) {
        fallback(unavailable);
        return;
      }
      if (health.streamEnabled) {
        if (!health.streamAvailable || !health.captureActive || !fresh(health.lastFrameAt)) {
          fallback(unavailable);
          return;
        }
        if (streamLoaded && health.streamClientActive === false) {
          fallback(unavailable);
          return;
        }
        await showStream(cameraId, version, health.lastInferenceAt, health.trackingEnabled === true, options, stillCurrent);
        return;
      }
      // Snapshot-only configuration (FPS=0) and older bridges remain supported.
      if (streamUrl) fallback('Waiting for AI detection...');
      const response = await fetch(`${base}/latest-segmentation.jpg?t=${Date.now()}${identity}`, options);
      if (!stillCurrent()) return;
      const timestamp = response.headers.get('X-Inference-At');
      // Validate the JPEG snapshot itself against restart/identity/freshness races.
      if (!response.ok || !response.headers.get('Content-Type')?.startsWith('image/jpeg')
          || response.headers.get('X-Camera-Doc-Id') !== cameraId
          || response.headers.get('X-Feed-Status') !== 'ok' || !fresh(timestamp)) {
        throw new Error('Unavailable');
      }
      nextUrl = URL.createObjectURL(await response.blob());
      const decoded = new Image();
      decoded.src = nextUrl;
      await decoded.decode();
      if (!stillCurrent()) return;
      if (!fresh(timestamp)) throw new Error('Stale');
      image.src = nextUrl;
      image.hidden = false;
      frame.classList.add('is-ai-active');
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      currentUrl = nextUrl;
      nextUrl = null;
      status.textContent = '● YOLOv8n-seg ACTIVE';
      if (source) source.textContent = 'AI PROCESSED FRAME';
      clearTimeout(expiryTimer);
      expiryTimer = setTimeout(() => fallback(unavailable), Math.max(0, staleMs - (Date.now() - Date.parse(timestamp))));
    } catch {
      if (!stopped && !document.hidden && version === generation) fallback(unavailable);
    } finally {
      if (nextUrl) URL.revokeObjectURL(nextUrl);
      clearTimeout(timeout);
      controller = null;
      busy = false;
      if (!stopped && !document.hidden) timer = setTimeout(poll, 1500);
    }
  }
  function reset() {
    generation++;
    clearTimeout(timer);
    controller?.abort();
    fallback('Waiting for AI detection...');
    poll();
  }
  document.addEventListener('riversight:camera-selected', reset);
  document.addEventListener('riversight:ai-auth-changed', reset);
  document.addEventListener('visibilitychange', reset);
  window.addEventListener('pagehide', () => { stopped = true; reset(); });
  window.addEventListener('pageshow', () => { stopped = false; reset(); });
  poll();
})();

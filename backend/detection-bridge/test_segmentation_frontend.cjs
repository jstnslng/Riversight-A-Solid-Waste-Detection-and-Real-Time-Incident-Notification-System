// Offline unified-view DOM/fetch tests; no browser network or private configuration.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'js/monitoring/segmentation-feed.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'lib/monitoring/Waste-Management.html'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const now = Date.now();
function setup(fetch, cameraId = 'doc-1', protocol = 'http:', configuredBase = '', tokenProvider, clock) {
  const classes = new Set();
  const iframe = {};
  const frame = {dataset: {cameraDocId: cameraId}, iframe, classList: {add: key => classes.add(key), remove: key => classes.delete(key)}};
  const image = {hidden: true, removeAttribute(key) { delete this[key]; }};
  const status = {textContent: ''}, label = {textContent: ''};
  const selectors = {'[data-camera-feed-frame]': frame, '[data-segmentation-image]': image, '[data-segmentation-status]': status, '[data-feed-source-label]': label};
  selectors['meta[name="riversight-ai-backend"]'] = {content: configuredBase};
  const timers = new Map(); let id = 0, serial = 0;
  const document = {hidden: false, querySelector: s => selectors[s], addEventListener(event, fn) {this[event] = fn;}};
  const warnings = [];
  const window = {location: {protocol}, addEventListener(event, fn) {this[event] = fn;}};
  window.riversightAIIdToken = tokenProvider;
  vm.runInNewContext(source, {document, window, fetch, AbortController, Date: clock ? class extends Date {static now() {return clock.now;}} : Date,
    console: {warn: message => warnings.push(message)},
    setTimeout(fn, delay) {timers.set(++id, {fn, delay}); return id;}, clearTimeout(id) {timers.delete(id);},
    URL: class extends URL {static createObjectURL() {return `blob:mock-${++serial}`;} static revokeObjectURL() {}}, Image: class {async decode() {}},
  });
  function runTimer(delay) {
    const item = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(item, `Missing timer ${delay}`);
    timers.delete(item[0]); item[1].fn();
  }
  return {frame, image, status, label, timers, document, window, iframe, classes, runTimer, warnings};
}
function health(changes = {}) {
  return {ok: true, json: async () => ({status: 'ok', cameraDocId: 'doc-1', latestFrameAvailable: true, lastPredictionCount: 1, lastInferenceAt: new Date(now).toISOString(), ...changes})};
}
function jpeg(changes = {}) {
  return {ok: true, headers: {get(key) {return {'Content-Type': 'image/jpeg', 'X-Inference-At': new Date(now).toISOString(), 'X-Feed-Status': 'ok', 'X-Camera-Doc-Id': 'doc-1', ...changes}[key];}}, blob: async () => ({})};
}
const healthyFetch = async url => url.includes('/health') ? health() : jpeg();
const streamHealth = (changes = {}) => health({streamEnabled: true, streamAvailable: true,
  captureActive: true, lastFrameAt: new Date(now).toISOString(), ...changes});

test('secure feed uses token headers and one-use image ticket, never ID token URLs', async () => {
  const calls = [];
  const ui = setup(async (url, options) => {
    calls.push({url, options});
    return url.includes('/stream-ticket') ? {ok: true, json: async () => ({ticket: 'a'.repeat(43)})} : streamHealth();
  }, 'doc-1', 'https:', 'https://backend.invalid', async () => 'firebase-id-token');
  await flush();
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/feed-health\?.*&cameraDocId=doc-1/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer firebase-id-token');
  assert.equal(calls[1].options.method, 'POST');
  assert.match(ui.image.src, /ticket=a{43}$/);
  assert.doesNotMatch(ui.image.src, /firebase-id-token/);
  ui.image.onload();
  ui.runTimer(1500); await flush();
  assert.equal(calls.length, 3); // No new ticket during a healthy active stream.
});

test('hosted feed fails closed for missing/invalid HTTPS backend or signed-out user', async () => {
  for (const backend of ['', 'http://backend.invalid', 'https://user:pass@backend.invalid', 'https://backend.invalid/?token=x']) {
    let calls = 0;
    const ui = setup(async () => {calls++; return streamHealth();}, 'doc-1', 'https:', backend, async () => 'token');
    await flush();
    assert.equal(calls, 0);
    assert.equal(ui.image.src, undefined);
  }
  let calls = 0;
  const ui = setup(async () => {calls++; return streamHealth();}, 'doc-1', 'https:', 'https://backend.invalid',
    async () => {throw new Error('signed out');});
  await flush();
  assert.equal(calls, 0);
  assert.equal(ui.image.src, undefined);
});

test('camera switch during ticket exchange never opens the old stream', async () => {
  let resolve;
  const ui = setup(async url => url.includes('/stream-ticket') ? new Promise(r => resolve = r) : streamHealth(),
    'doc-1', 'https:', 'https://backend.invalid', async () => 'token');
  await flush();
  ui.frame.dataset.cameraDocId = 'doc-2';
  ui.document['riversight:camera-selected']();
  resolve({ok: true, json: async () => ({ticket: 'a'.repeat(43)})});
  await flush();
  assert.equal(ui.image.src, undefined);
});

test('delayed ticket cannot reopen a stream from stale health', async () => {
  const clock = {now};
  let resolve;
  const ui = setup(async url => url.includes('/stream-ticket') ? new Promise(r => resolve = r) : streamHealth(),
    'doc-1', 'https:', 'https://backend.invalid', async () => 'token', clock);
  await flush();
  clock.now += 16000;
  resolve({ok: true, json: async () => ({ticket: 'a'.repeat(43)})});
  await flush();
  assert.equal(ui.image.src, undefined);
});

test('secure stream renewal retains its health freshness timer', async () => {
  const clock = {now};
  let tickets = 0;
  const ui = setup(async url => url.includes('/stream-ticket')
    ? {ok: true, json: async () => ({ticket: (++tickets === 1 ? 'a' : 'b').repeat(43)})}
    : streamHealth({lastInferenceAt: new Date(clock.now).toISOString(), lastFrameAt: new Date(clock.now).toISOString()}),
    'doc-1', 'https:', 'https://backend.invalid', async () => 'token', clock);
  await flush(); ui.image.onload();
  clock.now += 56000;
  ui.runTimer(1500); await flush();
  assert.equal(tickets, 2);
  assert.match(ui.image.src, /ticket=b{43}$/);
  const expiry = [...ui.timers.values()].find(timer => timer.delay === 15000);
  assert.ok(expiry);
  expiry.fn();
  assert.equal(ui.image.src, undefined);
});

test('tracked stream labels positions as estimates and confidence as last YOLO', async () => {
  const urls = [];
  const ui = setup(async url => {urls.push(url); return streamHealth({trackingEnabled: true, activeTrackCount: 0, lastPredictionCount: 0});});
  await flush(); ui.image.onload();
  assert.equal(ui.label.textContent, 'AI LIVE + TRACKING');
  assert.match(ui.status.textContent, /positions estimated; confidence from last YOLO result/);
  assert.equal(ui.image.hidden, false);
  ui.runTimer(1500); await flush();
  assert.ok(urls.every(url => url.includes('/health')));
});

test('MJPEG is primary and health polls preserve one stream connection', async () => {
  const urls = [];
  const ui = setup(async url => {urls.push(url); return streamHealth({lastPredictionCount: 0});});
  await flush();
  assert.match(ui.image.src, /segmentation-stream\.mjpg\?cameraDocId=doc-1&/);
  assert.equal(ui.image.crossOrigin, 'anonymous');
  assert.equal(ui.image.hidden, true); // Wait for the first decoded image.
  ui.image.onload();
  assert.equal(ui.image.hidden, false);
  assert.equal(ui.label.textContent, 'AI LIVE STREAM');
  assert.match(ui.status.textContent, /exact results in evidence snapshot/);
  const src = ui.image.src;
  ui.runTimer(1500); await flush();
  assert.equal(ui.image.src, src);
  assert.ok(urls.every(url => url.includes('/health')));
});

test('stream error falls back and healthy retry restores stream', async () => {
  const ui = setup(async () => streamHealth()); await flush();
  ui.image.onload(); ui.image.onerror();
  assert.equal(ui.image.hidden, true);
  assert.equal(ui.image.src, undefined);
  assert.match(ui.status.textContent, /unavailable/);
  ui.runTimer(1500); await flush(); ui.image.onload();
  assert.equal(ui.image.hidden, false);
});

test('stream startup timeout and unhealthy capture fall back', async () => {
  const ui = setup(async () => streamHealth()); await flush();
  ui.runTimer(8000);
  assert.equal(ui.image.src, undefined);
  assert.match(ui.status.textContent, /unavailable/);
  for (const changes of [{captureActive: false}, {streamAvailable: false},
      {lastFrameAt: new Date(now - 30000).toISOString()}, {status: 'degraded'},
      {lastInferenceAt: new Date(now - 30000).toISOString()}]) {
    const failed = setup(async () => streamHealth(changes)); await flush();
    assert.equal(failed.image.hidden, true);
    assert.equal(failed.image.src, undefined);
  }
});

test('stream camera switch cancels old load; returning restores matching stream', async () => {
  const ui = setup(async () => streamHealth()); await flush();
  const oldLoad = ui.image.onload;
  ui.frame.dataset.cameraDocId = 'doc-2';
  ui.document['riversight:camera-selected'](); await flush(); oldLoad();
  assert.equal(ui.image.hidden, true);
  assert.match(ui.status.textContent, /not active for this camera/);
  ui.frame.dataset.cameraDocId = 'doc-1';
  ui.document['riversight:camera-selected'](); await flush(); ui.image.onload();
  assert.equal(ui.image.hidden, false);
  ui.window.pagehide();
  assert.equal(ui.image.src, undefined);
  assert.equal(ui.image.onload, null);
});

test('stream service outage automatically recovers', async () => {
  let online = true;
  const ui = setup(async () => {if (!online) throw Error('offline'); return streamHealth();});
  await flush(); ui.image.onload();
  online = false; ui.runTimer(1500); await flush();
  assert.equal(ui.image.hidden, true);
  online = true; ui.runTimer(1500); await flush(); ui.image.onload();
  assert.equal(ui.image.hidden, false);
});

test('snapshot rollback closes MJPEG and retains the verified snapshot path', async () => {
  let streaming = true;
  const ui = setup(async url => url.includes('/health') ? (streaming ? streamHealth() : health()) : jpeg());
  await flush(); ui.image.onload();
  streaming = false; ui.runTimer(1500); await flush();
  assert.match(ui.image.src, /^blob:/);
  assert.equal(ui.image.onload, null);
  assert.equal(ui.image.hidden, false);
  assert.equal(ui.label.textContent, 'AI PROCESSED FRAME');
});

test('closed multipart connection is detected through health without an image error', async () => {
  let active = true;
  const urls = [];
  const ui = setup(async url => {urls.push(url); return streamHealth({streamClientActive: active});});
  await flush(); ui.image.onload();
  active = false; ui.runTimer(1500); await flush();
  assert.match(urls[1], /&streamId=/);
  assert.equal(ui.image.hidden, true);
  assert.equal(ui.image.src, undefined);
  active = true; ui.runTimer(1500); await flush(); ui.image.onload();
  assert.equal(ui.image.hidden, false);
});

test('stream freshness timer disconnects image while a health request stalls', async () => {
  const ui = setup(async () => streamHealth()); await flush(); ui.image.onload();
  const expiry = [...ui.timers.values()].find(timer => timer.delay > 10000);
  assert.ok(expiry); expiry.fn();
  assert.equal(ui.image.hidden, true);
  assert.equal(ui.image.src, undefined);
});

test('filesystem origin warns once while rejected requests retain live fallback', async () => {
  const ui = setup(async () => ({ok: false, status: 403}), 'doc-1', 'file:');
  await flush();
  assert.equal(ui.warnings.length, 1);
  assert.match(ui.warnings[0], /served over HTTP/);
  assert.match(ui.warnings[0], /http:\/\/127\.0\.0\.1:8000/);
  assert.equal(ui.image.hidden, true);
  assert.match(ui.status.textContent, /unavailable/);
  ui.runTimer(1500); await flush();
  assert.equal(ui.warnings.length, 1);
});

test('normal HTTP works without a filesystem warning', async () => {
  const ui = setup(healthyFetch); await flush();
  assert.equal(ui.warnings.length, 0);
  assert.equal(ui.image.hidden, false);
});

test('Firestore selector preserves display IDs but publishes canonical document IDs', () => {
  const cameraSource = fs.readFileSync(path.join(root, 'js/monitoring/waste-camera-module.js'), 'utf8')
    .replace(/^import .*;\r?$/gm, '');
  function element() {
    return {value: '', children: [], dataset: {},
      addEventListener(name, fn) {this[name] = fn;},
      replaceChildren(...children) {this.children = children;},
      appendChild(child) {this.children.push(child);}};
  }
  const selector = element(), frame = element(), live = element(), title = element();
  let snapshot, events = 0;
  const document = {
    getElementById: () => selector,
    querySelector: key => ({'[data-camera-feed-frame]': frame, '[data-live-camera-media]': live,
      '[data-camera-title]': title})[key],
    createElement: element, addEventListener() {}, dispatchEvent() {events++;},
  };
  vm.runInNewContext(cameraSource, {document, window: {location: {search: ''}},
    URLSearchParams, Event, console, db: {}, collection: () => ({}),
    onSnapshot(_collection, callback) {snapshot = callback;},
    normalizeRtspEmbedUrl: () => '', getRtspEmbedIssue: () => '',
  });
  snapshot({docs: [1, 2].map(n => ({id: `fixture-document-${n}`,
    data: () => ({camId: `CAMERA${n}`, title: `Fixture camera ${n}`})}))});
  assert.equal(selector.value, 'CAMERA1');
  assert.equal(frame.dataset.cameraDocId, 'fixture-document-1');
  assert.equal(title.textContent, 'Fixture camera 1 Waste Detection');
  selector.value = 'CAMERA2'; selector.change();
  assert.equal(frame.dataset.cameraDocId, 'fixture-document-2');
  selector.value = 'CAMERA1'; selector.change();
  assert.equal(frame.dataset.cameraDocId, 'fixture-document-1');
  assert.equal(events, 3);
});

test('one camera container and no obsolete toggle/panel or secret configuration', () => {
  assert.equal((html.match(/data-camera-feed-frame/g) || []).length, 1);
  assert.equal((html.match(/data-segmentation-image/g) || []).length, 1);
  assert.doesNotMatch(html, /data-feed-view|data-segmentation-panel|segmentation-switch/);
  assert.doesNotMatch(source + html, /CAMERA_RTSP_URL|ULTRALYTICS_API_KEY/);
  assert.doesNotMatch(source, /[?&](?:token|idToken)=/);
});
test('automatic processed view for matching camera; existing iframe remains available', async () => {
  const ui = setup(healthyFetch); await flush();
  assert.equal(ui.image.hidden, false); assert.ok(ui.classes.has('is-ai-active'));
  assert.match(ui.status.textContent, /ACTIVE/); assert.equal(ui.frame.iframe, ui.iframe);
});
test('zero detections still display successful processed image', async () => {
  const ui = setup(async url => url.includes('/health') ? health({lastPredictionCount: 0}) : jpeg()); await flush();
  assert.equal(ui.image.hidden, false); assert.match(ui.status.textContent, /ACTIVE/);
});
test('offline backend shows live fallback and automatically recovers', async () => {
  let offline = true;
  const ui = setup(async url => { if (offline) throw Error('private'); return healthyFetch(url); });
  await flush(); assert.equal(ui.image.hidden, true); assert.match(ui.status.textContent, /showing live camera/);
  offline = false; ui.runTimer(1500); await flush();
  assert.equal(ui.image.hidden, false); assert.equal(ui.frame.iframe, ui.iframe);
});
test('stale or degraded health falls back', async () => {
  for (const changes of [{lastInferenceAt: new Date(now - 30000).toISOString()}, {status: 'degraded'}, {lastInferenceAt: null}]) {
    let calls = 0;
    const ui = setup(async () => {calls++; return health(changes);}); await flush();
    assert.equal(calls, 1); assert.equal(ui.image.hidden, true); assert.match(ui.status.textContent, /unavailable/);
  }
});
test('identity missing or mismatched never fetches another camera image', async () => {
  for (const cameraDocId of ['', 'doc-2', 'doc', 'doc-1-extra', 'DOC-1', 'CAMERA1']) {
    let calls = 0;
    const ui = setup(async () => {calls++; return health({cameraDocId});}); await flush();
    assert.equal(calls, 1); assert.equal(ui.image.hidden, true); assert.match(ui.status.textContent, /not active for this camera/);
  }
});
test('JPEG identity and freshness rechecked after health', async () => {
  for (const headers of [{'X-Camera-Doc-Id': 'doc-2'}, {'X-Inference-At': new Date(now - 60000).toISOString()}]) {
    const ui = setup(async url => url.includes('/health') ? health() : jpeg(headers)); await flush();
    assert.equal(ui.image.hidden, true); assert.match(ui.status.textContent, /unavailable/);
  }
});
test('camera change cancels pending result; requests stay sequential', async () => {
  let calls = 0, resolve;
  const ui = setup(() => {calls++; return new Promise(r => resolve = r);});
  ui.frame.dataset.cameraDocId = 'doc-2'; ui.document['riversight:camera-selected']();
  ui.document['riversight:camera-selected'](); assert.equal(calls, 1);
  resolve(health()); await flush(); assert.equal(ui.image.hidden, true); assert.equal(calls, 1);
});
test('fresh image expires even if next request has not completed', async () => {
  const ui = setup(healthyFetch); await flush();
  const expiry = [...ui.timers].find(([, timer]) => timer.delay > 10000);
  assert.ok(expiry); expiry[1].fn();
  assert.equal(ui.image.hidden, true); assert.equal(ui.classes.has('is-ai-active'), false);
});
test('no frame yet shows unavailable with live fallback', async () => {
  const ui = setup(async () => health({latestFrameAvailable: false, lastInferenceAt: null})); await flush();
  assert.equal(ui.image.hidden, true); assert.match(ui.status.textContent, /unavailable/);
});

test('switching away and back automatically restores the matching camera', async () => {
  const ui = setup(healthyFetch); await flush();
  assert.equal(ui.image.hidden, false);
  ui.frame.dataset.cameraDocId = 'doc-2';
  ui.document['riversight:camera-selected'](); await flush();
  assert.equal(ui.image.hidden, true);
  assert.match(ui.status.textContent, /not active for this camera/);
  ui.frame.dataset.cameraDocId = 'doc-1';
  ui.document['riversight:camera-selected'](); await flush();
  assert.equal(ui.image.hidden, false);
  assert.match(ui.status.textContent, /ACTIVE/);
});
test('hidden page pauses polling and clears processed frame', async () => {
  const ui = setup(healthyFetch); await flush();
  ui.document.hidden = true; ui.document.visibilitychange();
  assert.equal(ui.timers.size, 0); assert.equal(ui.image.hidden, true);
  ui.window.pagehide(); assert.equal(ui.timers.size, 0);
});

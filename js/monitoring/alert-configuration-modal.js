import * as firebaseConfig from '../shared/firebase-config.js';
import {
  doc,
  onSnapshot,
  setDoc,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// Works whether firebase-config.js exports `db`, `sharedDb`, or a default.
const db = firebaseConfig.db || firebaseConfig.sharedDb || firebaseConfig.default || null;

// Change this if your project already stores alert settings somewhere else.
const CONFIG_COLLECTION = 'settings';
const CONFIG_DOC_ID = 'alertConfig';
const LOCAL_KEY = 'riversight.alertConfig';

const DEFAULTS = {
  volumeThreshold: 10,
  windowMinutes: 5,
  confidenceRequired: 85,
  criticalVolumeKg: 10,
  autoFlagLowConfidence: true
};

const LIMITS = {
  volumeThreshold:    { min: 1,  max: 500,  label: 'Detection volume trigger' },
  windowMinutes:      { min: 1,  max: 60,   label: 'Detection window' },
  confidenceRequired: { min: 50, max: 99,   label: 'Confidence required' },
  criticalVolumeKg:   { min: 1,  max: 1000, label: 'Critical volume' }
};

const hasLocalConfig = !!localStorage.getItem(LOCAL_KEY);
let config = loadLocal();
let dialog = null;
let els = {};

/* ---------- styles (injected, so no separate CSS file is needed) ---------- */
const STYLES = `
/* ---------- Advanced alert settings dialog ---------- */
/* Append to css/monitoring/Incident-Evaluation.css */

.as-dialog {
  margin: auto;
  border: none;
  padding: 0;
  border-radius: 14px;
  width: min(520px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  background: var(--card, var(--surface, #fff));
  color: var(--ink, #111);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.28);
  overflow: hidden;
}
.as-dialog[open] { animation: as-pop 0.18s ease-out; }
.as-dialog::backdrop { background: rgba(15, 18, 24, 0.5); }

@keyframes as-pop {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to   { opacity: 1; transform: none; }
}

.as-form { display: flex; flex-direction: column; max-height: calc(100vh - 48px); }

.as-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  padding: 20px 22px 14px;
  border-bottom: 1px solid var(--border, #e6e6e6);
}
.as-head h2 { margin: 0 0 4px; font-size: 16px; font-weight: 700; }
.as-head p  { margin: 0; font-size: 12px; color: var(--muted, #6b7280); line-height: 1.45; }
.as-close {
  border: none;
  background: none;
  font-size: 22px;
  line-height: 1;
  color: var(--muted, #6b7280);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
}
.as-close:hover { background: rgba(0, 0, 0, 0.06); }

.as-body { padding: 6px 22px 18px; overflow-y: auto; }

.as-group { border: none; margin: 0; padding: 14px 0 4px; min-width: 0; }
.as-group + .as-group { border-top: 1px solid var(--border, #e6e6e6); }
.as-group legend {
  padding: 0;
  margin-bottom: 10px;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--ink, #111);
}

.as-field { margin-bottom: 14px; }
.as-field label,
.as-label-row label { display: block; font-size: 12.5px; font-weight: 600; margin-bottom: 6px; }
.as-label-row { display: flex; justify-content: space-between; align-items: baseline; }
.as-label-row label { margin-bottom: 6px; }
.as-label-row output { font-size: 12.5px; font-weight: 700; color: #2f6fd6; }

.as-input-wrap {
  display: flex;
  align-items: center;
  border: 1.5px solid var(--border, #d9d9d9);
  border-radius: 8px;
  background: transparent;
  overflow: hidden;
}
.as-input-wrap:focus-within { border-color: #2f6fd6; box-shadow: 0 0 0 3px rgba(47, 111, 214, 0.18); }
.as-input-wrap input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  padding: 9px 12px;
}
.as-unit { padding: 0 12px; font-size: 11.5px; color: var(--muted, #6b7280); }
.as-input-wrap:has(.as-invalid) { border-color: var(--red, #d33c3c); }

.as-hint  { display: block; margin-top: 5px; font-size: 11px; color: var(--muted, #6b7280); line-height: 1.4; }
.as-error { display: block; margin-top: 4px; font-size: 11px; font-weight: 600; color: var(--red, #d33c3c); }
.as-error:empty { display: none; }

/* Confidence slider */
.as-field input[type="range"] {
  --as-fill: 0%;
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 6px;
  border-radius: 999px;
  background: linear-gradient(to right, #2f6fd6 var(--as-fill), var(--border, #e2e2e2) var(--as-fill));
  outline: none;
  cursor: pointer;
}
.as-field input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid #2f6fd6;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
}
.as-field input[type="range"]::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid #2f6fd6;
}
.as-field input[type="range"]:focus-visible { box-shadow: 0 0 0 3px rgba(47, 111, 214, 0.25); }

/* Switch */
.as-switch {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  cursor: pointer;
  margin-bottom: 14px;
}
.as-switch input { position: absolute; opacity: 0; pointer-events: none; }
.as-switch-track {
  position: relative;
  flex-shrink: 0;
  width: 36px;
  height: 20px;
  margin-top: 1px;
  border-radius: 999px;
  background: var(--border, #cfcfcf);
  transition: background 0.15s;
}
.as-switch-track::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  transition: transform 0.15s;
}
.as-switch input:checked + .as-switch-track { background: var(--green, #2f9e44); }
.as-switch input:checked + .as-switch-track::after { transform: translateX(16px); }
.as-switch input:focus-visible + .as-switch-track { box-shadow: 0 0 0 3px rgba(47, 111, 214, 0.3); }
.as-switch-text strong { display: block; font-size: 12.5px; font-weight: 600; }
.as-switch-text small  { display: block; margin-top: 2px; font-size: 11px; color: var(--muted, #6b7280); }

.as-preview {
  margin: 4px 0 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: #f3f6fc;
  border: 1px solid #d9e3f7;
  color: #274a86;
  font-size: 11.5px;
  line-height: 1.5;
}

.as-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 22px;
  border-top: 1px solid var(--border, #e6e6e6);
}
.as-spacer { flex: 1; }
.as-btn {
  border: none;
  border-radius: 8px;
  padding: 9px 14px;
  font: inherit;
  font-size: 12.5px;
  font-weight: 700;
  cursor: pointer;
}
.as-btn-primary { background: var(--ink, #111); color: #fff; }
.as-btn-primary:hover:not(:disabled) { opacity: 0.88; }
.as-btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
.as-btn-secondary { background: #e9e9e9; color: #444; }
.as-btn-secondary:hover { background: #dedede; }
.as-btn-ghost { background: none; color: var(--muted, #6b7280); padding-left: 0; }
.as-btn-ghost:hover { color: var(--ink, #111); }
.as-btn:focus-visible { outline: 2px solid #2f6fd6; outline-offset: 2px; }

@media (max-width: 480px) {
  .as-foot { flex-wrap: wrap; }
  .as-btn-ghost { order: 3; width: 100%; text-align: left; }
  .as-spacer { display: none; }
  .as-foot .as-btn-secondary, .as-foot .as-btn-primary { flex: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .as-dialog[open] { animation: none; }
  .as-switch-track, .as-switch-track::after { transition: none; }
}

`;

function injectStyles() {
  if (document.getElementById('as-styles')) return;
  const style = document.createElement('style');
  style.id = 'as-styles';
  style.textContent = STYLES;
  document.head.appendChild(style);
}

/* ---------- config helpers ---------- */

function normalize(raw = {}) {
  const out = { ...DEFAULTS };
  for (const key of Object.keys(LIMITS)) {
    const n = Number(raw[key]);
    if (Number.isFinite(n)) {
      out[key] = Math.min(LIMITS[key].max, Math.max(LIMITS[key].min, Math.round(n)));
    }
  }
  if (typeof raw.autoFlagLowConfidence === 'boolean') {
    out.autoFlagLowConfidence = raw.autoFlagLowConfidence;
  }
  return out;
}

function loadLocal() {
  try {
    return normalize(JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}'));
  } catch {
    return { ...DEFAULTS };
  }
}

function saveLocal(cfg) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(cfg));
  } catch (err) {
    console.warn('Could not cache alert config locally:', err);
  }
}

/* ---------- page sync ---------- */

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function applyConfig(cfg) {
  config = cfg;
  setText('lblVolumeThreshold', cfg.volumeThreshold);
  setText('cfgDisplayVolume', `${cfg.volumeThreshold} Units`);
  setText(
    'cfgVolumeDesc',
    `Trigger alert when more than ${cfg.volumeThreshold} items are detected in a ${cfg.windowMinutes}-min window.`
  );
  setText('cfgDisplayConfidence', `${cfg.confidenceRequired}%`);
  const bar = document.getElementById('cfgConfidenceBar');
  if (bar) bar.style.width = `${cfg.confidenceRequired}%`;

  window.RiverSightAlertConfig = { ...cfg };
  document.dispatchEvent(new CustomEvent('riversight:alert-config', { detail: { ...cfg } }));
}

/* ---------- toast (uses the existing #toast-container + .toast styles) ---------- */

function notify({ type = 'success', title, desc, duration = 4500 }) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const icons = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3 1 21h22L12 3Z"/><path d="M12 9.5v5M12 17.5h.01"/></svg>',
    error:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>'
  };

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.success}</span>
    <div class="toast-body">
      <div class="toast-title"></div>
      ${desc ? '<div class="toast-desc"></div>' : ''}
    </div>
    <button class="toast-close" type="button" aria-label="Dismiss">&times;</button>`;
  toast.querySelector('.toast-title').textContent = title;
  if (desc) toast.querySelector('.toast-desc').textContent = desc;

  container.appendChild(toast);
  const remove = () => {
    toast.classList.add('closing');
    setTimeout(() => toast.remove(), 200);
  };
  toast.querySelector('.toast-close').addEventListener('click', remove);
  setTimeout(remove, duration);
}

/* ---------- dialog ---------- */

function buildDialog() {
  injectStyles();
  dialog = document.createElement('dialog');
  dialog.className = 'as-dialog';
  dialog.setAttribute('aria-labelledby', 'asTitle');
  dialog.innerHTML = `
    <form class="as-form" id="asForm" novalidate>
      <header class="as-head">
        <div>
          <h2 id="asTitle">Advanced alert settings</h2>
          <p>Control when the Incident Engine raises an alert and how detections are reviewed.</p>
        </div>
        <button type="button" class="as-close" data-as-cancel aria-label="Close">&times;</button>
      </header>

      <div class="as-body">
        <fieldset class="as-group">
          <legend>Alert trigger</legend>

          <div class="as-field">
            <label for="asVolume">Detection volume trigger</label>
            <div class="as-input-wrap">
              <input type="number" id="asVolume" inputmode="numeric" min="${LIMITS.volumeThreshold.min}" max="${LIMITS.volumeThreshold.max}" step="1">
              <span class="as-unit">items</span>
            </div>
            <small class="as-hint">An alert fires when more than this many items are detected.</small>
            <small class="as-error" id="asVolumeError" role="alert"></small>
          </div>

          <div class="as-field">
            <label for="asWindow">Detection window</label>
            <div class="as-input-wrap">
              <input type="number" id="asWindow" inputmode="numeric" min="${LIMITS.windowMinutes.min}" max="${LIMITS.windowMinutes.max}" step="1">
              <span class="as-unit">minutes</span>
            </div>
            <small class="as-hint">How far back the engine counts detections.</small>
            <small class="as-error" id="asWindowError" role="alert"></small>
          </div>
        </fieldset>

        <fieldset class="as-group">
          <legend>Manual review</legend>

          <div class="as-field">
            <div class="as-label-row">
              <label for="asConfidence">Confidence required</label>
              <output id="asConfidenceOut" for="asConfidence"></output>
            </div>
            <input type="range" id="asConfidence" min="${LIMITS.confidenceRequired.min}" max="${LIMITS.confidenceRequired.max}" step="1">
            <small class="as-hint">Detections scoring below this go to the review queue.</small>
          </div>

          <label class="as-switch" for="asAutoFlag">
            <input type="checkbox" id="asAutoFlag" role="switch">
            <span class="as-switch-track" aria-hidden="true"></span>
            <span class="as-switch-text">
              <strong>Auto-flag low-confidence detections</strong>
              <small>When off, low-confidence detections still raise alerts.</small>
            </span>
          </label>
        </fieldset>

        <fieldset class="as-group">
          <legend>Severity</legend>

          <div class="as-field">
            <label for="asCriticalKg">Critical volume</label>
            <div class="as-input-wrap">
              <input type="number" id="asCriticalKg" inputmode="numeric" min="${LIMITS.criticalVolumeKg.min}" max="${LIMITS.criticalVolumeKg.max}" step="1">
              <span class="as-unit">kg</span>
            </div>
            <small class="as-hint">Detections above this estimated weight are classed as critical.</small>
            <small class="as-error" id="asCriticalKgError" role="alert"></small>
          </div>
        </fieldset>

        <p class="as-preview" id="asPreview" aria-live="polite"></p>
      </div>

      <footer class="as-foot">
        <button type="button" class="as-btn as-btn-ghost" id="asReset">Reset to defaults</button>
        <span class="as-spacer"></span>
        <button type="button" class="as-btn as-btn-secondary" data-as-cancel>Cancel</button>
        <button type="submit" class="as-btn as-btn-primary" id="asSave">Save changes</button>
      </footer>
    </form>`;
  document.body.appendChild(dialog);

  els = {
    form: dialog.querySelector('#asForm'),
    volume: dialog.querySelector('#asVolume'),
    windowMin: dialog.querySelector('#asWindow'),
    confidence: dialog.querySelector('#asConfidence'),
    confidenceOut: dialog.querySelector('#asConfidenceOut'),
    autoFlag: dialog.querySelector('#asAutoFlag'),
    criticalKg: dialog.querySelector('#asCriticalKg'),
    preview: dialog.querySelector('#asPreview'),
    save: dialog.querySelector('#asSave'),
    reset: dialog.querySelector('#asReset')
  };

  dialog.querySelectorAll('[data-as-cancel]').forEach((btn) =>
    btn.addEventListener('click', () => dialog.close())
  );

  // Click on the backdrop (outside the form) closes the dialog.
  dialog.addEventListener('mousedown', (e) => {
    if (e.target === dialog) dialog.close();
  });

  els.form.addEventListener('input', onFormInput);
  els.form.addEventListener('submit', onSubmit);
  els.reset.addEventListener('click', () => {
    fillForm(DEFAULTS);
    refreshFormState();
  });
}

function fillForm(cfg) {
  els.volume.value = cfg.volumeThreshold;
  els.windowMin.value = cfg.windowMinutes;
  els.confidence.value = cfg.confidenceRequired;
  els.autoFlag.checked = cfg.autoFlagLowConfidence;
  els.criticalKg.value = cfg.criticalVolumeKg;
  clearErrors();
}

function readForm() {
  return {
    volumeThreshold: els.volume.value,
    windowMinutes: els.windowMin.value,
    confidenceRequired: els.confidence.value,
    criticalVolumeKg: els.criticalKg.value,
    autoFlagLowConfidence: els.autoFlag.checked
  };
}

function clearErrors() {
  dialog.querySelectorAll('.as-error').forEach((el) => (el.textContent = ''));
  dialog.querySelectorAll('.as-invalid').forEach((el) => el.classList.remove('as-invalid'));
}

function validate(raw) {
  clearErrors();
  const fields = [
    ['volumeThreshold', els.volume, 'asVolumeError', 'items'],
    ['windowMinutes', els.windowMin, 'asWindowError', 'minutes'],
    ['criticalVolumeKg', els.criticalKg, 'asCriticalKgError', 'kg']
  ];
  let ok = true;

  for (const [key, input, errId, unit] of fields) {
    const n = Number(raw[key]);
    const { min, max } = LIMITS[key];
    if (raw[key] === '' || !Number.isInteger(n) || n < min || n > max) {
      dialog.querySelector(`#${errId}`).textContent = `Enter a whole number from ${min} to ${max} ${unit}.`;
      input.classList.add('as-invalid');
      ok = false;
    }
  }
  return ok;
}

function isDirty(raw) {
  const next = normalize(raw);
  return Object.keys(DEFAULTS).some((k) => next[k] !== config[k]);
}

function refreshFormState() {
  const raw = readForm();
  const next = normalize(raw);

  els.confidenceOut.textContent = `${next.confidenceRequired}%`;
  els.confidence.style.setProperty('--as-fill', `${((next.confidenceRequired - LIMITS.confidenceRequired.min) / (LIMITS.confidenceRequired.max - LIMITS.confidenceRequired.min)) * 100}%`);

  const reviewLine = next.autoFlagLowConfidence
    ? `Detections under ${next.confidenceRequired}% confidence go to manual review.`
    : 'Low-confidence detections still raise alerts.';
  els.preview.textContent =
    `An alert fires when more than ${next.volumeThreshold} items are detected within ${next.windowMinutes} min. ` +
    `${reviewLine} Detections over ${next.criticalVolumeKg} kg are critical.`;

  els.save.disabled = !isDirty(raw);
}

function onFormInput(e) {
  if (e.target.classList?.contains('as-invalid')) {
    e.target.classList.remove('as-invalid');
    const err = e.target.closest('.as-field')?.querySelector('.as-error');
    if (err) err.textContent = '';
  }
  refreshFormState();
}

async function onSubmit(e) {
  e.preventDefault();
  const raw = readForm();
  if (!validate(raw)) {
    dialog.querySelector('.as-invalid')?.focus();
    return;
  }

  const next = normalize(raw);
  els.save.disabled = true;
  els.save.textContent = 'Saving…';

  // Apply locally first so the page updates immediately.
  saveLocal(next);
  applyConfig(next);

  try {
    if (!db) throw Object.assign(new Error('Firestore is not available on this page.'), { code: 'no-db' });
    await setDoc(
      doc(db, CONFIG_COLLECTION, CONFIG_DOC_ID),
      { ...next, updatedAt: serverTimestamp() },
      { merge: true }
    );
    notify({
      type: 'success',
      title: 'Alert settings saved',
      desc: `Alerts now fire above ${next.volumeThreshold} items within ${next.windowMinutes} min.`
    });
  } catch (err) {
    console.error('Failed to save alert settings:', err);
    notify({
      type: 'warning',
      title: 'Saved on this device only',
      desc: err.code === 'permission-denied'
        ? `Firestore rules don't allow writing ${CONFIG_COLLECTION}/${CONFIG_DOC_ID}. Update firestore.rules to sync it.`
        : (err.message || 'Could not reach Firestore.')
    });
  } finally {
    els.save.textContent = 'Save changes';
    dialog.close();
  }
}

function openDialog(focusEl = 'volume') {
  if (!dialog) buildDialog();
  fillForm(config);
  refreshFormState();
  dialog.showModal();
  els[focusEl]?.focus();
  els[focusEl]?.select?.();
}

/* ---------- init ---------- */

function init() {
  if (hasLocalConfig) applyConfig(config);

  document.getElementById('btnOpenAdvancedSettings')
    ?.addEventListener('click', () => openDialog('volume'));
  document.getElementById('btnModifySensitivity')
    ?.addEventListener('click', () => openDialog('volume'));

  if (db) {
    onSnapshot(
      doc(db, CONFIG_COLLECTION, CONFIG_DOC_ID),
      (snap) => {
        if (!snap.exists()) return;
        const remote = normalize(snap.data());
        saveLocal(remote);
        applyConfig(remote);
      },
      (err) => console.warn('Alert config listener failed, using local copy:', err.code || err)
    );
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
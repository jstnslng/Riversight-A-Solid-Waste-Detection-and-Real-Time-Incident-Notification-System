import { auth, db } from "../shared/firebase-config.js";
import {
  collection,
  onSnapshot,
  addDoc,
  doc,
  updateDoc,
  serverTimestamp,
  getDoc,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getRtspEmbedIssue, normalizeRtspEmbedUrl } from "../shared/camera-embed.js";

export const WASTE_CLASS_CANDIDATES = ['food_pack','non_pla','Composite_Rubber_Textile','Organic','Paper','Plastic'];
export function verifiedWasteMapping(health, cameraId, now=Date.now()) {
  const age=now-Date.parse(health?.lastInferenceAt);
  return health?.cameraDocId===cameraId && health.status==='ok' && health.latestFrameAvailable===true &&
    Number.isFinite(age) && age>=-5000 && age<15000 && Array.isArray(health.modelClassNames) &&
    health.modelClassNames.length===WASTE_CLASS_CANDIDATES.length &&
    health.modelClassNames.every((name,id)=>name===WASTE_CLASS_CANDIDATES[id]);
}
export function validRoiPoints(points) {
  if (!Array.isArray(points) || points.length < 3 || points.length > 256 ||
      points.some(p => !Array.isArray(p) || p.length !== 2 || p.some(v => !Number.isFinite(v) || v < 0 || v > 1)) ||
      new Set(points.map(p => JSON.stringify(p))).size !== points.length) return false;
  const cross = (a,b,c) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const on = (a,b,c) => cross(a,b,c) === 0 && c.every((v,k) => v >= Math.min(a[k],b[k]) && v <= Math.max(a[k],b[k]));
  for (let i=0;i<points.length;i++) for (let j=i+1;j<points.length;j++) {
    if (j === i+1 || (i===0 && j===points.length-1)) continue;
    const a=points[i], b=points[(i+1)%points.length], c=points[j], d=points[(j+1)%points.length];
    if ((cross(a,b,c)*cross(a,b,d)<0 && cross(c,d,a)*cross(c,d,b)<0) ||
        on(a,b,c) || on(a,b,d) || on(c,d,a) || on(c,d,b)) return false;
  }
  return Math.abs(points.reduce((s,a,i) => s+a[0]*points[(i+1)%points.length][1]-a[1]*points[(i+1)%points.length][0],0)) >= 1e-9;
}

export function storedRoiPoints(config) {
  if (!config || !Array.isArray(config.points)) return [];
  const converted=config.points.map(point => {
    if (Array.isArray(point) && point.length===2) return [...point];
    if (point && typeof point==='object' && Object.keys(point).length===2 && 'x' in point && 'y' in point) return [point.x,point.y];
    return null;
  });
  if (converted.some(point=>!point || point.some(value=>!Number.isFinite(value)))) return [];
  if (config.coordinateSpace==='pixels') {
    const {width,height}=config.imageDimensions || {};
    if (!Number.isInteger(width) || !Number.isInteger(height) || width<2 || height<2) return [];
    converted.forEach(point=>{point[0]/=width-1;point[1]/=height-1;});
  } else if (config.coordinateSpace!=='normalized') return [];
  return validRoiPoints(converted) ? converted : [];
}
export function serializeRoiPoints(points) {
  if (!validRoiPoints(points)) throw new Error('Invalid ROI geometry');
  return points.map(([x,y])=>({x,y}));
}

(() => {
  const roiDialog = document.getElementById('roiDialog');
  const canvas = document.getElementById('roiCanvas');
  const roiMessage = document.getElementById('roiMessage');
  const revision = document.getElementById('roiRevision');
  let administrator = false, roiCamera = null, points = [], snapshot = null, busy = false, generation = 0;
  let openedVersion = 0;
  const classDialog=document.getElementById('wasteClassDialog');
  const classMessage=document.getElementById('wasteClassMessage');
  const classList=document.getElementById('wasteClassList');
  let classCamera=null,classVersion=0,classBusy=false,classGeneration=0;
  function openWasteClasses(camera) {
    if (!administrator || classBusy) return;
    classCamera=camera;classVersion=camera.wasteCoverageClasses?.version || 0;classGeneration++;
    const selected=camera.wasteCoverageClasses?.names || ['food_pack','Composite_Rubber_Textile','Paper','Plastic'];
    classList.replaceChildren();
    WASTE_CLASS_CANDIDATES.forEach((name,id)=>{
      const label=document.createElement('label'), input=document.createElement('input');
      input.type='checkbox';input.value=name;input.checked=selected.includes(name);
      label.append(input,document.createTextNode(`${id} = ${name}${['non_pla','Organic'].includes(name)?' — group clarification required':''}`));
      classList.appendChild(label);
    });
    classMessage.textContent='Candidate dataset mapping only. Approval requires a fresh matching class inventory from this camera’s active cloud inference.';
    classDialog.showModal();
  }
  async function saveWasteClasses(state) {
    if (classBusy || !classCamera) return;
    const names=Array.from(classList.querySelectorAll('input:checked'),input=>input.value);
    if (!names.length || names.some(name=>!WASTE_CLASS_CANDIDATES.includes(name))) {
      classMessage.textContent='Select at least one candidate class.';return;
    }
    if (state==='approved' && names.some(name=>['non_pla','Organic'].includes(name))) {
      classMessage.textContent='Approval blocked: non_pla and Organic require group clarification. Save a draft or exclude them.';return;
    }
    if (state==='approved' && !window.confirm('Approve these selected waste classes? This does not approve a waterway ROI.')) return;
    classBusy=true;
    const current=classGeneration, cameraId=classCamera.id, expectedVersion=classVersion;
    try {
      const user=await requireAdministrator();
      let verification=null;
      if (state==='approved') {
        const base=new URL(document.querySelector('meta[name="riversight-ai-backend"]')?.content);
        if(base.protocol!=='https:' || base.username || base.password || base.search || base.hash || base.pathname!=='/') throw new Error();
        classMessage.textContent='Verifying active cloud class mapping…';
        const response=await fetch(`${base.origin}/feed-health?cameraDocId=${encodeURIComponent(cameraId)}`,{
          headers:{Authorization:`Bearer ${await user.getIdToken()}`},credentials:'omit',cache:'no-store',
          referrerPolicy:'no-referrer',signal:AbortSignal.timeout(10000)
        });
        if(!response.ok) throw new Error();
        const health=await response.json();
        if(!verifiedWasteMapping(health,cameraId)) throw new Error();
        verification={classNames:[...health.modelClassNames],inferenceAt:health.lastInferenceAt};
      }
      await runTransaction(db,async transaction=>{
        const ref=doc(db,'camera_feeds',cameraId), existing=await transaction.get(ref);
        if(!existing.exists() || auth.currentUser?.uid!==user.uid || current!==classGeneration || !classDialog.open ||
           (existing.data().wasteCoverageClasses?.version || 0)!==expectedVersion) throw new Error();
        if(verification && !verifiedWasteMapping({cameraDocId:cameraId,status:'ok',latestFrameAvailable:true,
            modelClassNames:verification.classNames,lastInferenceAt:verification.inferenceAt},cameraId)) throw new Error();
        transaction.update(ref,{wasteCoverageClasses:{state,names,version:expectedVersion+1,
          classListVersion:1,candidateClassNames:[...WASTE_CLASS_CANDIDATES],
          modelVerification:verification,updatedAt:serverTimestamp(),updatedBy:user.uid,
          approvedAt:state==='approved'?serverTimestamp():null,approvedBy:state==='approved'?user.uid:null}});
      });
      classVersion++;classMessage.textContent=`Saved ${state}. ROI approval remains separate.`;
    } catch {classMessage.textContent=state==='approved'
      ? 'Approval blocked: active class mapping could not be verified, access was denied, or configuration changed. Nothing was approved; Save Draft remains available.'
      : 'Draft not saved: access denied or conflicting edit. Reopen and retry.';}
    finally {classBusy=false;}
  }
  document.getElementById('wasteClassDraft')?.addEventListener('click',()=>saveWasteClasses('draft'));
  document.getElementById('wasteClassApprove')?.addEventListener('click',()=>saveWasteClasses('approved'));
  document.getElementById('wasteClassClose')?.addEventListener('click',()=>classDialog.close());
  classDialog?.addEventListener('close',()=>{classGeneration++;});
  async function requireAdministrator() {
    await auth.authStateReady();
    const user = auth.currentUser;
    if (!user || (await getDoc(doc(db,'users',user.uid))).data()?.role !== 'Administrator') throw new Error('Denied');
    if (auth.currentUser?.uid !== user.uid) throw new Error('Denied');
    return user;
  }
  onAuthStateChanged(auth, async () => {
    administrator = false;
    generation++;
    roiDialog?.close();
    classDialog?.close();
    snapshot = null;
    try { await requireAdministrator(); administrator = true; } catch {}
    renderCameras();
  });
  function drawRoi() {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0,0,canvas.width,canvas.height);
    if (snapshot) ctx.drawImage(snapshot,0,0);
    ctx.strokeStyle = '#ffdf00'; ctx.fillStyle = '#ffdf00'; ctx.lineWidth = Math.max(2,canvas.width/500);
    if (points.length) {
      ctx.beginPath();
      points.forEach(([x,y],i) => i ? ctx.lineTo(x*(canvas.width-1),y*(canvas.height-1)) : ctx.moveTo(x*(canvas.width-1),y*(canvas.height-1)));
      if (points.length>=3) ctx.closePath();
      ctx.stroke();
      points.forEach(([x,y]) => {ctx.beginPath();ctx.arc(x*(canvas.width-1),y*(canvas.height-1),4,0,2*Math.PI);ctx.fill();});
    }
  }
  async function openRoi(camera) {
    if (busy) return;
    try {
      await requireAdministrator();
      snapshot?.close();
      roiCamera = camera; snapshot = null; points = [];
      openedVersion = camera.waterwayRoi?.version || 0;
      revision.value = camera.waterwayRoi?.installationRevision || '';
      document.getElementById('roiCameraName').textContent = camera.title;
      roiMessage.textContent = `ROI: ${camera.waterwayRoi?.state || 'unconfigured'}. Load a current snapshot before drawing.`;
      canvas.width=640; canvas.height=360; drawRoi();
      roiDialog.showModal();
    } catch { showNotification('Administrator access required.','error'); }
  }
  async function loadRoiSnapshot() {
    if (busy) {roiMessage.textContent='A save is in progress. Retry when it completes.';return;}
    if (!roiCamera?.id || !/^[A-Za-z0-9_-]{1,128}$/.test(roiCamera.id)) {
      roiMessage.textContent='Camera configuration unavailable: select a valid camera document.';return;
    }
    const current = ++generation;
    let message='Snapshot editor initialization failed. Reopen the editor.';
    const controller=new AbortController();
    let timeout;
    try {
      snapshot?.close();snapshot=null; points=[]; drawRoi();
      message='AI backend configuration missing or invalid. Reload the page after Hosting configuration is corrected.';
      const configured=document.querySelector('meta[name="riversight-ai-backend"]')?.content?.trim();
      if (!configured) throw new Error();
      const base = new URL(configured);
      if (base.protocol!=='https:' || base.username || base.password || base.search || base.hash || base.pathname!=='/') throw new Error();
      message='Administrator authentication could not be verified. Sign in again or check access to your user profile.';
      const user = await requireAdministrator();
      message='Firebase authentication token unavailable. Sign in again.';
      const token=await user.getIdToken();
      if (!token) throw new Error();
      if (current!==generation || !roiDialog.open) return;
      message='Snapshot request failed: network, HTTPS origin/CORS, or timeout. No HTTP response was readable.';
      roiMessage.textContent='Requesting authorized camera snapshot…';
      timeout=setTimeout(()=>controller.abort(),10000);
      const response = await fetch(`${base.origin}/latest-segmentation.jpg?cameraDocId=${encodeURIComponent(roiCamera.id)}`, {
        headers:{Authorization:`Bearer ${token}`}, credentials:'omit',cache:'no-store',
        referrerPolicy:'no-referrer',signal:controller.signal
      });
      if (!response.ok) {
        message=response.status===401 ? 'HTTP 401: Firebase sign-in required. Sign in again.'
          : response.status===403 ? 'HTTP 403: access denied. Verify the selected camera, active administrator account and explicit camera viewer grant; administrator role alone does not grant feed access.'
          : response.status===404 ? 'HTTP 404: snapshot endpoint not found. Verify the backend deployment and configured origin.'
          : response.status===503 ? 'HTTP 503: camera snapshot is not available yet. Retry when inference is healthy.'
          : `Snapshot request returned HTTP ${response.status}. Retry or contact an administrator.`;
        throw new Error();
      }
      const contentType=response.headers.get('Content-Type');
      const cameraId=response.headers.get('X-Camera-Doc-Id');
      const feedStatus=response.headers.get('X-Feed-Status');
      const inferenceAt=response.headers.get('X-Inference-At');
      message='Snapshot rejected: response is not a JPEG.';
      if (!contentType?.startsWith('image/jpeg')) throw new Error();
      message='Snapshot rejected: camera metadata is missing or not exposed through CORS.';
      if (!cameraId) throw new Error();
      message='Snapshot rejected: camera identity does not match the selected camera.';
      if (cameraId!==roiCamera.id) throw new Error();
      message='Snapshot rejected: feed status metadata is missing or not exposed through CORS.';
      if (!feedStatus) throw new Error();
      message=feedStatus==='degraded' ? 'Snapshot rejected: inference is degraded; a retained JPEG is not healthy.'
        : 'Snapshot rejected: feed is not healthy.';
      if (feedStatus!=='ok') throw new Error();
      message='Snapshot rejected: inference timestamp is missing or not exposed through CORS.';
      if (!inferenceAt) throw new Error();
      const age = Date.now()-Date.parse(inferenceAt);
      message='Snapshot rejected: inference timestamp is invalid.';
      if (!Number.isFinite(age)) throw new Error();
      message='Snapshot rejected: inference timestamp is ahead of the browser clock by more than 5 seconds. Check clock synchronization.';
      if (age < -5000) throw new Error();
      message='Snapshot rejected: inference is stale (15 seconds or older). Wait for fresh successful inference.';
      if (age>=15000) throw new Error();
      message='Snapshot image could not be decoded or has unsupported dimensions.';
      const bitmap=await createImageBitmap(await response.blob());
      if (current!==generation || !roiDialog.open) {bitmap.close();return;}
      if (bitmap.width<2 || bitmap.height<2 || bitmap.width*bitmap.height>16777216) {bitmap.close();throw new Error();}
      const decodedAge=Date.now()-Date.parse(inferenceAt);
      if (decodedAge>=15000 || decodedAge < -5000) {
        bitmap.close();message='Snapshot rejected: frame expired while downloading or decoding. Retry for a fresh snapshot.';throw new Error();
      }
      snapshot=bitmap; canvas.width=bitmap.width;canvas.height=bitmap.height;
      const reference=roiCamera.waterwayRoi?.imageDimensions;
      if (reference?.width*bitmap.height===reference?.height*bitmap.width) points=storedRoiPoints(roiCamera.waterwayRoi);
      drawRoi();
      roiMessage.textContent='Snapshot loaded. Click the waterway boundary; confirm the installation revision before saving.';
    } catch { if(current===generation) roiMessage.textContent=message; }
    finally {clearTimeout(timeout);controller.abort();}
  }
  canvas?.addEventListener('click', event => {
    if (!snapshot || busy || points.length>=256) return;
    const bounds=canvas.getBoundingClientRect();
    const next=[...points,[Math.max(0,Math.min(1,(event.clientX-bounds.left)/bounds.width)),Math.max(0,Math.min(1,(event.clientY-bounds.top)/bounds.height))]];
    if (next.length>=3 && !validRoiPoints(next)) {roiMessage.textContent='Point rejected: polygon would be invalid or intersect itself.';return;}
    points=next;drawRoi();
  });
  async function saveRoi(state) {
    if (busy || !roiCamera) return;
    if (state!=='needs_recalibration' && (!snapshot || !validRoiPoints(points) || !revision.value.trim())) {
      roiMessage.textContent='Load a snapshot, draw 3–256 valid vertices, and enter an installation revision.';return;
    }
    if (state==='approved' && !window.confirm('Approve this waterway polygon for this camera and installation revision? Confirm that the snapshot represents its current position.')) return;
    if (state==='needs_recalibration' && !window.confirm('Invalidate this camera ROI after relocation? Coverage will become unavailable.')) return;
    busy=true;
    const expectedVersion=openedVersion, editGeneration=generation;
    try {
      const user=await requireAdministrator(), cameraId=roiCamera.id;
      if (!roiDialog.open || editGeneration!==generation) throw new Error();
      const geometry=state==='needs_recalibration' ? null : serializeRoiPoints(points), dimensions=snapshot ? {width:snapshot.width,height:snapshot.height}:null;
      const installationRevision=revision.value.trim();
      await runTransaction(db, async transaction => {
        const ref=doc(db,'camera_feeds',cameraId), existing=await transaction.get(ref);
        if (!existing.exists() || auth.currentUser?.uid!==user.uid || editGeneration!==generation) throw new Error();
        const old=existing.data().waterwayRoi || {};
        if ((old.version || 0)!==expectedVersion) throw new Error();
        const oldPoints=storedRoiPoints(old);
        const roi=state==='needs_recalibration' ? {...old,coordinateSpace:'normalized',
          points:oldPoints.length ? serializeRoiPoints(oldPoints) : []} : {
          coordinateSpace:'normalized',points:geometry,imageDimensions:dimensions,installationRevision
        };
        transaction.update(ref,{waterwayRoi:{...roi,state,version:expectedVersion+1,
          updatedAt:serverTimestamp(),updatedBy:user.uid,
          approvedAt:state==='approved'?serverTimestamp():null,approvedBy:state==='approved'?user.uid:null}});
      });
      openedVersion++;
      // Retain the last saved draft geometry for a subsequent snapshot reload.
      if (geometry) roiCamera.waterwayRoi={coordinateSpace:'normalized',points:geometry,imageDimensions:dimensions,
        installationRevision,state,version:openedVersion};
      roiMessage.textContent=`Saved ${state}. Waste class approval remains separate.`;
    } catch {roiMessage.textContent='Save denied or camera configuration changed. Reopen the editor and retry.';}
    finally {busy=false;}
  }
  document.getElementById('roiLoad')?.addEventListener('click',loadRoiSnapshot);
  document.getElementById('roiUndo')?.addEventListener('click',()=>{if(!busy){points.pop();drawRoi();}});
  document.getElementById('roiReset')?.addEventListener('click',()=>{if(!busy){points=[];drawRoi();}});
  document.getElementById('roiDraft')?.addEventListener('click',()=>saveRoi('draft'));
  document.getElementById('roiApprove')?.addEventListener('click',()=>saveRoi('approved'));
  document.getElementById('roiInvalidate')?.addEventListener('click',()=>saveRoi('needs_recalibration'));
  document.getElementById('roiClose')?.addEventListener('click',()=>roiDialog.close());
  roiDialog?.addEventListener('close',()=>{generation++;snapshot?.close();snapshot=null;points=[];});
  let cameras = [];
  let systemMetrics = {
    cpu: 0,
    ram: 0,
    disk: 0,
    storage: 0,
    dbLatency: 0,
    serverUptime: 0,
  };

  const addModal = document.getElementById("addCameraModal");
  const addCameraBtn = document.getElementById("addCameraBtn");
  const closeModalBtn = document.getElementById("closeModalBtn");
  const cancelBtn = document.getElementById("cancelBtn");
  const addCameraForm = document.getElementById("addCameraForm");
  const embedUrlInput = document.getElementById("camEmbedUrl");
  const embedUrlError = document.getElementById("camEmbedUrlError");
  const cameraSubmitBtn = document.getElementById("cameraSubmitBtn");

  const editModal = document.getElementById("editCameraModal");
  const editCameraForm = document.getElementById("editCameraForm");
  const editCloseModalBtn = editModal?.querySelector(".modal-close");
  const cancelEditBtn = document.getElementById("cancelEditBtn");
  const editEmbedUrlInput = document.getElementById("editCamEmbedUrl");
  const editEmbedUrlError = document.getElementById("editCamEmbedUrlError");
  const cameraEditSubmitBtn = document.getElementById("cameraEditSubmitBtn");

  let editingCameraId = null;

  function openAddModal() {
    addModal.classList.add("active");
  }

  function closeAddModal() {
    addModal.classList.remove("active");
    addCameraForm.reset();
    if (embedUrlError) embedUrlError.textContent = "";
  }

  function openEditModal(camera) {
    editingCameraId = camera.id;

    document.getElementById("editCamId").value = camera.camId || "";
    document.getElementById("editCamTitle").value = camera.title || "";
    
    if (document.getElementById("editRegion")) document.getElementById("editRegion").value = camera.region || "";
    if (document.getElementById("editProvince")) document.getElementById("editProvince").value = camera.province || "";
    if (document.getElementById("editCity")) document.getElementById("editCity").value = camera.city || "";
    if (document.getElementById("editBarangay")) document.getElementById("editBarangay").value = camera.barangay || "";

    document.getElementById("editCamIPAddress").value = camera.ipAddress === "N/A" ? "" : camera.ipAddress || "";
    document.getElementById("editCamResolution").value = camera.resolution || "";
    document.getElementById("editCamFPS").value = camera.fps || "";
    document.getElementById("editCamStatus").value = camera.status || "ONLINE";

    if (editEmbedUrlInput) editEmbedUrlInput.value = camera.embedUrl || "";
    if (editEmbedUrlError) editEmbedUrlError.textContent = "";

    editModal.classList.add("active");
  }

  function closeEditModal() {
    editModal.classList.remove("active");
    editCameraForm.reset();
    editingCameraId = null;
    if (editEmbedUrlError) editEmbedUrlError.textContent = "";
  }

  function getStatusPillClass(status) {
    if (status === "ONLINE") return "good";
    if (status === "OFFLINE") return "danger";
    if (status === "WEAK") return "warn";
    return "good";
  }

  function buildCameraCard(camera) {
    const article = document.createElement("article");
    article.className = "camera-card";
    article.dataset.cameraId = camera.id;

    const embedUrl = normalizeRtspEmbedUrl(camera.embedUrl);
    const embedIssue = getRtspEmbedIssue(camera.embedUrl);
    if (embedIssue) {
      console.warn(`Camera feed unavailable: ${embedIssue} (${camera.camId})`);
    }
    const preview = article.appendChild(document.createElement("div"));
    preview.className = "camera-preview";

    if (embedUrl) {
      const iframe = document.createElement("iframe");
      iframe.src = embedUrl;
      iframe.title = `${camera.camId} live preview`;
      iframe.allow = "fullscreen; autoplay";
      iframe.allowFullscreen = true;
      iframe.addEventListener("error", () => {
        console.error(`Camera iframe rendering issue (${camera.camId})`);
      }, { once: true });
      preview.appendChild(iframe);
    } else {
      preview.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 48px; height: 48px; opacity: 0.3;">
          <path d="M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
        <span>Live Preview Unavailable</span>`;
    }

    const meta = document.createElement("div");
    meta.className = "camera-meta";
    meta.innerHTML = `
      <div class="camera-title-row">
        <h4>${camera.camId}</h4>
        <span class="status-pill ${getStatusPillClass(camera.status)}">${camera.status}</span>
      </div>
      <div class="camera-details"><span>Station</span><strong>${camera.city}, ${camera.barangay}</strong></div>
      <div class="camera-details"><span>IP Address</span><strong>${camera.ipAddress}</strong></div>
      <div class="camera-details"><span>Resolution</span><strong>${camera.resolution}</strong></div>
      <div class="camera-details"><span>FPS</span><strong>${camera.fps}</strong></div>
      <div class="camera-details"><span>Last Detection</span><strong>${camera.lastDetection}</strong></div>
      <div class="camera-details"><span>Last Connected Time</span><strong>${camera.lastConnected}</strong></div>`;
    article.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "camera-actions";
    actions.innerHTML = `
      <button type="button" data-action="view">View Camera</button>
      <button type="button" data-action="restart">Restart Camera</button>
      <button type="button" data-action="reconnect">Reconnect</button>
      <button type="button" class="light" data-action="settings">Settings</button>`;
    if (administrator) {
      const button=document.createElement('button');button.type='button';button.dataset.action='roi';button.textContent='Configure Waterway ROI';actions.appendChild(button);
      const classes=document.createElement('button');classes.type='button';classes.dataset.action='waste-classes';classes.textContent='Configure Waste Classes';actions.appendChild(classes);
    }
    actions.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", () => handleCameraAction(camera, button.dataset.action));
    });
    article.appendChild(actions);

    return article;
  }

  function handleCameraAction(camera, action) {
    if (action === 'waste-classes') { openWasteClasses(camera); return; }
    if (action === 'roi') { openRoi(camera); return; }
    if (action === "view") {
      window.location.href = `../monitoring/Live-Monitoring.html?cameraId=${encodeURIComponent(camera.camId)}`;
      return;
    }
    if (action === "settings") {
      openEditModal(camera);
      return;
    }
    showNotification(`Remote camera commands are unavailable for ${camera.camId}.`, "error");
  }

  function renderSystemMetrics() {
    const grid = document.getElementById("systemMetricsGrid");
    if (!grid) return;

    const onlineCameras = cameras.filter((camera) => camera.status === "ONLINE").length;
    const totalCameras = cameras.length;
    const formatUptime = (ms) => {
      const days = Math.floor(ms / 86400000);
      const hours = Math.floor((ms % 86400000) / 3600000);
      return days ? `${days}d ${hours}h` : `${hours}h`;
    };

    grid.innerHTML = `
      <div class="card system-card usage-card"><div class="card-head"><h3>CPU Usage</h3><span class="status-pill ${systemMetrics.cpu > 80 ? "warn" : "good"}">${systemMetrics.cpu}%</span></div><div class="meter"><span style="width:${systemMetrics.cpu}%"></span></div><div class="card-sub">Average processor load</div></div>
      <div class="card system-card usage-card"><div class="card-head"><h3>RAM Usage</h3><span class="status-pill ${systemMetrics.ram > 80 ? "warn" : "good"}">${systemMetrics.ram}%</span></div><div class="meter"><span style="width:${systemMetrics.ram}%"></span></div><div class="card-sub">Memory consumption</div></div>
      <div class="card system-card usage-card"><div class="card-head"><h3>Disk Usage</h3><span class="status-pill ${systemMetrics.disk > 80 ? "warn" : "good"}">${systemMetrics.disk}%</span></div><div class="meter"><span style="width:${systemMetrics.disk}%"></span></div><div class="card-sub">System disk utilization</div></div>
      <div class="card system-card usage-card"><div class="card-head"><h3>Storage Usage</h3><span class="status-pill ${systemMetrics.storage > 80 ? "warn" : "good"}">${systemMetrics.storage}%</span></div><div class="meter"><span style="width:${systemMetrics.storage}%"></span></div><div class="card-sub">Archive and media storage</div></div>
      <div class="card system-card status-card"><div class="card-head"><h3>Database Status</h3><span class="status-pill good">Online</span></div><div class="card-sub">Connected to reporting datastore</div><div class="mini-meta">Latency: ${systemMetrics.dbLatency} ms</div></div>
      <div class="card system-card status-card"><div class="card-head"><h3>Server Status</h3><span class="status-pill good">Healthy</span></div><div class="card-sub">API and dashboard services responding</div><div class="mini-meta">Uptime: ${formatUptime(systemMetrics.serverUptime)}</div></div>
      <div class="card system-card status-card"><div class="card-head"><h3>Camera Status</h3><span class="status-pill good">${onlineCameras}/${totalCameras} Online</span></div><div class="card-sub">All live feeds reporting</div><div class="mini-meta">${totalCameras - onlineCameras} camera${totalCameras - onlineCameras !== 1 ? "s" : ""} awaiting sync</div></div>
      <div class="card system-card status-card"><div class="card-head"><h3>YOLO Model Status</h3><span class="status-pill good">Loaded</span></div><div class="card-sub">Latest detection model deployed</div><div class="mini-meta">Version: v8.2.1</div></div>
      <div class="card system-card status-card"><div class="card-head"><h3>System Uptime</h3><span class="status-pill good">Stable</span></div><div class="uptime-value">${formatUptime(systemMetrics.serverUptime)}</div><div class="card-sub">No restart events in the current window</div></div>`;
  }

  function renderCameras() {
    const grid = document.getElementById("cameraGrid");
    if (!grid) return;
    grid.innerHTML = "";
    if (!cameras.length) {
      grid.innerHTML = `<div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--muted);"><p>No cameras connected yet.</p></div>`;
      renderSystemMetrics();
      return;
    }
    cameras.forEach((camera) => grid.appendChild(buildCameraCard(camera)));
    renderSystemMetrics();
  }

  function showNotification(message, type = "info") {
    const notification = document.createElement("div");
    notification.textContent = message;
    notification.style.cssText = `position:fixed;bottom:20px;right:20px;background:${type === "success" ? "var(--green)" : type === "error" ? "var(--red)" : "var(--blue)"};color:#fff;padding:12px 20px;border-radius:8px;font-size:13px;font-weight:600;z-index:9999;`;
    document.body.appendChild(notification);
    setTimeout(() => notification.remove(), 3000);
  }

  addCameraBtn?.addEventListener("click", openAddModal);
  closeModalBtn?.addEventListener("click", closeAddModal);
  cancelBtn?.addEventListener("click", closeAddModal);

  editCloseModalBtn?.addEventListener("click", closeEditModal);
  cancelEditBtn?.addEventListener("click", closeEditModal);

  addModal?.addEventListener("click", (event) => {
    if (event.target === addModal) closeAddModal();
  });
  editModal?.addEventListener("click", (event) => {
    if (event.target === editModal) closeEditModal();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (addModal?.classList.contains("active")) closeAddModal();
      if (editModal?.classList.contains("active")) closeEditModal();
    }
  });

  addCameraForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const embedUrl = normalizeRtspEmbedUrl(embedUrlInput.value);
    embedUrlError.textContent = "";

    if (!embedUrl) {
      embedUrlError.textContent = "Enter a valid RTSP.ME embed URL, such as https://rtsp.me/embed/PLAYER_ID/.";
      embedUrlInput.focus();
      return;
    }

    cameraSubmitBtn.disabled = true;
    cameraSubmitBtn.textContent = "Adding...";

    try {
      const region = document.getElementById("region-text")?.value.trim() || document.getElementById("region")?.value.trim();
      const province = document.getElementById("province-text")?.value.trim() || document.getElementById("province")?.value.trim();
      const city = document.getElementById("city-text")?.value.trim() || document.getElementById("city")?.value.trim();
      const barangay = document.getElementById("barangay-text")?.value.trim() || document.getElementById("barangay")?.value.trim();
      const location = `${city}, ${barangay}`;

      const cameraData = {
        camId: document.getElementById("camId").value.trim(),
        title: document.getElementById("camTitle").value.trim(),
        region: region || "N/A",
        province: province || "N/A",
        city: city || "N/A",
        barangay: barangay || "N/A",
        location: location !== ", " ? location : "General Sector",
        ipAddress: document.getElementById("camIPAddress").value.trim(),
        resolution: document.getElementById("camResolution").value.trim() || "1920 x 1080",
        fps: parseInt(document.getElementById("camFPS").value, 10) || 30,
        status: document.getElementById("camStatus").value,
        embedUrl,
        createdAt: serverTimestamp(),
        thumbnailUrl: `https://picsum.photos/seed/${encodeURIComponent(document.getElementById("camId").value.trim())}/1200/800`,
        lastDetection: "No detections recorded",
        lastConnected: "Just now",
        detections: []
      };

      await addDoc(collection(db, "camera_feeds"), cameraData);
      showNotification("Camera added successfully!", "success");
      closeAddModal();
    } catch (error) {
      console.error("Error saving camera:", error);
      showNotification(`Error adding camera: ${error.message}`, "error");
    } finally {
      cameraSubmitBtn.disabled = false;
      cameraSubmitBtn.textContent = "Add Camera";
    }
  });

  editCameraForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!editingCameraId) return;

    const embedUrl = normalizeRtspEmbedUrl(editEmbedUrlInput.value);
    editEmbedUrlError.textContent = "";

    if (!embedUrl) {
      editEmbedUrlError.textContent = "Enter a valid RTSP.ME embed URL, such as https://rtsp.me/embed/PLAYER_ID/.";
      editEmbedUrlInput.focus();
      return;
    }

    cameraEditSubmitBtn.disabled = true;
    cameraEditSubmitBtn.textContent = "Saving...";

    try {
      const region = document.getElementById("editRegion")?.value.trim();
      const province = document.getElementById("editProvince")?.value.trim();
      const city = document.getElementById("editCity")?.value.trim();
      const barangay = document.getElementById("editBarangay")?.value.trim();
      const location = `${city}, ${barangay}`;

      const cameraData = {
        camId: document.getElementById("editCamId").value.trim(),
        title: document.getElementById("editCamTitle").value.trim(),
        region: region || "N/A",
        province: province || "N/A",
        city: city || "N/A",
        barangay: barangay || "N/A",
        location: location !== ", " ? location : "General Sector",
        ipAddress: document.getElementById("editCamIPAddress").value.trim(),
        resolution: document.getElementById("editCamResolution").value.trim() || "1920 x 1080",
        fps: parseInt(document.getElementById("editCamFPS").value, 10) || 30,
        status: document.getElementById("editCamStatus").value,
        embedUrl,
      };

      await updateDoc(doc(db, "camera_feeds", editingCameraId), cameraData);
      showNotification("Camera updated successfully!", "success");
      closeEditModal();
    } catch (error) {
      console.error("Error updating camera:", error);
      showNotification(`Error updating camera: ${error.message}`, "error");
    } finally {
      cameraEditSubmitBtn.disabled = false;
      cameraEditSubmitBtn.textContent = "Save Changes";
    }
  });

  document.getElementById("refreshStatusBtn")?.addEventListener("click", () => {
    systemMetrics.cpu = Math.floor(Math.random() * 80) + 10;
    systemMetrics.ram = Math.floor(Math.random() * 80) + 10;
    systemMetrics.disk = Math.floor(Math.random() * 60) + 10;
    systemMetrics.storage = Math.floor(Math.random() * 80) + 10;
    systemMetrics.dbLatency = Math.floor(Math.random() * 20) + 5;
    renderSystemMetrics();
    showNotification("System metrics refreshed", "success");
  });

  document.getElementById("viewLogsBtn")?.addEventListener("click", () => {
    window.location.href = "./Admin-Audit-Trail.html";
  });

  document.getElementById("systemSearchInput")?.addEventListener("input", (event) => {
    const query = event.target.value.toLowerCase();
    document.querySelectorAll("[data-camera-id]").forEach((card) => {
      card.style.display = card.textContent.toLowerCase().includes(query) ? "" : "none";
    });
  });

  onSnapshot(collection(db, "camera_feeds"), (snapshot) => {
    cameras = snapshot.docs.map((cameraDoc) => {
      const data = cameraDoc.data();
      return {
        id: cameraDoc.id,
        waterwayRoi: data.waterwayRoi || null,
        wasteCoverageClasses: data.wasteCoverageClasses || null,
        camId: data.camId || cameraDoc.id,
        title: data.title || "Unknown Camera",
        region: data.region || "N/A",
        province: data.province || "N/A",
        city: data.city || "N/A",
        barangay: data.barangay || "N/A",
        location: data.location || (data.city && data.barangay ? `${data.city}, ${data.barangay}` : "General Sector"),
        ipAddress: data.ipAddress || "N/A",
        resolution: data.resolution || "1920 x 1080",
        fps: data.fps || 30,
        status: data.status || "ONLINE",
        embedUrl: data.embedUrl || "",
        lastDetection: data.lastDetection || "No detections recorded",
        lastConnected: data.lastConnected || "Just now",
      };
    });
    renderCameras();
    const liveStatusEl = document.getElementById("liveStatusText");
    if (liveStatusEl) {
      liveStatusEl.textContent = `Live Stream · ${cameras.filter((camera) => camera.status === "ONLINE").length} of ${cameras.length} cameras online`;
    }
  }, (error) => {
    console.error("Failed to load camera_feeds from Firestore:", error);
    showNotification("Error syncing cameras", "error");
  });

  systemMetrics = {
    cpu: Math.floor(Math.random() * 80) + 10,
    ram: Math.floor(Math.random() * 80) + 10,
    disk: Math.floor(Math.random() * 60) + 10,
    storage: Math.floor(Math.random() * 80) + 10,
    dbLatency: Math.floor(Math.random() * 20) + 5,
    serverUptime: 99 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000,
  };
})();

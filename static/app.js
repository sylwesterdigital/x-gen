const $ = (sel, root = document) => root.querySelector(sel);

const JOBS_KEY = "grok_video_jobs_v4";
const COOL_KEY = "grok_cooldown_until_ms";

const VIDEO_ORDER_KEY = "grok_video_order_v1";

/* Stores large frame blobs in IndexedDB to avoid localStorage quota issues. */
const FRAMES_DB_NAME = "grok_frames_db_v1";
const FRAMES_STORE = "frames";

/* Opens (or creates) the frames IndexedDB. */
function openFramesDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FRAMES_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FRAMES_STORE)) {
        db.createObjectStore(FRAMES_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* Saves a Blob under a string key in IndexedDB. */
async function idbPutFrameBlob(key, blob) {
  const db = await openFramesDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FRAMES_STORE, "readwrite");
    tx.oncomplete = () => { try { db.close(); } catch {} resolve(true); };
    tx.onerror = () => { try { db.close(); } catch {} reject(tx.error || new Error("idb put failed")); };
    tx.objectStore(FRAMES_STORE).put(blob, key);
  });
}

/* Loads a Blob by key from IndexedDB (or null if missing). */
async function idbGetFrameBlob(key) {
  const db = await openFramesDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FRAMES_STORE, "readonly");
    const req = tx.objectStore(FRAMES_STORE).get(key);
    req.onsuccess = () => { try { db.close(); } catch {} resolve(req.result || null); };
    req.onerror = () => { try { db.close(); } catch {} reject(req.error); };
  });
}

/* Deletes a Blob by key from IndexedDB. */
async function idbDelFrameBlob(key) {
  const db = await openFramesDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FRAMES_STORE, "readwrite");
    tx.oncomplete = () => { try { db.close(); } catch {} resolve(true); };
    tx.onerror = () => { try { db.close(); } catch {} reject(tx.error || new Error("idb del failed")); };
    tx.objectStore(FRAMES_STORE).delete(key);
  });
}

/* Clears all stored frame blobs from IndexedDB. */
async function idbClearAllFrames() {
  const db = await openFramesDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FRAMES_STORE, "readwrite");
    tx.oncomplete = () => { try { db.close(); } catch {} resolve(true); };
    tx.onerror = () => { try { db.close(); } catch {} reject(tx.error || new Error("idb clear failed")); };
    tx.objectStore(FRAMES_STORE).clear();
  });
}

/* Loads persisted video order from localStorage. */
function loadVideoOrder() {
  try {
    const raw = localStorage.getItem(VIDEO_ORDER_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/* Saves video order list to localStorage. */
function saveVideoOrder(order) {
  const safe = Array.isArray(order) ? order : [];
  localStorage.setItem(VIDEO_ORDER_KEY, JSON.stringify(safe.slice(0, 400)));
}

/* Maps a video URL to the correct player src (proxy for remote, direct for local). */
function getPlayerSrc(url) {
  const u = String(url || "");
  if (!u) return "";
  if (u.startsWith("http://") || u.startsWith("https://")) {
    return `/api/video_proxy?url=${encodeURIComponent(u)}`;
  }
  return u;
}

function loadJobs() {
  try {
    const raw = localStorage.getItem(JOBS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveJobs(jobs) {
  const safe = Array.isArray(jobs) ? jobs : [];
  const trimmed = safe.slice(0, 150);

  try {
    localStorage.setItem(JOBS_KEY, JSON.stringify(trimmed));
    return;
  } catch (e) {
    if (!(e && String(e.name || "").includes("QuotaExceeded"))) throw e;
  }

  const stripped = trimmed.map(j => {
    if (!j || typeof j !== "object") return j;
    const copy = { ...j };
    copy.frames = [];
    return copy;
  });

  try {
    localStorage.setItem(JOBS_KEY, JSON.stringify(stripped));
    return;
  } catch (e) {
    if (!(e && String(e.name || "").includes("QuotaExceeded"))) throw e;
  }

  const smaller = stripped.slice(0, 50);
  localStorage.setItem(JOBS_KEY, JSON.stringify(smaller));
}

function upsertJob(job) {
  const jobs = loadJobs();
  const idx = jobs.findIndex(j => j.request_id === job.request_id);
  if (idx >= 0) {
    const prev = jobs[idx] || {};
    jobs[idx] = {
      ...prev,
      ...job,
      frames: Array.isArray(prev.frames) ? prev.frames : (Array.isArray(job.frames) ? job.frames : []),
    };
  } else {
    jobs.unshift({ ...job, frames: Array.isArray(job.frames) ? job.frames : [] });
  }
  saveJobs(jobs);
}

function setJobStatus(requestId, patch) {
  const jobs = loadJobs();
  const idx = jobs.findIndex(j => j.request_id === requestId);
  if (idx < 0) return;
  const prev = jobs[idx] || {};
  const frames = Array.isArray(prev.frames) ? prev.frames : [];
  jobs[idx] = { ...prev, ...patch, frames };
  saveJobs(jobs);
}

function getJob(requestId) {
  const jobs = loadJobs();
  return jobs.find(j => j.request_id === requestId) || null;
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function resetPlayer() {
  const playerWrap = document.getElementById("playerWrap");
  const player = document.getElementById("player");
  if (player) {
    player.pause();
    player.removeAttribute("src");
    player.load();
  }
  if (playerWrap) playerWrap.style.display = "none";
}

function showPlayer(url) {
  const playerWrap = document.getElementById("playerWrap");
  const player = document.getElementById("player");
  if (!playerWrap || !player) return;

  playerWrap.style.display = "block";
  player.src = getPlayerSrc(url);
  player.load();
  player.play().catch(() => {});
}

function openDrawer() {
  const drawer = document.getElementById("drawer");
  const overlay = document.getElementById("drawerOverlay");
  if (drawer) {
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
  }
  if (overlay) {
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
  }
}

function closeDrawer() {
  const drawer = document.getElementById("drawer");
  const overlay = document.getElementById("drawerOverlay");
  if (drawer) {
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
  }
  if (overlay) {
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
  }
}

function renderJobsList(onSelect) {
  const list = document.getElementById("jobsList");
  if (!list) return;

  const jobs = loadJobs();
  if (!jobs.length) {
    list.innerHTML = `<div class="muted">No jobs yet.</div>`;
    return;
  }

  list.innerHTML = jobs.map(j => {
    const when = j.created_at ? new Date(j.created_at).toLocaleString() : "";
    const status = j.status || "unknown";
    const url = j.url || "";
    const prompt = j.prompt || "";
    const framesCount = Array.isArray(j.frames) ? j.frames.length : 0;

    return `
      <button class="jobItem" type="button" data-job="${escapeHtml(j.request_id)}">
        <div class="jobItemTop">
          <div class="jobItemId"><span class="mono">${escapeHtml(j.request_id)}</span></div>
          <div class="pill ${escapeHtml(status)}">${escapeHtml(status)}</div>
        </div>
        <div class="jobItemMeta muted small">${escapeHtml(when)} • frames: ${framesCount}</div>
        <div class="jobItemPrompt">${escapeHtml(prompt)}</div>
        <div class="jobItemUrl muted small">${url ? escapeHtml(url) : "url: (not saved yet)"}</div>
      </button>
    `;
  }).join("");

  list.onclick = (e) => {
    const btn = e.target.closest("button.jobItem");
    if (!btn) return;
    const requestId = btn.getAttribute("data-job");
    onSelect(requestId);
  };
}

/* Polls a request_id until DONE/EXPIRED, updates status UI + local history, optionally loads the player. */
async function poll(requestId, statusEl, resultEl, opts) {
  const options = opts || {};
  while (true) {
    const r = await fetch(`/api/status/${encodeURIComponent(requestId)}`);
    const data = await r.json();

    setJobStatus(requestId, {
      status: data.status || "unknown",
      url: data.url || undefined,
    });

    if (data.status === "pending") {
      statusEl.textContent = `PENDING\nrequest_id: ${requestId}\n${data.message || ""}`.trim();
      await sleep(4000);
      continue;
    }

    if (data.status === "expired") {
      statusEl.textContent = `EXPIRED\nrequest_id: ${requestId}`;
      resultEl.innerHTML = "";
      return;
    }

    if (data.status === "done") {
      statusEl.textContent =
        `DONE\nrequest_id: ${requestId}\nurl: ${data.url}\nduration: ${data.duration ?? ""}\nmodel: ${data.model ?? ""}`.trim();

      if (data.respect_moderation === false) {
        resultEl.innerHTML = `<div class="warn">Filtered by moderation.</div>`;
        return;
      }

      resultEl.innerHTML = `
        <div><b>Ready</b></div>
        <div class="muted">Previewing in player.</div>
        <div style="margin-top:6px;"><a href="${data.url}" target="_blank" rel="noreferrer">Open video URL</a></div>
      `;

      if (options.loadPlayer && data.url) {
        resetPlayer();
        showPlayer(data.url);
      }

      return;
    }

    statusEl.textContent = `Unknown: ${JSON.stringify(data)}`;
    return;
  }
}

/* Converts a data URL into a Blob. */
function dataUrlToBlob(dataUrl) {
  const parts = String(dataUrl || "").split(",");
  if (parts.length < 2) return null;
  const meta = parts[0];
  const b64 = parts[1];
  const m = /data:([^;]+);base64/.exec(meta);
  const mime = m ? m[1] : "application/octet-stream";
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/* Captures a still frame from the video player into a PNG data URL + blob for reuse. */
async function captureFrameFromPlayer(state) {
  const player = document.getElementById("player");
  if (!player) return null;

  if (player.readyState < 2) return null;

  player.pause();
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));

  const w = player.videoWidth || 0;
  const h = player.videoHeight || 0;
  if (!w || !h) return null;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  try {
    ctx.drawImage(player, 0, 0, w, h);
  } catch {
    return null;
  }

  const dataUrl = canvas.toDataURL("image/png");

  const parts = String(dataUrl).split(",");
  if (parts.length < 2) return null;
  const bin = atob(parts[1]);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: "image/png" });

  const frame = {
    dataUrl,
    mime: "image/png",
    name: "frame.png",
    width: w,
    height: h,
    createdAt: new Date().toISOString(),
    time: player.currentTime,
    objectUrl: URL.createObjectURL(blob),
    blob,
  };

  state.capturedFrame = frame;
  return frame;
}

function clearCapturedFrame(state) {
  const prev = state.capturedFrame;
  if (prev && prev.objectUrl) {
    try { URL.revokeObjectURL(prev.objectUrl); } catch {}
  }
  state.capturedFrame = null;
}

/* Updates the shared input preview UI (uploaded image OR captured/enhanced/upscaled frame). */
function updateFrameUI(state) {
  const img = document.getElementById("framePreview");
  const meta = document.getElementById("frameMeta");
  const imageEl = document.getElementById("image");
  if (!img || !meta) return;

  const file = imageEl && imageEl.files && imageEl.files[0] ? imageEl.files[0] : null;

  if (file && !state.useCapturedFrame) {
    if (state.uploadPreviewUrl) {
      try { URL.revokeObjectURL(state.uploadPreviewUrl); } catch {}
      state.uploadPreviewUrl = null;
    }

    const url = URL.createObjectURL(file);
    state.uploadPreviewUrl = url;

    img.src = url;
    img.style.display = "block";

    meta.textContent = `UPLOAD • ${file.name}`;

    const probe = new Image();
    probe.onload = () => {
      const w = probe.naturalWidth || 0;
      const h = probe.naturalHeight || 0;
      meta.textContent = w && h ? `UPLOAD • ${file.name} • ${w}×${h}` : `UPLOAD • ${file.name}`;
    };
    probe.onerror = () => {};
    probe.src = url;

    return;
  }

  if (!state.capturedFrame) {
    if (state.uploadPreviewUrl) {
      try { URL.revokeObjectURL(state.uploadPreviewUrl); } catch {}
      state.uploadPreviewUrl = null;
    }
    img.removeAttribute("src");
    img.style.display = "none";
    meta.textContent = "No input image selected.";
    return;
  }

  if (state.uploadPreviewUrl) {
    try { URL.revokeObjectURL(state.uploadPreviewUrl); } catch {}
    state.uploadPreviewUrl = null;
  }

  img.src = state.capturedFrame.objectUrl || "";
  img.style.display = "block";
  const w = state.capturedFrame.width || 0;
  const h = state.capturedFrame.height || 0;
  const t = typeof state.capturedFrame.time === "number" ? state.capturedFrame.time : 0;
  meta.textContent = w && h ? `${w}×${h} • t=${t.toFixed(3)}s` : `t=${t.toFixed(3)}s`;
}

function downloadBlobAsFile(blob, filename) {
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "frame.png";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => {
    try { URL.revokeObjectURL(url); } catch {}
  }, 500);
}

function renderFrameHistory(state) {
  const list = document.getElementById("frameHistoryList");
  const meta = document.getElementById("frameHistoryMeta");
  if (!list || !meta) return;

  if (!state.activeJobId) {
    meta.textContent = "No job selected.";
    list.innerHTML = `<div class="muted small">Select a job from History to see its frames.</div>`;
    return;
  }

  const job = getJob(state.activeJobId);
  const frames = job && Array.isArray(job.frames) ? job.frames : [];

  meta.textContent = `job: ${state.activeJobId} • frames: ${frames.length}`;

  if (!frames.length) {
    list.innerHTML = `<div class="muted small">No frames saved for this job.</div>`;
    return;
  }

  list.innerHTML = frames.map((f, idx) => {
    const t = typeof f.time === "number" ? f.time.toFixed(3) : "n/a";
    const created = f.createdAt ? new Date(f.createdAt).toLocaleString() : "";
    const w = Number.isFinite(f.width) ? f.width : 0;
    const h = Number.isFinite(f.height) ? f.height : 0;
    const key = String(f.idb_key || "");

    return `
      <div class="frameItem" data-idx="${idx}">
        <img class="frameThumb" data-idb="${escapeHtml(key)}" alt="frame ${idx}" />
        <div class="frameInfo">
          <div class="mono small">t=${escapeHtml(t)}s • ${escapeHtml(String(w))}×${escapeHtml(String(h))}</div>
          <div class="muted small">${escapeHtml(created)}</div>
          <div class="frameBtns">
            <button class="btn tiny ghost" data-act="load" data-idx="${idx}">Load</button>
            <button class="btn tiny ghost" data-act="download" data-idx="${idx}">Download</button>
            <button class="btn tiny ghost" data-act="delete" data-idx="${idx}">Delete</button>
          </div>
        </div>
      </div>
    `;
  }).join("");

  (async () => {
    const thumbs = list.querySelectorAll("img.frameThumb[data-idb]");
    for (const img of thumbs) {
      const key = img.getAttribute("data-idb") || "";
      if (!key) continue;
      try {
        const blob = await idbGetFrameBlob(key);
        if (!blob) continue;
        const u = URL.createObjectURL(blob);
        img.src = u;
        img.onload = () => { try { URL.revokeObjectURL(u); } catch {} };
      } catch {}
    }
  })();

  list.onclick = async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;

    const act = btn.getAttribute("data-act");
    const idx = parseInt(btn.getAttribute("data-idx"), 10);
    if (!Number.isFinite(idx)) return;

    const job2 = getJob(state.activeJobId);
    const frames2 = job2 && Array.isArray(job2.frames) ? job2.frames : [];
    const f = frames2[idx];
    if (!f) return;

    const key = String(f.idb_key || "");
    if (!key) return;

    if (act === "load") {
      const blob = await idbGetFrameBlob(key);
      if (!blob) return;

      clearCapturedFrame(state);
      state.capturedFrame = {
        dataUrl: "",
        mime: blob.type || "image/png",
        name: "frame.png",
        width: f.width || 0,
        height: f.height || 0,
        createdAt: f.createdAt || new Date().toISOString(),
        time: typeof f.time === "number" ? f.time : 0,
        objectUrl: URL.createObjectURL(blob),
        blob,
      };
      state.useCapturedFrame = true;

      const imageEl = document.getElementById("image");
      if (imageEl) imageEl.value = "";

      updateFrameUI(state);
      return;
    }

    if (act === "download") {
      const blob = await idbGetFrameBlob(key);
      if (!blob) return;
      const name = `frame_${state.activeJobId}_${idx}_t${(typeof f.time === "number" ? f.time.toFixed(3) : "na")}.png`;
      downloadBlobAsFile(blob, name);
      return;
    }

    if (act === "delete") {
      const jobs = loadJobs();
      const jidx = jobs.findIndex(j => j.request_id === state.activeJobId);
      if (jidx < 0) return;

      const prev = jobs[jidx] || {};
      const fr = Array.isArray(prev.frames) ? prev.frames.slice() : [];
      const removed = fr.splice(idx, 1)[0];

      jobs[jidx] = { ...prev, frames: fr };
      saveJobs(jobs);

      if (removed && removed.idb_key) {
        try { await idbDelFrameBlob(String(removed.idb_key)); } catch {}
      }

      renderFrameHistory(state);
      return;
    }
  };
}

function saveCapturedFrameToJob(state) {
  if (!state.activeJobId) return false;
  if (!state.capturedFrame || !state.capturedFrame.blob) return false;

  const jobs = loadJobs();
  const idx = jobs.findIndex(j => j.request_id === state.activeJobId);
  if (idx < 0) return false;

  const prev = jobs[idx] || {};
  const frames = Array.isArray(prev.frames) ? prev.frames : [];

  const createdAt = state.capturedFrame.createdAt || new Date().toISOString();
  const t = typeof state.capturedFrame.time === "number" ? state.capturedFrame.time : 0;
  const key = `job:${state.activeJobId}:ts:${createdAt}:t:${t.toFixed(3)}:${Math.random().toString(16).slice(2)}`;

  frames.unshift({
    idb_key: key,
    width: state.capturedFrame.width || 0,
    height: state.capturedFrame.height || 0,
    time: t,
    createdAt,
  });

  jobs[idx] = { ...prev, frames };
  saveJobs(jobs);

  idbPutFrameBlob(key, state.capturedFrame.blob).catch(() => {});
  return true;
}

/* Runs local upscale backend on the active image (upload OR captured) and swaps result as captured input. */
async function upscaleCapturedFrame(state, statusEl, hintEl) {
  const imageEl = document.getElementById("image");
  const file = imageEl && imageEl.files && imageEl.files[0] ? imageEl.files[0] : null;

  let srcBlob = null;
  let srcName = "frame.png";
  let srcTime = 0;

  if (file && !state.useCapturedFrame) {
    srcBlob = file;
    srcName = file.name || "upload.png";
    srcTime = 0;
  } else if (state && state.capturedFrame && state.capturedFrame.blob) {
    srcBlob = state.capturedFrame.blob;
    srcName = state.capturedFrame.name || "frame.png";
    srcTime = typeof state.capturedFrame.time === "number" ? state.capturedFrame.time : 0;
  }

  if (!srcBlob) {
    if (hintEl) hintEl.textContent = "No input image to upscale (upload or capture first).";
    return;
  }

  if (statusEl) statusEl.textContent = "UPSCALE\nSending image…";
  if (hintEl) hintEl.textContent = "Upscaling…";

  const form = new FormData();
  form.append("image", new File([srcBlob], srcName, { type: srcBlob.type || "image/png" }));
  form.append("model", "4");
  form.append("tilesize", "0");

  let r, data;
  try {
    r = await fetch("/api/upscale/frame", { method: "POST", body: form });
    data = await r.json();
  } catch {
    if (statusEl) statusEl.textContent = "UPSCALE\nFailed (network/error).";
    if (hintEl) hintEl.textContent = "";
    return;
  }

  if (!r.ok) {
    if (statusEl) statusEl.textContent = `UPSCALE ERROR\n${(data && data.error) ? data.error : "unknown"}\nreq_id: ${(data && data.req_id) ? data.req_id : ""}`.trim();
    if (hintEl) hintEl.textContent = "";
    return;
  }

  const outUrl = data && data.url ? String(data.url) : "";
  if (!outUrl) {
    if (statusEl) statusEl.textContent = "UPSCALE\nNo output URL returned.";
    if (hintEl) hintEl.textContent = "";
    return;
  }

  let blob;
  try {
    const rr = await fetch(outUrl, { cache: "no-store" });
    blob = await rr.blob();
  } catch {
    if (statusEl) statusEl.textContent = `UPSCALE\nSaved: ${outUrl}\nBut failed to load it back.`;
    if (hintEl) hintEl.textContent = "";
    return;
  }

  let w = 0, h = 0;
  try {
    const tmpUrl = URL.createObjectURL(blob);
    await new Promise((resolve) => {
      const im = new Image();
      im.onload = () => {
        w = im.naturalWidth || 0;
        h = im.naturalHeight || 0;
        try { URL.revokeObjectURL(tmpUrl); } catch {}
        resolve();
      };
      im.onerror = () => {
        try { URL.revokeObjectURL(tmpUrl); } catch {}
        resolve();
      };
      im.src = tmpUrl;
    });
  } catch {}

  clearCapturedFrame(state);

  state.capturedFrame = {
    dataUrl: "",
    mime: "image/png",
    name: "upscaled.png",
    width: w,
    height: h,
    createdAt: new Date().toISOString(),
    time: srcTime,
    objectUrl: URL.createObjectURL(blob),
    blob,
    localUrl: outUrl,
  };

  state.useCapturedFrame = true;

  if (imageEl) imageEl.value = "";
  if (state.uploadPreviewUrl) {
    try { URL.revokeObjectURL(state.uploadPreviewUrl); } catch {}
    state.uploadPreviewUrl = null;
  }

  updateFrameUI(state);

  if (statusEl) statusEl.textContent = `UPSCALE DONE\nurl: ${outUrl}`.trim();
  if (hintEl) hintEl.textContent = "Upscaled image is now the active input.";
}




/* Enhances the active image (upload OR captured) via /api/enhance/frame and swaps result as captured input. */
async function enhanceCapturedFrame(state, statusEl, hintEl) {
  const imageEl = document.getElementById("image");
  const file = imageEl && imageEl.files && imageEl.files[0] ? imageEl.files[0] : null;

  let srcBlob = null;
  let srcName = "frame.png";
  let srcTime = 0;

  if (file && !state.useCapturedFrame) {
    srcBlob = file;
    srcName = file.name || "upload.png";
    srcTime = 0;
  } else if (state && state.capturedFrame && state.capturedFrame.blob) {
    srcBlob = state.capturedFrame.blob;
    srcName = state.capturedFrame.name || "frame.png";
    srcTime = typeof state.capturedFrame.time === "number" ? state.capturedFrame.time : 0;
  }

  if (!srcBlob) {
    if (hintEl) hintEl.textContent = "No input image to enhance (upload or capture first).";
    return;
  }

  if (statusEl) statusEl.textContent = "ENHANCE\nSending image…";
  if (hintEl) hintEl.textContent = "Enhancing…";

  const form = new FormData();
  form.append("image", new File([srcBlob], srcName, { type: srcBlob.type || "image/png" }));
  form.append("model", "grok-imagine-image");
  form.append(
    "prompt",
    "Enhance for video use: reduce compression artifacts, improve sharpness without halos, preserve geometry/identity, add subtle film grain, avoid oversmoothing."
  );

  let r, data;
  try {
    r = await fetch("/api/enhance/frame", { method: "POST", body: form });
    data = await r.json();
  } catch {
    if (statusEl) statusEl.textContent = "ENHANCE\nFailed (network/error).";
    if (hintEl) hintEl.textContent = "";
    return;
  }

  if (!r.ok) {
    const ra = (data && data.retry_after) ? parseInt(data.retry_after, 10) || 0 : (parseInt(r.headers.get("Retry-After") || "0", 10) || 0);
    if (statusEl) statusEl.textContent = `ENHANCE\nError: ${data && data.error ? data.error : "unknown"}\nreq_id: ${data && data.req_id ? data.req_id : ""}`.trim();
    if (hintEl) hintEl.textContent = r.status === 429 ? `Rate-limited. Try again in ~${ra || 60}s.` : "";
    return;
  }

  const outUrl = data && data.url ? String(data.url) : "";
  if (!outUrl) {
    if (statusEl) statusEl.textContent = "ENHANCE\nFailed (no url returned).";
    if (hintEl) hintEl.textContent = "";
    return;
  }

  let blob;
  try {
    const rr = await fetch(outUrl, { cache: "no-store" });
    blob = await rr.blob();
  } catch {
    if (statusEl) statusEl.textContent = "ENHANCE\nFailed (could not fetch enhanced output).";
    if (hintEl) hintEl.textContent = "";
    return;
  }

  let w = 0, h = 0;
  try {
    const tmpUrl = URL.createObjectURL(blob);
    await new Promise((resolve) => {
      const im = new Image();
      im.onload = () => {
        w = im.naturalWidth || 0;
        h = im.naturalHeight || 0;
        try { URL.revokeObjectURL(tmpUrl); } catch {}
        resolve();
      };
      im.onerror = () => {
        try { URL.revokeObjectURL(tmpUrl); } catch {}
        resolve();
      };
      im.src = tmpUrl;
    });
  } catch {}

  clearCapturedFrame(state);

  state.capturedFrame = {
    dataUrl: "",
    mime: "image/png",
    name: "enhanced.png",
    width: w,
    height: h,
    createdAt: new Date().toISOString(),
    time: srcTime,
    objectUrl: URL.createObjectURL(blob),
    blob,
    localUrl: outUrl,
  };

  state.useCapturedFrame = true;

  if (imageEl) imageEl.value = "";
  if (state.uploadPreviewUrl) {
    try { URL.revokeObjectURL(state.uploadPreviewUrl); } catch {}
    state.uploadPreviewUrl = null;
  }

  updateFrameUI(state);

  if (statusEl) statusEl.textContent = `ENHANCE\nDone\nurl: ${outUrl}`.trim();
  if (hintEl) hintEl.textContent = "Enhanced image is now the active input.";
}



/* Restyles the active input image (uploaded file OR captured frame) via /api/enhance/frame using the current Prompt as the style instruction, then swaps it in as the new active source. */
async function restyleActiveImage(state, statusEl, hintEl, promptText) {
  const imageEl = document.getElementById("image");
  const file = imageEl && imageEl.files && imageEl.files[0] ? imageEl.files[0] : null;

  let srcBlob = null;
  let srcName = "frame.png";
  let srcTime = 0;

  if (file && !state.useCapturedFrame) {
    srcBlob = file;
    srcName = file.name || "upload.png";
    srcTime = 0;
  } else if (state && state.capturedFrame && state.capturedFrame.blob) {
    srcBlob = state.capturedFrame.blob;
    srcName = state.capturedFrame.name || "frame.png";
    srcTime = typeof state.capturedFrame.time === "number" ? state.capturedFrame.time : 0;
  }

  if (!srcBlob) {
    if (hintEl) hintEl.textContent = "No input image to restyle (upload or capture first).";
    return;
  }

  const uiPrompt = String(promptText || "").trim();
  if (!uiPrompt) {
    if (hintEl) hintEl.textContent = "Prompt is empty — write the restyle instruction in Prompt first.";
    return;
  }

  if (statusEl) statusEl.textContent = "RESTYLE\nSending image…";
  if (hintEl) hintEl.textContent = "Restyling…";

  const basePrompt =
    "Edit the provided image ONLY using the user's instruction.\n" +
    "Keep the same subject/identity/pose/clothing/background/camera/framing.\n" +
    "Do not add/remove objects or text.\n" +
    "Apply style/texture/lighting/color grading consistent with the instruction.\n" +
    "User instruction:\n";

  const form = new FormData();
  form.append("image", new File([srcBlob], srcName, { type: srcBlob.type || "image/png" }));
  form.append("model", "grok-imagine-image");
  form.append("prompt", basePrompt + uiPrompt);

  let r, data;
  try {
    r = await fetch("/api/enhance/frame", { method: "POST", body: form });
    data = await r.json();
  } catch {
    if (statusEl) statusEl.textContent = "RESTYLE\nFailed (network/error).";
    if (hintEl) hintEl.textContent = "";
    return;
  }

  if (!r.ok) {
    const ra = (data && data.retry_after)
      ? parseInt(data.retry_after, 10) || 0
      : (parseInt(r.headers.get("Retry-After") || "0", 10) || 0);

    if (statusEl) statusEl.textContent =
      `RESTYLE\nError: ${data && data.error ? data.error : "unknown"}\nreq_id: ${data && data.req_id ? data.req_id : ""}`.trim();

    if (hintEl) hintEl.textContent = r.status === 429 ? `Rate-limited. Try again in ~${ra || 60}s.` : "";
    return;
  }

  const outUrl = data && data.url ? String(data.url) : "";
  if (!outUrl) {
    if (statusEl) statusEl.textContent = "RESTYLE\nFailed (no url returned).";
    if (hintEl) hintEl.textContent = "";
    return;
  }

  let blob;
  try {
    const rr = await fetch(outUrl, { cache: "no-store" });
    blob = await rr.blob();
  } catch {
    if (statusEl) statusEl.textContent = "RESTYLE\nFailed (could not fetch output).";
    if (hintEl) hintEl.textContent = "";
    return;
  }

  let w = 0, h = 0;
  try {
    const tmpUrl = URL.createObjectURL(blob);
    await new Promise((resolve) => {
      const im = new Image();
      im.onload = () => {
        w = im.naturalWidth || 0;
        h = im.naturalHeight || 0;
        try { URL.revokeObjectURL(tmpUrl); } catch {}
        resolve();
      };
      im.onerror = () => {
        try { URL.revokeObjectURL(tmpUrl); } catch {}
        resolve();
      };
      im.src = tmpUrl;
    });
  } catch {}

  clearCapturedFrame(state);

  state.capturedFrame = {
    dataUrl: "",
    mime: "image/png",
    name: "restyled.png",
    width: w,
    height: h,
    createdAt: new Date().toISOString(),
    time: srcTime,
    objectUrl: URL.createObjectURL(blob),
    blob,
    localUrl: outUrl,
  };

  state.useCapturedFrame = true;

  if (imageEl) imageEl.value = "";
  if (state.uploadPreviewUrl) {
    try { URL.revokeObjectURL(state.uploadPreviewUrl); } catch {}
    state.uploadPreviewUrl = null;
  }

  updateFrameUI(state);

  if (statusEl) statusEl.textContent = `RESTYLE\nDone\nurl: ${outUrl}`.trim();
  if (hintEl) hintEl.textContent = "Restyled image is now the active input.";
}




let _cropBound = false;
let _cropStateRef = null;
let _cropSelection = null;
let _cropDragging = false;
let _cropDragStart = null;


/* Shows a full-screen overlay with an image preview + crop-to-captured-frame workflow (Enter confirms). */
function openImageOverlay(src, state) {
  const overlay = document.getElementById("imgOverlay");
  const img = document.getElementById("imgOverlayImg");
  const stage = document.getElementById("imgOverlayStage");
  const cropBox = document.getElementById("cropBox");
  const shade = document.getElementById("cropShade");
  if (!overlay || !img) return;

  if (!stage || !cropBox || !shade) {
    img.src = String(src || "");
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    return;
  }

  _cropStateRef = state || null;
  _cropSelection = null;
  _cropDragging = false;
  _cropDragStart = null;

  cropBox.classList.remove("active");
  shade.classList.remove("active");
  cropBox.style.left = "0px";
  cropBox.style.top = "0px";
  cropBox.style.width = "0px";
  cropBox.style.height = "0px";
  cropBox.setAttribute("aria-hidden", "true");

  img.src = String(src || "");
  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");
  try { stage.focus(); } catch {}

  if (_cropBound) return;
  _cropBound = true;

  const parseAspect = () => {
    const el = document.getElementById("aspect_ratio");
    const v = el ? String(el.value || "") : "";
    const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(v);
    if (!m) return 0;
    const a = parseFloat(m[1]);
    const b = parseFloat(m[2]);
    if (!a || !b) return 0;
    return a / b;
  };

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  const getRects = () => {
    const sr = stage.getBoundingClientRect();
    const ir = img.getBoundingClientRect();
    const nw = img.naturalWidth || 0;
    const nh = img.naturalHeight || 0;
    const offX = ir.left - sr.left;
    const offY = ir.top - sr.top;
    return { sr, ir, nw, nh, offX, offY };
  };

  const clearSelection = () => {
    _cropSelection = null;
    cropBox.classList.remove("active");
    shade.classList.remove("active");
    cropBox.setAttribute("aria-hidden", "true");
  };

  const setSelectionStagePx = (x, y, w, h) => {
    cropBox.style.left = `${x}px`;
    cropBox.style.top = `${y}px`;
    cropBox.style.width = `${w}px`;
    cropBox.style.height = `${h}px`;
    cropBox.classList.add("active");
    shade.classList.add("active");
    cropBox.setAttribute("aria-hidden", "false");
  };

  const hitTestSelectionStage = (sx, sy) => {
    if (!_cropSelection) return false;
    return (
      sx >= _cropSelection.x &&
      sy >= _cropSelection.y &&
      sx <= (_cropSelection.x + _cropSelection.w) &&
      sy <= (_cropSelection.y + _cropSelection.h)
    );
  };

  stage.addEventListener("pointerdown", (e) => {
    if (!overlay.classList.contains("open")) return;

    const { sr, ir, nw, nh, offX, offY } = getRects();
    if (!nw || !nh) return;

    const sx = e.clientX - sr.left;
    const sy = e.clientY - sr.top;

    if (_cropSelection && hitTestSelectionStage(sx, sy)) {
      _cropDragging = true;
      _cropDragStart = { x: sx, y: sy };
      try { stage.setPointerCapture(e.pointerId); } catch {}
      return;
    }

    const ix = e.clientX - ir.left;
    const iy = e.clientY - ir.top;

    if (ix < 0 || iy < 0 || ix > ir.width || iy > ir.height) {
      clearSelection();
      return;
    }

    _cropDragging = true;
    _cropDragStart = { x: ix, y: iy, mode: "new" };
    try { stage.setPointerCapture(e.pointerId); } catch {}
  });

  stage.addEventListener("pointermove", (e) => {
    if (!overlay.classList.contains("open")) return;
    if (!_cropDragging || !_cropDragStart) return;

    const { sr, ir, nw, nh, offX, offY } = getRects();
    if (!nw || !nh) return;

    const ar = parseAspect();

    if (_cropDragStart.mode !== "new") return;

    const sx = _cropDragStart.x;
    const sy = _cropDragStart.y;

    const ix = e.clientX - ir.left;
    const iy = e.clientY - ir.top;

    let dx = ix - sx;
    let dy = iy - sy;

    let w = Math.abs(dx);
    let h = Math.abs(dy);

    if (ar > 0) {
      if (w / Math.max(1e-6, h) > ar) h = w / ar;
      else w = h * ar;
    }

    const x0 = dx >= 0 ? sx : (sx - w);
    const y0 = dy >= 0 ? sy : (sy - h);

    const xImg = clamp(x0, 0, ir.width);
    const yImg = clamp(y0, 0, ir.height);

    const maxW = ir.width - xImg;
    const maxH = ir.height - yImg;

    let fw = clamp(w, 1, maxW);
    let fh = clamp(h, 1, maxH);

    if (ar > 0) {
      if (fw / Math.max(1e-6, fh) > ar) fw = fh * ar;
      else fh = fw / ar;
      fw = clamp(fw, 1, maxW);
      fh = clamp(fh, 1, maxH);
    }

    const stageX = offX + xImg;
    const stageY = offY + yImg;

    setSelectionStagePx(stageX, stageY, fw, fh);

    const scaleX = nw / ir.width;
    const scaleY = nh / ir.height;

    _cropSelection = {
      x: stageX,
      y: stageY,
      w: fw,
      h: fh,
      sx: xImg * scaleX,
      sy: yImg * scaleY,
      sw: fw * scaleX,
      sh: fh * scaleY,
    };
  });

  stage.addEventListener("pointerup", (e) => {
    if (!overlay.classList.contains("open")) return;
    if (!_cropDragging) return;
    _cropDragging = false;
    _cropDragStart = null;
    try { stage.releasePointerCapture(e.pointerId); } catch {}
  });

  stage.addEventListener("keydown", async (e) => {
    if (!overlay.classList.contains("open")) return;

    if (e.key === "Escape") {
      e.preventDefault();
      if (_cropSelection) clearSelection();
      else closeImageOverlay();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (typeof finalizeCropToCaptured === "function") {
        await finalizeCropToCaptured();
      }
      return;
    }
  });

  overlay.addEventListener("click", (e) => {
    if (!overlay.classList.contains("open")) return;
    if (e.target === overlay) closeImageOverlay();
  });

  const closeBtn = document.getElementById("imgOverlayClose");
  if (closeBtn) closeBtn.addEventListener("click", () => closeImageOverlay());
}

/* Closes the image overlay preview + clears crop selection state. */
function closeImageOverlay() {
  const overlay = document.getElementById("imgOverlay");
  const img = document.getElementById("imgOverlayImg");
  const cropBox = document.getElementById("cropBox");
  const shade = document.getElementById("cropShade");
  if (!overlay || !img) return;

  if (cropBox) {
    cropBox.classList.remove("active");
    cropBox.style.left = "0px";
    cropBox.style.top = "0px";
    cropBox.style.width = "0px";
    cropBox.style.height = "0px";
    cropBox.setAttribute("aria-hidden", "true");
  }
  if (shade) shade.classList.remove("active");

  _cropSelection = null;
  _cropDragging = false;
  _cropDragStart = null;
  _cropStateRef = null;

  img.removeAttribute("src");
  overlay.classList.remove("open");
  overlay.setAttribute("aria-hidden", "true");
}




async function finalizeCropToCaptured() {
  if (!_cropSelection || !_cropStateRef) return;

  const overlayImg = document.getElementById("imgOverlayImg");
  if (!overlayImg) return;

  const nw = overlayImg.naturalWidth || 0;
  const nh = overlayImg.naturalHeight || 0;
  if (!nw || !nh) return;

  const sx = Math.max(0, Math.floor(_cropSelection.sx || 0));
  const sy = Math.max(0, Math.floor(_cropSelection.sy || 0));
  const sw = Math.max(1, Math.floor(_cropSelection.sw || 0));
  const sh = Math.max(1, Math.floor(_cropSelection.sh || 0));

  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Draw selected region from the full-res image
  ctx.drawImage(overlayImg, sx, sy, sw, sh, 0, 0, sw, sh);

  const blob = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png")
  );
  if (!blob) return;

  // Replace current captured frame with cropped version
  clearCapturedFrame(_cropStateRef);

  _cropStateRef.capturedFrame = {
    dataUrl: "",
    mime: "image/png",
    name: "crop.png",
    width: sw,
    height: sh,
    createdAt: new Date().toISOString(),
    // keep time from previous captured frame if it existed
    time: (_cropStateRef.capturedFrame && typeof _cropStateRef.capturedFrame.time === "number")
      ? _cropStateRef.capturedFrame.time
      : 0,
    objectUrl: URL.createObjectURL(blob),
    blob,
  };

  _cropStateRef.useCapturedFrame = true;

  // Clear upload input so the cropped frame is the active source
  const imageEl = document.getElementById("image");
  if (imageEl) imageEl.value = "";

  updateFrameUI(_cropStateRef);
  closeImageOverlay();
}








/* Reads cooldown target (ms since epoch) from localStorage. */
function loadCooldownUntilMs() {
  try {
    const v = localStorage.getItem(COOL_KEY);
    const n = v ? parseInt(v, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/* Saves cooldown target timestamp to localStorage. */
function saveCooldownUntilMs(ms) {
  try { localStorage.setItem(COOL_KEY, String(ms || 0)); } catch {}
}

/* Starts cooldown for N seconds and updates badge + button state. */
function setCooldown(seconds, badgeEl, btnGenerate, hintEl) {
  const ms = Date.now() + Math.max(0, seconds) * 1000;
  saveCooldownUntilMs(ms);
  if (hintEl) hintEl.textContent = `Cooldown: ${seconds}s`;
  if (badgeEl) badgeEl.classList.remove("hidden");
  tickCooldown(badgeEl, btnGenerate);
}

/* Updates cooldown badge + disables generate while cooling; returns true if still cooling. */
function tickCooldown(badgeEl, btnGenerate) {
  const until = loadCooldownUntilMs();
  const left = Math.max(0, until - Date.now());
  const cooling = left > 0;

  if (badgeEl) {
    if (!until || until <= Date.now()) {
      badgeEl.classList.add("hidden");
      badgeEl.classList.remove("cooling");
    } else {
      badgeEl.classList.remove("hidden");
      badgeEl.classList.add("cooling");
      badgeEl.textContent = `Cooldown: ${(left / 1000).toFixed(1)}s`;
    }
  }

  if (btnGenerate) btnGenerate.disabled = !!cooling;
  return cooling;
}

/* Renders the horizontal shelf of DONE videos and handles selection + drag reorder + thumb AR. */
function renderVideoShelf(state) {
  const shelf = document.getElementById("videoShelf");
  if (!shelf) return;

  const jobsDone = loadJobs().filter(j => j && j.status === "done" && j.url);
  if (!jobsDone.length) {
    shelf.innerHTML = `<div class="muted small">No videos yet.</div>`;
    return;
  }

  const byId = new Map(jobsDone.map(j => [j.request_id, j]));
  const persisted = loadVideoOrder();

  const orderedIds = [];
  for (const id of persisted) if (byId.has(id)) orderedIds.push(id);
  for (const j of jobsDone) if (!orderedIds.includes(j.request_id)) orderedIds.push(j.request_id);

  saveVideoOrder(orderedIds);

  const selectedSet = new Set(Array.isArray(state.selectedVideoIds) ? state.selectedVideoIds : []);
  state.selectedVideoIds = orderedIds.filter(id => selectedSet.has(id));

  shelf.innerHTML = orderedIds.map(id => {
    const j = byId.get(id);
    const when = j && j.created_at ? new Date(j.created_at).toLocaleString() : "";
    const cls = selectedSet.has(id) ? "videoCard selected" : "videoCard";
    const src = j ? getPlayerSrc(j.url) : "";
    return `
      <div class="${cls}" draggable="true" data-vid="${escapeHtml(id)}" title="${escapeHtml((j && j.prompt) || "")}">
        <video class="videoThumb" muted playsinline preload="metadata" src="${escapeHtml(src)}"></video>
        <div class="videoMeta">
          <div class="videoId">${escapeHtml(id.slice(0, 8))}</div>
          <div class="videoTime">${escapeHtml(when)}</div>
        </div>
      </div>
    `;
  }).join("");

  const vids = shelf.querySelectorAll("video.videoThumb");
  for (const v of vids) {
    v.onloadedmetadata = () => {
      const w = v.videoWidth || 0;
      const h = v.videoHeight || 0;
      if (!w || !h) return;
      const card = v.closest(".videoCard");
      if (!card) return;
      card.style.setProperty("--thumb-ar", `${w}/${h}`);
    };
  }

  shelf.onclick = (e) => {
    const card = e.target.closest(".videoCard");
    if (!card) return;
    const id = card.getAttribute("data-vid");
    if (!id) return;

    if (e.shiftKey) {
      if (selectedSet.has(id)) selectedSet.delete(id);
      else selectedSet.add(id);
    } else {
      selectedSet.clear();
      selectedSet.add(id);
    }

    state.selectedVideoIds = orderedIds.filter(x => selectedSet.has(x));

    const job = getJob(id);
    if (job && job.url) {
      state.activeJobId = id;
      if (typeof renderFrameHistory === "function") renderFrameHistory(state);
      resetPlayer();
      showPlayer(job.url);
    }

    renderVideoShelf(state);
  };

  let dragFromId = null;

  shelf.ondragstart = (e) => {
    const card = e.target.closest(".videoCard");
    if (!card) return;
    dragFromId = card.getAttribute("data-vid");
    card.classList.add("dragging");
    try { e.dataTransfer.setData("text/plain", dragFromId || ""); } catch {}
    try { e.dataTransfer.effectAllowed = "move"; } catch {}
  };

  shelf.ondragend = (e) => {
    const card = e.target.closest(".videoCard");
    if (card) card.classList.remove("dragging");
    dragFromId = null;
  };

  shelf.ondragover = (e) => {
    const card = e.target.closest(".videoCard");
    if (!card) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = "move"; } catch {}
  };

  shelf.ondrop = (e) => {
    const toCard = e.target.closest(".videoCard");
    if (!toCard) return;
    e.preventDefault();

    const toId = toCard.getAttribute("data-vid");
    const fromId = dragFromId || (() => {
      try { return e.dataTransfer.getData("text/plain"); } catch { return ""; }
    })();

    if (!fromId || !toId || fromId === toId) return;

    const order = loadVideoOrder().filter(id => byId.has(id));
    for (const id of orderedIds) if (!order.includes(id)) order.push(id);

    const fromIdx = order.indexOf(fromId);
    const toIdx = order.indexOf(toId);
    if (fromIdx < 0 || toIdx < 0) return;

    order.splice(fromIdx, 1);
    order.splice(toIdx, 0, fromId);

    saveVideoOrder(order);

    const sel = new Set(Array.isArray(state.selectedVideoIds) ? state.selectedVideoIds : []);
    state.selectedVideoIds = order.filter(x => sel.has(x));

    renderVideoShelf(state);
  };
}

/* Joins selected shelf videos via backend ffmpeg concat endpoint. */
async function joinSelected(state, statusEl, hintEl) {
  const ids = Array.isArray(state.selectedVideoIds) ? state.selectedVideoIds.filter(Boolean) : [];
  if (ids.length < 2) {
    if (hintEl) hintEl.textContent = "Select at least 2 videos (Shift-click) to join.";
    return;
  }

  const jobs = ids.map(id => getJob(id)).filter(Boolean).filter(j => j.url);
  if (jobs.length < 2) {
    if (hintEl) hintEl.textContent = "Selected videos must have URLs.";
    return;
  }

  const urls = jobs.map(j => j.url);

  if (statusEl) statusEl.textContent = `JOIN\nSending ${urls.length} videos…`;
  if (hintEl) hintEl.textContent = "Joining…";

  let r, data;
  try {
    r = await fetch("/api/ffmpeg/concat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls }),
    });
    data = await r.json();
  } catch {
    if (statusEl) statusEl.textContent = "JOIN\nFailed (network/error).";
    if (hintEl) hintEl.textContent = "";
    return;
  }

  if (!r.ok) {
    if (statusEl) statusEl.textContent = `JOIN\nError: ${data && data.error ? data.error : "unknown"}`.trim();
    if (hintEl) hintEl.textContent = "";
    return;
  }

  const outUrl = data && data.url ? String(data.url) : "";
  if (!outUrl) {
    if (statusEl) statusEl.textContent = "JOIN\nNo output URL returned.";
    if (hintEl) hintEl.textContent = "";
    return;
  }

  const newId = `local_concat_${Date.now()}`;
  upsertJob({
    request_id: newId,
    prompt: "concat",
    created_at: new Date().toISOString(),
    status: "done",
    url: outUrl,
    frames: [],
  });

  state.selectedVideoIds = [newId];
  if (typeof renderVideoShelf === "function") renderVideoShelf(state);

  resetPlayer();
  showPlayer(outUrl);

  if (statusEl) statusEl.textContent = `JOIN\nDone\nurl: ${outUrl}`.trim();
  if (hintEl) hintEl.textContent = "Joined video added to shelf.";
}

/* Applies replace/mix audio using backend ffmpeg endpoint. */
async function audioOp(state, mode, statusEl, hintEl) {
  const ids = Array.isArray(state.selectedVideoIds) ? state.selectedVideoIds.filter(Boolean) : [];
  if (!ids.length) {
    if (hintEl) hintEl.textContent = "Select a video first.";
    return;
  }

  const vjob = getJob(ids[0]);
  if (!vjob || !vjob.url) {
    if (hintEl) hintEl.textContent = "Selected video has no URL.";
    return;
  }

  const audioEl = document.getElementById("audioFile");
  const af = audioEl && audioEl.files && audioEl.files[0] ? audioEl.files[0] : null;
  if (!af) {
    if (hintEl) hintEl.textContent = "Choose an audio file first.";
    return;
  }

  if (statusEl) statusEl.textContent = `AUDIO_${String(mode || "").toUpperCase()}\nUploading…`;
  if (hintEl) hintEl.textContent = "Processing…";

  const form = new FormData();
  form.append("video_url", vjob.url);
  form.append("audio", af);
  form.append("mode", mode);

  let r, data;
  try {
    r = await fetch("/api/ffmpeg/audio", { method: "POST", body: form });
    data = await r.json();
  } catch {
    if (statusEl) statusEl.textContent = `AUDIO_${String(mode || "").toUpperCase()}\nFailed (network/error).`;
    if (hintEl) hintEl.textContent = "";
    return;
  }

  if (!r.ok) {
    if (statusEl) statusEl.textContent = `AUDIO_${String(mode || "").toUpperCase()}\nError: ${data && data.error ? data.error : "unknown"}`.trim();
    if (hintEl) hintEl.textContent = "";
    return;
  }

  const outUrl = data && data.url ? String(data.url) : "";
  if (!outUrl) {
    if (statusEl) statusEl.textContent = `AUDIO_${String(mode || "").toUpperCase()}\nNo output URL returned.`;
    if (hintEl) hintEl.textContent = "";
    return;
  }

  const newId = `local_audio_${mode}_${Date.now()}`;
  upsertJob({
    request_id: newId,
    prompt: `audio_${mode}`,
    created_at: new Date().toISOString(),
    status: "done",
    url: outUrl,
    frames: [],
  });

  state.selectedVideoIds = [newId];
  if (typeof renderVideoShelf === "function") renderVideoShelf(state);

  resetPlayer();
  showPlayer(outUrl);

  if (statusEl) statusEl.textContent = `AUDIO_${String(mode || "").toUpperCase()}\nDone\nurl: ${outUrl}`.trim();
  if (hintEl) hintEl.textContent = "Audio output added to shelf.";
}





// /* Boots the SPA generate view, wires handlers, and keeps history + shelf in sync. */
// function boot() {
//   if (!location.pathname.startsWith("/app")) {
//     history.replaceState(null, "", "/app");
//   }

//   const view = $("#view");
//   const tpl = $("#tpl-generate");
//   view.innerHTML = "";
//   view.appendChild(tpl.content.cloneNode(true));

//   const state = {
//     capturedFrame: null,
//     activeJobId: null,
//     selectedVideoIds: [],
//     useCapturedFrame: false,
//     uploadPreviewUrl: null,
//   };

//   const promptEl = $("#prompt");
//   const durationEl = $("#duration");
//   const aspectEl = $("#aspect_ratio");
//   const resEl = $("#resolution");
//   const imageEl = $("#image");

//   const statusEl = $("#status");
//   const resultEl = $("#result");
//   const hintEl = $("#hint");

//   const badgeEl = $("#cooldownBadge");

//   const btnHistory = $("#topHistory");
//   const btnDrawerClose = $("#btn-drawer-close");
//   const overlay = $("#drawerOverlay");
//   const btnRefreshJobs = $("#btn-refresh-jobs");
//   const btnClearJobs = $("#btn-clear-jobs");

//   const btnCaptureFrame = $("#btn-capture-frame");
//   const btnUpscaleFrame = $("#btn-upscale-frame");
//   const btnEnhanceFrame = $("#btn-enhance-frame");
//   const btnClearFrame = $("#btn-clear-frame");
//   const btnDownloadFrame = $("#btn-download-frame");

//   const btnClearStatus = $("#btn-clear-status");
//   const btnJoin = $("#btn-join");
//   const btnAudioReplace = $("#btn-audio-replace");
//   const btnAudioMix = $("#btn-audio-mix");

//   const btnGenerate = $("#btn-generate");

//   const framePreview = document.getElementById("framePreview");
//   const imgOverlay = document.getElementById("imgOverlay");
//   const imgOverlayClose = document.getElementById("imgOverlayClose");

//   if (imageEl) {
//     imageEl.addEventListener("change", () => {
//       state.useCapturedFrame = false;
//       updateFrameUI(state);
//       hintEl.textContent = (imageEl.files && imageEl.files[0]) ? "Upload selected as input." : "";
//     });
//   }

//   function selectJob(requestId) {
//     const job = getJob(requestId);

//     state.activeJobId = requestId;
//     renderFrameHistory(state);

//     if (!job) {
//       statusEl.textContent = `Unknown job\nrequest_id: ${requestId}`;
//       resultEl.innerHTML = "";
//       resetPlayer();
//       closeDrawer();
//       return;
//     }

//     statusEl.textContent = `${(job.status || "unknown").toUpperCase()}\nrequest_id: ${requestId}${job.url ? `\nurl: ${job.url}` : ""}`;
//     resultEl.innerHTML = job.url
//       ? `<div class="muted">Loaded from history.</div><div style="margin-top:6px;"><a href="${job.url}" target="_blank" rel="noreferrer">Open video URL</a></div>`
//       : `<div class="muted">No URL saved yet — polling.</div>`;

//     if (job.url) {
//       resetPlayer();
//       showPlayer(job.url);
//     } else {
//       resetPlayer();
//       poll(requestId, statusEl, resultEl, { loadPlayer: true });
//     }

//     state.selectedVideoIds = [requestId];
//     renderVideoShelf(state);

//     closeDrawer();
//   }

//   function refreshJobsStatuses() {
//     const jobs = loadJobs().slice(0, 15);
//     for (const j of jobs) {
//       if (!j || !j.request_id) continue;
//       if (j.status === "done" && j.url) continue;
//       fetch(`/api/status/${encodeURIComponent(j.request_id)}`)
//         .then(r => r.json())
//         .then(data => {
//           setJobStatus(j.request_id, { status: data.status || "unknown", url: data.url || undefined });
//           renderJobsList(selectJob);
//           renderVideoShelf(state);
//           renderFrameHistory(state);
//         })
//         .catch(() => {});
//     }
//   }

//   async function readImageAspectRatio(fileOrBlob) {
//     return await new Promise((resolve) => {
//       const img = new Image();
//       const url = URL.createObjectURL(fileOrBlob);
//       img.onload = () => {
//         const w = img.naturalWidth || 0;
//         const h = img.naturalHeight || 0;
//         try { URL.revokeObjectURL(url); } catch {}
//         resolve({ w, h });
//       };
//       img.onerror = () => {
//         try { URL.revokeObjectURL(url); } catch {}
//         resolve({ w: 0, h: 0 });
//       };
//       img.src = url;
//     });
//   }

//   renderJobsList(selectJob);
//   updateFrameUI(state);
//   renderFrameHistory(state);
//   renderVideoShelf(state);

//   if (btnHistory) btnHistory.onclick = () => { renderJobsList(selectJob); openDrawer(); };
//   if (btnDrawerClose) btnDrawerClose.onclick = () => closeDrawer();
//   if (overlay) overlay.onclick = () => closeDrawer();

//   if (btnRefreshJobs) btnRefreshJobs.onclick = () => refreshJobsStatuses();

//   if (btnClearJobs) btnClearJobs.onclick = async () => {
//     saveJobs([]);
//     try { await idbClearAllFrames(); } catch {}
//     renderJobsList(selectJob);
//     state.activeJobId = null;
//     renderFrameHistory(state);
//     statusEl.textContent = "Idle.";
//     resultEl.innerHTML = "";
//     hintEl.textContent = "";
//     resetPlayer();
//   };

//   if (btnClearStatus) btnClearStatus.onclick = () => {
//     statusEl.textContent = "Idle.";
//     resultEl.innerHTML = "";
//   };

//   if (btnJoin) btnJoin.onclick = () => joinSelected(state, statusEl, hintEl);
//   if (btnAudioReplace) btnAudioReplace.onclick = () => audioOp(state, "replace", statusEl, hintEl);
//   if (btnAudioMix) btnAudioMix.onclick = () => audioOp(state, "mix", statusEl, hintEl);

//   if (btnCaptureFrame) btnCaptureFrame.onclick = async () => {
//     hintEl.textContent = "Capturing frame…";

//     const frame = await captureFrameFromPlayer(state);
//     updateFrameUI(state);

//     if (!frame) {
//       hintEl.textContent = "Capture failed (player not ready or frame access blocked).";
//       return;
//     }

//     if (imageEl) imageEl.value = "";
//     state.useCapturedFrame = true;

//     const saved = saveCapturedFrameToJob(state);
//     renderFrameHistory(state);

//     hintEl.textContent = saved
//       ? `Frame captured + saved: ${frame.width}×${frame.height} @ t=${frame.time.toFixed(3)}s`
//       : `Frame captured: ${frame.width}×${frame.height} @ t=${frame.time.toFixed(3)}s (select a job to save)`;
//   };

//   if (btnUpscaleFrame) btnUpscaleFrame.onclick = async () => {
//     await upscaleCapturedFrame(state, statusEl, hintEl);
//     updateFrameUI(state);
//   };

//   if (btnEnhanceFrame) btnEnhanceFrame.onclick = async () => {
//     await enhanceCapturedFrame(state, statusEl, hintEl);
//     updateFrameUI(state);
//   };

//   if (btnDownloadFrame) btnDownloadFrame.onclick = () => {
//     if (!state.capturedFrame || !state.capturedFrame.blob) {
//       hintEl.textContent = "No frame to download.";
//       return;
//     }
//     const name = `frame_${state.activeJobId || "nojob"}_t${(typeof state.capturedFrame.time === "number" ? state.capturedFrame.time.toFixed(3) : "na")}.png`;
//     downloadBlobAsFile(state.capturedFrame.blob, name);
//   };

//   if (btnClearFrame) btnClearFrame.onclick = () => {
//     clearCapturedFrame(state);
//     updateFrameUI(state);
//     hintEl.textContent = "Frame cleared.";
//   };

//   if (framePreview) {
//     framePreview.addEventListener("click", () => {
//       const src = framePreview.getAttribute("src") || "";
//       if (!src) return;
//       openImageOverlay(src);
//     });
//   }

//   if (imgOverlayClose) imgOverlayClose.onclick = () => closeImageOverlay();
//   if (imgOverlay) {
//     imgOverlay.addEventListener("click", (e) => {
//       if (e.target === imgOverlay) closeImageOverlay();
//     });
//   }

//   $("#btn-clear").addEventListener("click", () => {
//     promptEl.value = "";
//     if (imageEl) imageEl.value = "";
//     state.useCapturedFrame = false;

//     if (state.uploadPreviewUrl) {
//       try { URL.revokeObjectURL(state.uploadPreviewUrl); } catch {}
//       state.uploadPreviewUrl = null;
//     }

//     statusEl.textContent = "Idle.";
//     resultEl.innerHTML = "";
//     hintEl.textContent = "";
//     resetPlayer();
//     clearCapturedFrame(state);
//     updateFrameUI(state);
//   });

//   if (badgeEl && btnGenerate) {
//     tickCooldown(badgeEl, btnGenerate);
//     setInterval(() => tickCooldown(badgeEl, btnGenerate), 250);
//   }

//   $("#btn-generate").addEventListener("click", async () => {
//     if (badgeEl && btnGenerate && tickCooldown(badgeEl, btnGenerate)) {
//       hintEl.textContent = "Wait for cooldown to finish.";
//       return;
//     }

//     resultEl.innerHTML = "";
//     hintEl.textContent = "";
//     resetPlayer();

//     const prompt = (promptEl.value || "").trim();
//     if (!prompt) {
//       statusEl.textContent = "Please enter a prompt.";
//       return;
//     }

//     const form = new FormData();
//     form.append("prompt", prompt);
//     form.append("duration", String(parseInt(durationEl.value, 10) || 8));
//     form.append("resolution", resEl.value);

//     const file = imageEl && imageEl.files && imageEl.files[0] ? imageEl.files[0] : null;
//     let sourceImageBlob = null;

//     if (state.useCapturedFrame && state.capturedFrame && state.capturedFrame.blob) {
//       sourceImageBlob = state.capturedFrame.blob;
//       const f = new File([state.capturedFrame.blob], "frame.png", { type: "image/png" });
//       form.append("image", f);
//     } else if (file) {
//       sourceImageBlob = file;
//       form.append("image", file);
//     }

//     if (sourceImageBlob) {
//       const { w, h } = await readImageAspectRatio(sourceImageBlob);
//       if (w && h) {
//         const ratio = w / h;
//         const candidates = [
//           { v: "1:1", r: 1 },
//           { v: "16:9", r: 16 / 9 },
//           { v: "9:16", r: 9 / 16 },
//           { v: "4:3", r: 4 / 3 },
//           { v: "3:4", r: 3 / 4 },
//           { v: "3:2", r: 3 / 2 },
//           { v: "2:3", r: 2 / 3 },
//         ];
//         let best = candidates[0];
//         let bestDiff = Math.abs(ratio - best.r);
//         for (const c of candidates) {
//           const d = Math.abs(ratio - c.r);
//           if (d < bestDiff) {
//             best = c;
//             bestDiff = d;
//           }
//         }
//         form.append("aspect_ratio", best.v);
//       } else {
//         form.append("aspect_ratio", aspectEl.value);
//       }
//     } else {
//       form.append("aspect_ratio", aspectEl.value);
//     }

//     statusEl.textContent = "Starting…";
//     hintEl.textContent = "Polling for result (can take minutes).";

//     const startResp = await fetch("/api/start", { method: "POST", body: form });
//     const startData = await startResp.json();

//     if (!startResp.ok) {
//       const ra = startData.retry_after || parseInt(startResp.headers.get("Retry-After") || "0", 10) || 0;
//       statusEl.textContent = `Error: ${startData.error || "unknown"}\nreq_id: ${startData.req_id || ""}`.trim();
//       if (startResp.status === 429 && ra) setCooldown(ra, badgeEl, btnGenerate, hintEl);
//       hintEl.textContent = startResp.status === 429 ? `Rate-limited. Cooldown started (${ra || 60}s).` : "";
//       return;
//     }

//     const requestId = startData.request_id;

//     upsertJob({
//       request_id: requestId,
//       prompt,
//       created_at: new Date().toISOString(),
//       status: "pending",
//       url: undefined,
//       frames: [],
//     });

//     state.activeJobId = requestId;
//     state.selectedVideoIds = [requestId];
//     renderJobsList(selectJob);
//     renderFrameHistory(state);
//     renderVideoShelf(state);

//     statusEl.textContent = `Started.\nrequest_id: ${requestId}`;
//     await poll(requestId, statusEl, resultEl, { loadPlayer: true });
//     hintEl.textContent = "";
//     renderJobsList(selectJob);
//     renderVideoShelf(state);
//   });
// }


/* Boots the single Generate view, wires UI events, and runs generation/polling + cooldown. */
function boot() {
  if (!location.pathname.startsWith("/app")) history.replaceState(null, "", "/app");

  const view = $("#view");
  const tpl = $("#tpl-generate");
  view.innerHTML = "";
  view.appendChild(tpl.content.cloneNode(true));

  const state = {
    capturedFrame: null,
    activeJobId: null,
    selectedVideoIds: [],
    useCapturedFrame: false,
    uploadPreviewUrl: null,
  };

  const promptEl = $("#prompt");
  const durationEl = $("#duration");
  const aspectEl = $("#aspect_ratio");
  const resEl = $("#resolution");
  const imageEl = $("#image");

  const statusEl = $("#status");
  const resultEl = $("#result");
  const hintEl = $("#hint");

  const badgeEl = $("#cooldownBadge");

  const btnHistory = $("#topHistory");
  const btnDrawerClose = $("#btn-drawer-close");
  const overlay = $("#drawerOverlay");
  const btnRefreshJobs = $("#btn-refresh-jobs");
  const btnClearJobs = $("#btn-clear-jobs");

  const btnCaptureFrame = $("#btn-capture-frame");
  const btnUpscaleFrame = $("#btn-upscale-frame");
  const btnEnhanceFrame = $("#btn-enhance-frame");
  const btnClearFrame = $("#btn-clear-frame");
  const btnDownloadFrame = $("#btn-download-frame");

  const btnClearStatus = $("#btn-clear-status");
  const btnJoin = $("#btn-join");
  const btnAudioReplace = $("#btn-audio-replace");
  const btnAudioMix = $("#btn-audio-mix");

  const btnGenerate = $("#btn-generate");
  const btnRestyle = $("#btn-restyle");

  const framePreviewEl = document.getElementById("framePreview");
  const imgOverlayEl = document.getElementById("imgOverlay");
  const imgOverlayImgEl = document.getElementById("imgOverlayImg");
  const imgOverlayCloseEl = document.getElementById("imgOverlayClose");

  if (imageEl) {
    imageEl.addEventListener("change", () => {
      state.useCapturedFrame = false;
      updateFrameUI(state);
      hintEl.textContent = (imageEl.files && imageEl.files[0]) ? "Upload selected as input." : "";
    });
  }

if (framePreviewEl) {
  framePreviewEl.addEventListener("click", () => {
    const src = framePreviewEl.getAttribute("src") || "";
    if (!src) return;
    openImageOverlay(src, state);
  });
}

  if (imgOverlayCloseEl) imgOverlayCloseEl.onclick = () => closeImageOverlay();
  if (imgOverlayEl) {
    imgOverlayEl.addEventListener("click", (e) => {
      if (e.target === imgOverlayEl) closeImageOverlay();
    });
  }

  function selectJob(requestId) {
    const job = getJob(requestId);
    state.activeJobId = requestId;
    renderFrameHistory(state);

    if (!job) {
      statusEl.textContent = `Unknown job\nrequest_id: ${requestId}`;
      resultEl.innerHTML = "";
      resetPlayer();
      closeDrawer();
      return;
    }

    statusEl.textContent = `${(job.status || "unknown").toUpperCase()}\nrequest_id: ${requestId}${job.url ? `\nurl: ${job.url}` : ""}`;

    if (job.url) {
      resetPlayer();
      showPlayer(job.url);
    } else {
      resetPlayer();
      poll(requestId, statusEl, resultEl, { loadPlayer: true });
    }

    state.selectedVideoIds = [requestId];
    renderVideoShelf(state);
    closeDrawer();
  }

  function refreshJobsStatuses() {
    const jobs = loadJobs().slice(0, 20);
    for (const j of jobs) {
      if (!j || !j.request_id) continue;
      if (j.status === "done" && j.url) continue;
      fetch(`/api/status/${encodeURIComponent(j.request_id)}`)
        .then(r => r.json())
        .then(data => {
          setJobStatus(j.request_id, { status: data.status || "unknown", url: data.url || undefined });
          renderJobsList(selectJob);
          renderVideoShelf(state);
          renderFrameHistory(state);
        })
        .catch(() => {});
    }
  }

  async function readImageAspectRatio(fileOrBlob) {
    return await new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(fileOrBlob);
      img.onload = () => {
        const w = img.naturalWidth || 0;
        const h = img.naturalHeight || 0;
        try { URL.revokeObjectURL(url); } catch {}
        resolve({ w, h });
      };
      img.onerror = () => {
        try { URL.revokeObjectURL(url); } catch {}
        resolve({ w: 0, h: 0 });
      };
      img.src = url;
    });
  }

  renderJobsList(selectJob);
  renderVideoShelf(state);
  updateFrameUI(state);
  renderFrameHistory(state);

  if (btnHistory) btnHistory.onclick = () => { renderJobsList(selectJob); openDrawer(); };
  if (btnDrawerClose) btnDrawerClose.onclick = () => closeDrawer();
  if (overlay) overlay.onclick = () => closeDrawer();

  if (btnRefreshJobs) btnRefreshJobs.onclick = () => refreshJobsStatuses();

  if (btnClearJobs) btnClearJobs.onclick = () => {
    saveJobs([]);
    renderJobsList(selectJob);
    renderVideoShelf(state);
    state.activeJobId = null;
    state.selectedVideoIds = [];
    renderFrameHistory(state);
    statusEl.textContent = "Idle.";
    resultEl.innerHTML = "";
    hintEl.textContent = "";
    resetPlayer();
    clearCapturedFrame(state);
    state.useCapturedFrame = false;
    updateFrameUI(state);
  };

  if (btnClearStatus) btnClearStatus.onclick = () => {
    statusEl.textContent = "Idle.";
    resultEl.innerHTML = "";
  };

  if (btnJoin) btnJoin.onclick = () => joinSelected(state, statusEl, hintEl);
  if (btnAudioReplace) btnAudioReplace.onclick = () => audioOp(state, "replace", statusEl, hintEl);
  if (btnAudioMix) btnAudioMix.onclick = () => audioOp(state, "mix", statusEl, hintEl);

  if (btnCaptureFrame) btnCaptureFrame.onclick = async () => {
    hintEl.textContent = "Capturing frame…";

    const frame = await captureFrameFromPlayer(state);
    state.useCapturedFrame = true;

    if (imageEl) imageEl.value = "";
    updateFrameUI(state);

    if (!frame) {
      hintEl.textContent = "Capture failed (player not ready or frame access blocked).";
      return;
    }

    const saved = saveCapturedFrameToJob(state);
    renderFrameHistory(state);

    hintEl.textContent = saved
      ? `Frame captured + saved: ${frame.width}×${frame.height} @ t=${frame.time.toFixed(3)}s`
      : `Frame captured: ${frame.width}×${frame.height} @ t=${frame.time.toFixed(3)}s (select a job to save)`;
  };

  if (btnUpscaleFrame) btnUpscaleFrame.onclick = async () => {
    await upscaleCapturedFrame(state, statusEl, hintEl);
    updateFrameUI(state);
  };

  if (btnEnhanceFrame) btnEnhanceFrame.onclick = async () => {
    await enhanceCapturedFrame(state, statusEl, hintEl);
    updateFrameUI(state);
  };

  if (btnRestyle) btnRestyle.onclick = async () => {
    await restyleActiveImage(state, statusEl, hintEl, promptEl ? promptEl.value : "");
    updateFrameUI(state);
  };

  if (btnDownloadFrame) btnDownloadFrame.onclick = () => {
    if (!state.capturedFrame || !state.capturedFrame.blob) {
      hintEl.textContent = "No frame to download.";
      return;
    }
    const name = `frame_${state.activeJobId || "nojob"}_t${(typeof state.capturedFrame.time === "number" ? state.capturedFrame.time.toFixed(3) : "na")}.png`;
    downloadBlobAsFile(state.capturedFrame.blob, name);
  };

  if (btnClearFrame) btnClearFrame.onclick = () => {
    clearCapturedFrame(state);
    updateFrameUI(state);
    hintEl.textContent = "Frame cleared.";
  };

  $("#btn-clear").addEventListener("click", () => {
    promptEl.value = "";
    if (imageEl) imageEl.value = "";
    statusEl.textContent = "Idle.";
    resultEl.innerHTML = "";
    hintEl.textContent = "";
    resetPlayer();
    clearCapturedFrame(state);
    state.useCapturedFrame = false;
    if (state.uploadPreviewUrl) {
      try { URL.revokeObjectURL(state.uploadPreviewUrl); } catch {}
      state.uploadPreviewUrl = null;
    }
    updateFrameUI(state);
  });

  tickCooldown(badgeEl, btnGenerate);
  setInterval(() => tickCooldown(badgeEl, btnGenerate), 250);

  $("#btn-generate").addEventListener("click", async () => {
    if (tickCooldown(badgeEl, btnGenerate)) {
      hintEl.textContent = "Cooldown active. Wait before starting a new request.";
      return;
    }

    resultEl.innerHTML = "";
    hintEl.textContent = "";
    resetPlayer();

    const prompt = promptEl.value.trim();
    if (!prompt) {
      statusEl.textContent = "Please enter a prompt.";
      return;
    }

    const form = new FormData();
    form.append("prompt", prompt);
    form.append("duration", String(parseInt(durationEl.value, 10) || 8));
    form.append("resolution", resEl.value);

    const file = imageEl.files && imageEl.files[0];
    let sourceImageBlob = null;

    if (file && !state.useCapturedFrame) {
      sourceImageBlob = file;
      form.append("image", file);
    } else if (state.capturedFrame && state.capturedFrame.blob) {
      sourceImageBlob = state.capturedFrame.blob;
      const f = new File([state.capturedFrame.blob], "frame.png", { type: "image/png" });
      form.append("image", f);
    }

    if (sourceImageBlob) {
      const { w, h } = await readImageAspectRatio(sourceImageBlob);
      if (w && h) {
        const ratio = w / h;
        const candidates = [
          { v: "1:1", r: 1 },
          { v: "16:9", r: 16 / 9 },
          { v: "9:16", r: 9 / 16 },
          { v: "4:3", r: 4 / 3 },
          { v: "3:4", r: 3 / 4 },
          { v: "3:2", r: 3 / 2 },
          { v: "2:3", r: 2 / 3 },
        ];
        let best = candidates[0];
        let bestDiff = Math.abs(ratio - best.r);
        for (const c of candidates) {
          const d = Math.abs(ratio - c.r);
          if (d < bestDiff) {
            best = c;
            bestDiff = d;
          }
        }
        form.append("aspect_ratio", best.v);
      } else {
        form.append("aspect_ratio", aspectEl.value);
      }
    } else {
      form.append("aspect_ratio", aspectEl.value);
    }

    statusEl.textContent = "Starting…";
    hintEl.textContent = "Polling for result (can take minutes).";

    const startResp = await fetch("/api/start", { method: "POST", body: form });
    const startData = await startResp.json();

    if (!startResp.ok) {
      const ra = (startData && startData.retry_after) ? parseInt(startData.retry_after, 10) || 0 : (parseInt(startResp.headers.get("Retry-After") || "0", 10) || 0);
      statusEl.textContent = `Error: ${startData.error || "unknown"}\nreq_id: ${startData.req_id || ""}`.trim();
      hintEl.textContent = startResp.status === 429 ? `Rate-limited. Wait ~${ra || 60}s and try again.` : "";
      if (startResp.status === 429) setCooldown(Math.max(10, ra || 60), badgeEl, btnGenerate, hintEl);
      return;
    }

    const requestId = startData.request_id;

    upsertJob({
      request_id: requestId,
      prompt,
      created_at: new Date().toISOString(),
      status: "pending",
      url: undefined,
      frames: [],
    });

    state.activeJobId = requestId;
    state.selectedVideoIds = [requestId];
    renderJobsList(selectJob);
    renderVideoShelf(state);
    renderFrameHistory(state);

    statusEl.textContent = `Started.\nrequest_id: ${requestId}`;
    await poll(requestId, statusEl, resultEl, { loadPlayer: true });
    hintEl.textContent = "";
    renderJobsList(selectJob);
    renderVideoShelf(state);
  });
}



boot();
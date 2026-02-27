const $ = (sel, root = document) => root.querySelector(sel);

const JOBS_KEY = "grok_video_jobs_v3";

/* Loads persisted job history (videos + frames) from localStorage. */
function loadJobs() {
  try {
    const raw = localStorage.getItem(JOBS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/* Persists job history back to localStorage (capped to 100 items). */
function saveJobs(jobs) {
  const safe = Array.isArray(jobs) ? jobs : [];
  localStorage.setItem(JOBS_KEY, JSON.stringify(safe.slice(0, 100)));
}

/* Inserts or updates a job record while preserving its frames array. */
function upsertJob(job) {
  const jobs = loadJobs();
  const idx = jobs.findIndex(j => j.request_id === job.request_id);
  if (idx >= 0) {
    const prev = jobs[idx] || {};
    jobs[idx] = { ...prev, ...job, frames: Array.isArray(prev.frames) ? prev.frames : (Array.isArray(job.frames) ? job.frames : []) };
  } else {
    jobs.unshift({ ...job, frames: Array.isArray(job.frames) ? job.frames : [] });
  }
  saveJobs(jobs);
}

/* Updates status/url of a job without losing its frames list. */
function setJobStatus(requestId, patch) {
  const jobs = loadJobs();
  const idx = jobs.findIndex(j => j.request_id === requestId);
  if (idx < 0) return;
  const prev = jobs[idx] || {};
  const frames = Array.isArray(prev.frames) ? prev.frames : [];
  jobs[idx] = { ...prev, ...patch, frames };
  saveJobs(jobs);
}

/* Returns a single job record by request_id, or null if missing. */
function getJob(requestId) {
  const jobs = loadJobs();
  return jobs.find(j => j.request_id === requestId) || null;
}

/* Escapes user-provided strings for safe HTML interpolation. */
function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
}

/* Promise-based sleep utility for polling loops. */
async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* Stops the player and hides the player container. */
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

/* Loads the video into the player using same-origin proxy for frame capture. */
function showPlayer(url) {
  const playerWrap = document.getElementById("playerWrap");
  const player = document.getElementById("player");
  if (!playerWrap || !player) return;

  const proxied = `/api/video_proxy?url=${encodeURIComponent(url)}`;

  playerWrap.style.display = "block";
  player.src = proxied;
  player.load();
  player.play().catch(() => {});
}

/* Opens the history side drawer and overlay. */
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

/* Closes the history side drawer and overlay. */
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

/* Renders the job list into the drawer and wires selection callback. */
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

/* Polls a request_id until DONE/EXPIRED, updates UI + local history, optionally loads the player. */
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

/* Converts a base64 data URL into a Blob instance. */
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

/* Captures the paused player frame into state.capturedFrame as PNG dataUrl + Blob. */
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
  const blob = dataUrlToBlob(dataUrl);
  if (!blob) return null;

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

/* Clears captured frame and releases its object URL to avoid leaks. */
function clearCapturedFrame(state) {
  const prev = state.capturedFrame;
  if (prev && prev.objectUrl) {
    try { URL.revokeObjectURL(prev.objectUrl); } catch {}
  }
  state.capturedFrame = null;
}

/* Updates the on-page frame preview and metadata from state.capturedFrame. */
function updateFrameUI(state) {
  const img = document.getElementById("framePreview");
  const meta = document.getElementById("frameMeta");
  if (!img || !meta) return;

  if (!state.capturedFrame) {
    img.removeAttribute("src");
    img.style.display = "none";
    meta.textContent = "No frame captured.";
    return;
  }

  img.src = state.capturedFrame.objectUrl;
  img.style.display = "block";
  meta.textContent = `${state.capturedFrame.width}×${state.capturedFrame.height} • t=${state.capturedFrame.time.toFixed(3)}s`;
}

/* Triggers a browser download of a Blob as a file. */
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

/* Renders saved frames for the selected job and wires load/download actions. */
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
    return `
      <div class="frameItem" data-idx="${idx}">
        <img class="frameThumb" src="${f.dataUrl}" alt="frame ${idx}" />
        <div class="frameInfo">
          <div class="mono small">t=${escapeHtml(t)}s • ${escapeHtml(f.width)}×${escapeHtml(f.height)}</div>
          <div class="muted small">${escapeHtml(created)}</div>
          <div class="frameBtns">
            <button class="btn tiny ghost" data-act="load" data-idx="${idx}">Load</button>
            <button class="btn tiny ghost" data-act="download" data-idx="${idx}">Download</button>
          </div>
        </div>
      </div>
    `;
  }).join("");

  list.onclick = (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.getAttribute("data-act");
    const idx = parseInt(btn.getAttribute("data-idx"), 10);
    if (!Number.isFinite(idx)) return;

    const job2 = getJob(state.activeJobId);
    const frames2 = job2 && Array.isArray(job2.frames) ? job2.frames : [];
    const f = frames2[idx];
    if (!f) return;

    if (act === "load") {
      const blob = dataUrlToBlob(f.dataUrl);
      if (!blob) return;

      clearCapturedFrame(state);
      state.capturedFrame = {
        dataUrl: f.dataUrl,
        mime: "image/png",
        name: "frame.png",
        width: f.width,
        height: f.height,
        createdAt: f.createdAt || new Date().toISOString(),
        time: typeof f.time === "number" ? f.time : 0,
        objectUrl: URL.createObjectURL(blob),
        blob,
      };
      updateFrameUI(state);
      return;
    }

    if (act === "download") {
      const blob = dataUrlToBlob(f.dataUrl);
      if (!blob) return;
      const name = `frame_${state.activeJobId}_${idx}_t${(typeof f.time === "number" ? f.time.toFixed(3) : "na")}.png`;
      downloadBlobAsFile(blob, name);
    }
  };
}

/* Saves the current captured frame into the active job’s frames history. */
function saveCapturedFrameToJob(state) {
  if (!state.activeJobId) return false;
  if (!state.capturedFrame || !state.capturedFrame.dataUrl) return false;

  const jobs = loadJobs();
  const idx = jobs.findIndex(j => j.request_id === state.activeJobId);
  if (idx < 0) return false;

  const prev = jobs[idx] || {};
  const frames = Array.isArray(prev.frames) ? prev.frames : [];

  frames.unshift({
    dataUrl: state.capturedFrame.dataUrl,
    width: state.capturedFrame.width,
    height: state.capturedFrame.height,
    time: state.capturedFrame.time,
    createdAt: state.capturedFrame.createdAt,
  });

  jobs[idx] = { ...prev, frames };
  saveJobs(jobs);
  return true;
}

/* Boots the Generate view, wires UI events, and runs generation/polling. */
function boot() {
  if (!location.pathname.startsWith("/app")) {
    history.replaceState(null, "", "/app");
  }

  const view = $("#view");
  const tpl = $("#tpl-generate");
  view.innerHTML = "";
  view.appendChild(tpl.content.cloneNode(true));

  const state = {
    capturedFrame: null,
    activeJobId: null,
  };

  const promptEl = $("#prompt");
  const durationEl = $("#duration");
  const aspectEl = $("#aspect_ratio");
  const resEl = $("#resolution");
  const imageEl = $("#image");

  const statusEl = $("#status");
  const resultEl = $("#result");
  const hintEl = $("#hint");

  const btnHistory = $("#btn-history");
  const btnDrawerClose = $("#btn-drawer-close");
  const btnCloseHistory = $("#btn-close-history");
  const overlay = $("#drawerOverlay");

  const btnRefreshJobs = $("#btn-refresh-jobs");
  const btnClearJobs = $("#btn-clear-jobs");

  const btnCaptureFrame = $("#btn-capture-frame");
  const btnClearFrame = $("#btn-clear-frame");
  const btnDownloadFrame = $("#btn-download-frame");

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
    resultEl.innerHTML = job.url
      ? `<div class="muted">Loaded from history.</div><div style="margin-top:6px;"><a href="${job.url}" target="_blank" rel="noreferrer">Open video URL</a></div>`
      : `<div class="muted">No URL saved yet — polling.</div>`;

    if (job.url) {
      resetPlayer();
      showPlayer(job.url);
    } else {
      resetPlayer();
      poll(requestId, statusEl, resultEl, { loadPlayer: true });
    }

    closeDrawer();
  }

  function refreshJobsStatuses() {
    const jobs = loadJobs().slice(0, 15);
    for (const j of jobs) {
      if (!j || !j.request_id) continue;
      if (j.status === "done" && j.url) continue;
      fetch(`/api/status/${encodeURIComponent(j.request_id)}`)
        .then(r => r.json())
        .then(data => {
          setJobStatus(j.request_id, { status: data.status || "unknown", url: data.url || undefined });
          renderJobsList(selectJob);
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
  updateFrameUI(state);
  renderFrameHistory(state);

  if (btnHistory) btnHistory.onclick = () => { renderJobsList(selectJob); openDrawer(); };
  if (btnDrawerClose) btnDrawerClose.onclick = () => closeDrawer();
  if (btnCloseHistory) btnCloseHistory.onclick = () => closeDrawer();
  if (overlay) overlay.onclick = () => closeDrawer();

  if (btnRefreshJobs) btnRefreshJobs.onclick = () => refreshJobsStatuses();

  if (btnClearJobs) btnClearJobs.onclick = () => {
    saveJobs([]);
    renderJobsList(selectJob);
    state.activeJobId = null;
    renderFrameHistory(state);
    statusEl.textContent = "Idle.";
    resultEl.innerHTML = "";
    hintEl.textContent = "";
    resetPlayer();
  };

  if (btnCaptureFrame) btnCaptureFrame.onclick = async () => {
    hintEl.textContent = "Capturing frame…";

    const frame = await captureFrameFromPlayer(state);
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
    imageEl.value = "";
    statusEl.textContent = "Idle.";
    resultEl.innerHTML = "";
    hintEl.textContent = "";
    resetPlayer();
    clearCapturedFrame(state);
    updateFrameUI(state);
  });

  $("#btn-generate").addEventListener("click", async () => {
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

    if (file) {
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
      statusEl.textContent = `Error: ${startData.error || "unknown"}\nreq_id: ${startData.req_id || ""}`.trim();
      hintEl.textContent = "";
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
    renderJobsList(selectJob);
    renderFrameHistory(state);

    statusEl.textContent = `Started.\nrequest_id: ${requestId}`;
    await poll(requestId, statusEl, resultEl, { loadPlayer: true });
    hintEl.textContent = "";
    renderJobsList(selectJob);
  });
}

boot();
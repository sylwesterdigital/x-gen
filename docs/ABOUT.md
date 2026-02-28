## HANDOVER — App overview (what it does, how it works, what’s fragile)

### 1) What the app is (high level)

* Single-page web app served by a Python backend.
* Main workflow: **generate video** from prompt (+ optional image) → **poll status** → **preview video** → **save jobs history** → **capture frames** → **enhance/upscale/restyle** → **optional Tripo image→3D** → **preview 3D** → **save/download outputs**.

---

### 2) Frontend UI structure (what the user can do)

* **Prompt + generation controls**: prompt, duration, aspect ratio (when no image), resolution.
* **Video player**: previews a selected job’s video.
* **History drawer**: list of jobs (request_id, status, prompt, url).
* **Video shelf**: horizontal shelf of DONE videos with drag reorder + multi-select for join/audio ops.
* **Frame tools**:

  * Capture current video frame → becomes “active input image”.
  * Save captured frame to job history.
  * Load previous frames from job history.
  * Download/delete frames.
  * Upscale / Enhance / Restyle the active input image.
* **3D tools**:

  * Start Tripo image→3D from active input image.
  * Local GLB test load (to validate 3D viewer without spending credits).
  * Reopen last model (cached).

---

### 3) Persistence (where data is stored)

#### localStorage keys

* `grok_video_jobs_v4`

  * Stores job list (request_id, prompt, created_at, status, url, frames metadata).
  * **Frames are NOT stored as blobs here** (only metadata + IDB keys).
* `grok_video_order_v1`

  * Persisted shelf ordering for DONE videos.
* `grok_cooldown_until_ms`

  * Cooldown timer for rate-limit UX (disables Generate).
* UI prefs:

  * `aigen_shelf_mode_v1` (s/m/l)
  * `aigen_theme_v1` (sun/dark/custom)
  * `grok_player_size_v1` (s/m/l)

#### IndexedDB databases

* `grok_frames_db_v1` / store `frames`

  * Stores **frame PNG blobs** keyed by `idb_key`.
* `grok_models_db_v1` / store `models`

  * Stores **GLB blobs** keyed by a model key (ex: `tripo:<task_id>:<timestamp>`).
  * Important: there is typically **no visible “models library UI”**, so models can exist but appear “missing” unless explicitly listed/reopened.

#### Disk (server filesystem)

* Only exists if the backend implements **download-to-disk** route for Tripo models.
* When used, server writes a real `.glb` file (visible in Finder / macOS Preview).

---

### 4) Backend endpoints (expected behavior)

#### Video generation

* `POST /api/start`

  * Accepts `prompt`, `duration`, `resolution`, optional `image` OR `aspect_ratio`.
  * Returns `{ request_id }` or error + retry_after.
* `GET /api/status/<request_id>`

  * Returns `{ status: pending|done|expired, url, ... }`
* `GET /api/video_proxy?url=<remote_url>`

  * Proxies remote URLs through same origin to avoid CORS issues (video + sometimes GLB fetch).

#### Frame processing

* `POST /api/upscale/frame`

  * Accepts uploaded image; returns `{ url }` to processed image.
* `POST /api/enhance/frame`

  * Accepts uploaded image + prompt/model; returns `{ url }`.

#### FFMPEG ops

* `POST /api/ffmpeg/concat`

  * Accepts JSON `{ urls: [video_url...] }` → returns `{ url }`.
* `POST /api/ffmpeg/audio`

  * Accepts `video_url`, audio file, `mode=replace|mix` → returns `{ url }`.

#### Tripo (image→3D)

* `POST /api/tripo/start`

  * Accepts image and Tripo parameters (model_version, texture_quality, orientation, auto_size, compress, etc.)
  * Returns `{ task_id }`.
* `GET /api/tripo/status/<task_id>`

  * Returns `{ status, progress, output: { pbr_model, base_model, model, rendered_image, ... } }`.
* `GET /api/tripo/download/<task_id>?url=<remote_glb_url>`

  * Server downloads the remote GLB and saves a **real file on disk**, returns `{ local_url }` or directly returns a local path/url.
* `GET /api/tripo/options`

  * Returns enums + defaults to populate UI (model_version list, etc.)

---

### 5) 3D preview pipeline (what must happen for Tripo models to load)

#### The reality of Tripo GLB URLs

* Tripo output URLs are usually signed CDN links.
* Direct fetch from browser often fails due to **CORS**.
* Therefore models must be loaded either via:

  * same-origin proxy (`/api/video_proxy?url=...`) **or**
  * a dedicated download endpoint (`/api/tripo/download/...`) that produces a local URL.

#### Compression formats encountered

* **DRACO** compressed meshes:

  * GLTFLoader requires `DRACOLoader` set.
  * Decoder path must exist and not 404.
* **Meshopt** compressed meshes (often named `*_meshopt.glb`):

  * GLTFLoader requires `setMeshoptDecoder()` called **before** `loader.load()`.
  * If not, error: `setMeshoptDecoder must be called before`.

#### WebGL lifecycle gotchas

These errors were seen and usually mean the canvas/context is not valid:

* `Cannot read properties of null (reading 'precision')`
* `Cannot read properties of null (reading 'alpha')`
  Common causes:
* Canvas size is 0/hidden when renderer is created.
* Overlay is opened/closed causing context loss.
* Canvas node was replaced, but controls/renderer still bound to an old canvas reference.

#### “Multiple instances of Three.js being imported”

* Happens when Three is loaded from **two sources** (import map + CDN dynamic import, or multiple module paths).
* This can break loaders/decoders because types/classes come from different module instances.

---

### 6) Job + frame model (how data ties together)

* Each job:

  * `request_id` (primary key)
  * `status` + `url`
  * `prompt`
  * `frames[]`: metadata list containing:

    * `idb_key`, `width`, `height`, `time`, `createdAt`
* Actual frame pixels:

  * Stored in IndexedDB frames store under `idb_key`.
* Frame capture flow:

  * capture from `<video>` into canvas → PNG blob
  * set as active input
  * optionally saved into job frames list + IDB blob

---

### 7) Controls / shortcuts (as implemented)

* 3D button supports modifier behavior:

  * One path to start Tripo generation
  * One path to pick local GLB (test viewer without spending credits)
  * One path to reopen last cached model
* Modifier-key UX matters on Mac trackpad:

  * Avoid relying on right-click instructions.

---

### 8) Known issues / quirks (important)

* 3D viewer can work for:

  * local GLB
  * some downloaded Tripo GLB
* But fail for:

  * Tripo GLBs loaded via direct remote URL (CORS)
  * meshopt GLB if meshopt decoder not set in correct order
  * draco GLB if decoder path missing or 404
  * cases where overlay/canvas context is invalid (precision/alpha null)
* Models “not saved” perception:

  * Even if saved to IndexedDB models DB, there’s usually no UI listing them.
  * Server disk save exists only if `/api/tripo/download/...` is used.
* Long “3D Starting…” delay:

  * backend call latency + Tripo queueing; UI may look frozen if no immediate progress update.

---

### 9) What “best results” settings mean (practical defaults)

* Model version:

  * `v3.1-20260211` is newer and typically preferred if credits allow.
* Quality knobs:

  * `texture_quality`: `detailed` for better textures (bigger files).
  * `texture_alignment`: `original_image` for fidelity, `geometry` for structure.
  * `geometry_quality`: `detailed` when available (v3+).
* Practical production defaults:

  * `pbr=true`, `texture=true`
  * `compress=true` only if the viewer pipeline reliably supports meshopt
  * `enable_image_autofix=true` when source images are messy (slower)

---

### 10) Production risks to watch

* Any change around `boot()` has wide blast radius (wires most UI).
* Any change around 3D loader must keep:

  * single Three instance
  * correct decoder order (meshopt before load; draco set before load)
  * stable canvas lifecycle (avoid context loss)
* If storing lots of models client-side:

  * IndexedDB storage can grow quickly (hundreds of MB+)
  * Browser storage eviction risk on some systems
  * Disk save on backend is the reliable archival route.

---

### 11) Recommended next hardening tasks

* Add a **Models library UI**:

  * list saved models (IndexedDB + disk)
  * reopen/delete/download
* Enforce **single Three import strategy**:

  * either importmap + static imports OR dynamic imports only (not both)
* Make Tripo load always go through:

  * `/api/tripo/download` → local file URL → GLTFLoader
* Add explicit meshopt/draco capability flags:

  * If meshopt decoder not available, disable `compress` in UI.
* Improve 3D overlay stability:

  * ensure overlay visible + canvas sized before renderer init
  * ensure proper dispose on close, and no stale canvas references.

If a “handover file” format is wanted (Markdown doc ready to paste into repo), confirm the filename preference (e.g., `HANDOVER.md`) and it will be formatted accordingly.

### Current state (what works)

* **Video pipeline** (generate → poll → shelf → player) is intact: jobs persist in `localStorage` (`grok_video_jobs_v4`), shelf order persists (`grok_video_order_v1`), frames persist in **IndexedDB** (`grok_frames_db_v1`).
* **3D overlay exists** and can render:

  * **Local `.glb`** picked from disk (your “GLB button” flow).
  * **Tripo-generated `.glb`** *if* it’s reachable (via proxy/download route) and the loader has the correct decoders.

---

### 3D viewer quirks + failure modes seen

* **Remote Tripo URLs are CORS-blocked** when loaded directly by Three.js (`No Access-Control-Allow-Origin`).

  * Your fix that works: **server-side download/proxy** (`/api/video_proxy` or `/api/tripo/download/...`) then load from local server.
* **Some Tripo outputs are meshopt-compressed** (`*_meshopt.glb`).

  * If `GLTFLoader.setMeshoptDecoder()` is not called **before** `loader.load()`, you get:
    `THREE.GLTFLoader: setMeshoptDecoder must be called before`
* **Draco-compressed models** need a working Draco decoder path:

  * You previously hit `.../vendor/three/examples/jsm/libs/draco/draco_wasm_wrapper.js 404`
  * Working approach: use Google hosted Draco decoder path (gstatic), or ship the Draco decoder files in `/vendor/...` correctly.
* **“Multiple instances of Three.js being imported” warning** appears when Three is loaded from more than one source (CDN + local vendor, or import-map + dynamic import mix). It can produce subtle breakage, especially around loaders/decoders.
* **WebGL context errors** encountered:

  * `Cannot read properties of null (reading 'precision')`
  * `Cannot read properties of null (reading 'alpha')`
    These usually happen when the renderer’s WebGL context is **null/lost** or canvas sizing/layout is **not ready** when creating the renderer.
* **Overlay/canvas lifecycle is fragile**:

  * If the overlay is opened/closed quickly, or canvas gets replaced, it can cause context loss.
  * You had cases where the same Tripo model **loaded after restart** or **when loaded from disk**, but failed in the live flow → that strongly points to timing/context/layout issues, not the file itself.
* **OrbitControls / scene framing regressions happened**:

  * Cube/test scene at one point was centered with helpers; later it rendered off to the corner / controls missing.
  * That’s usually from:

    * controls attached to wrong canvas reference (canvas replaced but controls still attached to old one),
    * camera framing not recomputed after model bounds,
    * or accidental removal of helpers/target setup.

---

### App “behavior quirks” (UX / control flow)

* **3D button has modifier behavior** (you were using this to test without spending money):

  * One modifier path opens the **local GLB picker** / test flow.
  * Another modifier path reopens **last cached model**.
  * This is error-prone on Mac trackpad because you don’t have “right click” assumptions; modifier keys are the only reliable input.
* **Model version UI not populating** at times:

  * If `/api/tripo/options` isn’t implemented or returns empty/incorrect `enums`, your “Model version” select stays blank.
  * When that happens, backend defaults apply (unless you hardcode on server like you did).

---

### Storage reality (where files actually end up)

* **Frames**: IndexedDB blobs (`grok_frames_db_v1`), referenced by job `frames[]`.
* **Models (client-side)**: IndexedDB blobs (`grok_models_db_v1`) *but* there’s currently **no UI list** to browse them, so it “looks like nothing is saved” even if it is.
* **Models (server-side disk)**: your `/api/tripo/download/...` route is the only thing that produces a **real `.glb` file on disk**.

  * This is confirmed by your logs: “ok saved glb model” and you could open it in macOS Preview.

---

### Biggest “watch out” issues to be aware of

* **Do not mix import-map `three` imports with dynamic imports from CDN**. Pick one source, otherwise you’ll keep seeing “multiple instances” and random loader failures.
* **Meshopt + Draco must be set before `loader.load()`** every time.
* **Canvas must have real size and be visible** before creating renderer, otherwise WebGL can be null and you get the `precision/alpha` null errors.
* **Loading Tripo models must go through your backend** (proxy/download) or you’ll keep hitting CORS.
* **No model library UI** exists yet for models saved in IndexedDB, so you can’t see/manage them unless you add a list view.

If a “models library” is wanted (list saved `.glb` in IndexedDB + reopen/delete + “download as file”), say so and the exact set of functions can be delivered as complete blocks.

# x-gen
Using Grok to play with video/image AI gen

# AIgen Web App — Overview

This project is a single-page web app for generating AI videos from a text prompt (optionally using an input image), tracking generation jobs, previewing/playback of results, and performing lightweight post-processing workflows like selecting/capturing frames and basic media operations (concat videos, replace/mix audio, upscale/enhance frames).   

---

## What the user can do

### 1) Generate a video from a prompt (and optional image)

* Enter a **Prompt**.
* Choose **Duration**, **Aspect ratio**, and **Resolution**.
* Optionally provide an **Image** as input. 
* Click **Generate** to start a new generation job.  

Backend behavior:

* `POST /api/start` sends the prompt/settings (and optional image as data-uri) to the xAI video generation client.  
* Progress is checked via `GET /api/status/<request_id>` until the job is `done` and returns a video URL. 

---

### 2) View job history + select videos

The app stores job entries (request_id, status, url, etc.) and lets you:

* Open a **History** drawer/list.
* Select a job to view status and, once complete, load the video player. 
* Maintain a **Videos shelf** of generated/processed videos, including selecting multiple videos for batch operations.  

---

### 3) Play generated videos through the built-in player

* When a job has a URL, the app displays a `<video>` player and plays the output. 

To avoid cross-origin issues (especially for frame capture and playback), the server provides:

* `GET /api/video_proxy?url=...` to proxy a remote video URL and forward range headers/content headers for streaming. 

---

### 4) Capture and manage “Frames” (still images)

In the **Frame** panel, users can:

* **Capture** a frame from the currently loaded video.
* **Upscale**, **Enhance**, **Download**, or **Clear** the currently captured frame. 

There is also a **Saved frames (selected job)** section that shows frame history tied to the currently selected job. 

---

### 5) Preview + crop a frame inside a fullscreen overlay

Clicking the frame preview opens a fullscreen overlay showing the image. 

Overlay behaviors:

* Drag to draw a crop selection box.
* `Esc` clears the selection or closes the overlay.
* `Enter` is designed to confirm the crop and push it back to the “captured frame” state. 
* The overlay UI includes a shaded mask + crop rectangle. 

---

### 6) Restyle workflow (turn an output image into the active input)

The app includes a **Restyle** action that fetches an output image URL, converts it to a blob, and stores it as the active `capturedFrame` so it can be used as the next generation input image. 

---

### 7) Join videos (concat) + audio operations

The app supports basic post-processing on selected videos:

**Join selected (concat)**

* UI: “Join selected” button under Videos. 
* Backend: `POST /api/ffmpeg/concat` downloads the selected video URLs and concatenates them using ffmpeg concat demuxer, outputting a new mp4 URL. 

**Replace / Mix audio**

* UI: audio file input + “Replace audio” / “Mix audio”. 
* Backend: `POST /api/ffmpeg/audio` downloads the selected video URL and either:

  * replaces the audio track, or
  * mixes original audio with uploaded audio using `amix`. 

---

## High-level architecture

### Frontend (SPA)

* **`index.html`** contains the full UI layout: settings panels, Frame controls, job history sections, player, status/result panel, and video shelf.  
* **`app.js`** bootstraps the app state, wires UI handlers, calls backend APIs, maintains job history and selected video IDs, and manages frame capture + overlay crop interactions.  
* **`styles.css`** provides the layout and all major UI styling, including the fullscreen overlay and crop box/shade.  

### Backend (Flask)

* Serves SPA routes:

  * `GET /`, `GET /app`, `GET /app/<path>` render the same `index.html`. 
* Provides API endpoints:

  * `POST /api/start` → start xAI video generation. 
  * `GET /api/status/<request_id>` → poll job status/result URL. 
  * `GET /api/video_proxy` → stream/proxy remote videos for same-origin usage. 
  * `GET /api/output/<name>` → serve generated local outputs from `outputs/`. 
  * `POST /api/ffmpeg/concat` → join multiple video URLs. 
  * `POST /api/ffmpeg/audio` → replace or mix audio. 
  * `POST /api/upscale/frame` → upscale an uploaded frame using an external script configured by env vars.  
  * `POST /api/enhance/frame` → enhance an uploaded frame via an image model prompt (quality-only enhancement). 

---

## Key UI areas (mental model)

* **Left column**

  * “Settings” (duration/aspect/resolution + optional image upload) 
  * “Frame” tools + frame preview/meta 
  * Saved frames list for the selected job 
  * Prompt box + Generate/Restyle/Clear actions 

* **Right column**

  * Video player for generated outputs 
  * Status panel (“Idle.” / job updates / errors) 

* **Bottom full-width**

  * Video shelf cards + join and audio tools  

---

## Notes on “Frame → Overlay crop → Enter confirms”

The overlay’s event handlers explicitly support:

* drag-selection and aspect ratio locking
* `Enter` to confirm via `finalizeCropToCaptured()` (if implemented) 

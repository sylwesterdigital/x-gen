import os
import base64
import mimetypes
import logging
import traceback
import uuid
import tempfile
import subprocess
from datetime import datetime
from urllib.parse import urlparse

from flask import Flask, request, jsonify, render_template, Response, send_from_directory
import requests
import xai_sdk
from xai_sdk.proto import deferred_pb2



app = Flask(__name__, static_folder="static", template_folder="templates")

# ---- Logging (better than default) ----
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("grok-ui")

from werkzeug.exceptions import HTTPException

@app.errorhandler(Exception)
def handle_any_exception(e):
    if isinstance(e, HTTPException):
        return e

    req_id = getattr(request, "req_id", "n/a")
    log.error("Unhandled exception req_id=%s\n%s", req_id, traceback.format_exc())
    return jsonify(
        error=str(e),
        req_id=req_id,
    ), 500

@app.before_request
def attach_request_id():
    request.req_id = request.headers.get("X-Request-ID", str(uuid.uuid4()))

@app.after_request
def add_request_id_header(resp):
    resp.headers["X-Request-ID"] = getattr(request, "req_id", "")
    return resp

@app.errorhandler(Exception)
def handle_any_exception(e):
    req_id = getattr(request, "req_id", "n/a")
    log.error("Unhandled exception req_id=%s\n%s", req_id, traceback.format_exc())
    return jsonify(error=str(e), req_id=req_id), 500

XAI_API_KEY = os.getenv("XAI_API_KEY")
if not XAI_API_KEY:
    raise RuntimeError("Missing XAI_API_KEY environment variable.")

client = xai_sdk.Client()
MODEL_DEFAULT = "grok-imagine-video"

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "outputs")
os.makedirs(OUTPUT_DIR, exist_ok=True)

def file_to_data_uri(file_storage) -> str:
    content = file_storage.read()
    file_storage.seek(0)

    mime = file_storage.mimetype
    if not mime or mime == "application/octet-stream":
        guessed, _ = mimetypes.guess_type(file_storage.filename or "")
        mime = guessed or "image/png"

    b64 = base64.b64encode(content).decode("utf-8")
    return f"data:{mime};base64,{b64}"

def _safe_http_url(src: str) -> str:
    parsed = urlparse(src)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("Invalid url")
    return src

def _download_to_file(url: str, dst_path: str):
    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        with open(dst_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 256):
                if chunk:
                    f.write(chunk)

def _ffmpeg_run(args):
    p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip() or "ffmpeg failed")
    return p

def _run_upscale_script(input_path: str, model: int, tilesize: int, tta: bool, cpu: bool) -> str:
    script = os.getenv("UPSCALE_SCRIPT")
    py = os.getenv("UPSCALE_PYTHON")

    if not script or not py:
        raise RuntimeError("Missing UPSCALE_SCRIPT and/or UPSCALE_PYTHON env vars.")

    args = [py, script, input_path, "--model", str(model), "--tilesize", str(tilesize)]
    if tta:
        args.append("--tta")
    if cpu:
        args.append("--cpu")

    p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout or "upscale failed").strip())

    lines = [ln.strip() for ln in (p.stdout or "").splitlines() if ln.strip()]
    if not lines:
        raise RuntimeError("upscale returned no output path")
    return lines[-1]    

def _output_name(prefix: str, ext: str = "mp4") -> str:
    ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    return f"{prefix}_{ts}.{ext}"

# ---- SPA routes ----
@app.get("/")
def spa_root():
    return render_template("index.html")

@app.get("/app")
@app.get("/app/<path:any_path>")
def spa_any(any_path=None):
    return render_template("index.html")


# ---- API: xAI ----
@app.post("/api/start")
def api_start():
    req_id = request.req_id

    prompt = (request.form.get("prompt") or "").strip()
    if not prompt:
        return jsonify(error="Missing prompt", req_id=req_id), 400

    model = (request.form.get("model") or MODEL_DEFAULT).strip() or MODEL_DEFAULT

    try:
        duration = int(request.form.get("duration", "8"))
    except ValueError:
        duration = 8

    aspect_ratio = request.form.get("aspect_ratio", "16:9")
    resolution = request.form.get("resolution", "480p")

    image = request.files.get("image")

    kwargs = dict(
        prompt=prompt,
        model=model,
        duration=duration,
        aspect_ratio=aspect_ratio,
        resolution=resolution,
    )

    if image and image.filename:
        kwargs["image_url"] = file_to_data_uri(image)

    active_id = (request.headers.get("X-Active-Request-Id") or "").strip()
    if active_id:
        try:
            st = client.video.get(active_id)
            if st.status == deferred_pb2.DeferredStatus.PENDING:
                retry_after = 45
                resp = jsonify(
                    error="A generation is already running. Wait for it to finish or expire.",
                    active_request_id=active_id,
                    retry_after=retry_after,
                    req_id=req_id,
                )
                resp.status_code = 429
                resp.headers["Retry-After"] = str(retry_after)
                return resp
        except Exception:
            pass

    log.info(
        "Start req_id=%s model=%s duration=%s aspect=%s res=%s has_image=%s",
        req_id, model, duration, aspect_ratio, resolution, bool(image and image.filename)
    )

    try:
        start_resp = client.video.start(**kwargs)
        return jsonify(request_id=start_resp.request_id, req_id=req_id)
    except Exception as e:
        msg = str(e)
        if "RESOURCE_EXHAUSTED" in msg or "Too many concurrent requests" in msg:
            retry_after = 90
            resp = jsonify(
                error="Too many concurrent requests (rate-limited).",
                retry_after=retry_after,
                req_id=req_id,
            )
            resp.status_code = 429
            resp.headers["Retry-After"] = str(retry_after)
            return resp
        raise

@app.get("/favicon.ico")
def favicon_ico():
    return ("", 204)        

@app.get("/api/status/<request_id>")
def api_status(request_id: str):
    req_id = request.req_id
    result = client.video.get(request_id)

    if result.status == deferred_pb2.DeferredStatus.PENDING:
        return jsonify(status="pending", message="Still processing...", req_id=req_id)

    if result.status == deferred_pb2.DeferredStatus.EXPIRED:
        return jsonify(status="expired", req_id=req_id)

    if result.status == deferred_pb2.DeferredStatus.DONE:
        resp = result.response
        video = getattr(resp, "video", None)
        url = getattr(video, "url", None) if video else None

        return jsonify(
            status="done",
            url=url,
            duration=getattr(video, "duration", None) if video else None,
            model=getattr(resp, "model", None),
            respect_moderation=getattr(video, "respect_moderation", None) if video else None,
            req_id=req_id,
        )

    return jsonify(status="unknown", req_id=req_id)

# ---- API: proxy for same-origin playback/capture ----
@app.get("/api/video_proxy")
def api_video_proxy():
    src = (request.args.get("url") or "").strip()
    if not src:
        return jsonify(error="Missing url", req_id=request.req_id), 400

    try:
        _safe_http_url(src)
    except ValueError:
        return jsonify(error="Invalid url", req_id=request.req_id), 400

    headers = {}
    rng = request.headers.get("Range")
    if rng:
        headers["Range"] = rng

    upstream = requests.get(src, headers=headers, stream=True, timeout=30)

    passthrough_headers = {}
    for k in ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"):
        v = upstream.headers.get(k)
        if v:
            passthrough_headers[k] = v

    return Response(
        upstream.iter_content(chunk_size=1024 * 256),
        status=upstream.status_code,
        headers=passthrough_headers,
    )

# ---- API: serve outputs ----
@app.get("/api/output/<path:name>")
def api_output(name: str):
    return send_from_directory(OUTPUT_DIR, name, as_attachment=False)

# ---- API: ffmpeg concat ----
@app.post("/api/ffmpeg/concat")
def api_ffmpeg_concat():
    req_id = request.req_id
    data = request.get_json(silent=True) or {}
    urls = data.get("urls") or []
    if not isinstance(urls, list) or len(urls) < 2:
        return jsonify(error="Provide urls[] with at least 2 items", req_id=req_id), 400

    try:
        urls = [_safe_http_url(str(u)) for u in urls]
    except ValueError:
        return jsonify(error="Invalid url in list", req_id=req_id), 400

    out_name = _output_name("concat", "mp4")
    out_path = os.path.join(OUTPUT_DIR, out_name)

    with tempfile.TemporaryDirectory() as td:
        inputs = []
        for i, u in enumerate(urls):
            p = os.path.join(td, f"in_{i}.mp4")
            _download_to_file(u, p)
            inputs.append(p)

        list_path = os.path.join(td, "list.txt")
        with open(list_path, "w", encoding="utf-8") as f:
            for p in inputs:
                safe_p = p.replace("'", "'\\''")
                f.write(f"file '{safe_p}'\n")
        try:
            _ffmpeg_run([
                "ffmpeg", "-y",
                "-f", "concat", "-safe", "0",
                "-i", list_path,
                "-c", "copy",
                out_path
            ])
        except RuntimeError as e:
            return jsonify(error=str(e), req_id=req_id), 500

    return jsonify(
        url=f"/api/output/{out_name}",
        output_id=f"concat_{out_name}",
        req_id=req_id,
    )

# ---- API: ffmpeg audio replace/mix ----
@app.post("/api/ffmpeg/audio")
def api_ffmpeg_audio():
    req_id = request.req_id

    video_url = (request.form.get("video_url") or "").strip()
    mode = (request.form.get("mode") or "").strip().lower()
    audio = request.files.get("audio")

    if not video_url:
        return jsonify(error="Missing video_url", req_id=req_id), 400
    if mode not in ("replace", "mix"):
        return jsonify(error="mode must be replace|mix", req_id=req_id), 400
    if not audio or not audio.filename:
        return jsonify(error="Missing audio file", req_id=req_id), 400

    try:
        video_url = _safe_http_url(video_url)
    except ValueError:
        return jsonify(error="Invalid video_url", req_id=req_id), 400

    out_name = _output_name(f"audio_{mode}", "mp4")
    out_path = os.path.join(OUTPUT_DIR, out_name)

    with tempfile.TemporaryDirectory() as td:
        in_vid = os.path.join(td, "in.mp4")
        in_aud = os.path.join(td, "in_audio")
        _download_to_file(video_url, in_vid)

        audio.save(in_aud)

        try:
            if mode == "replace":
                _ffmpeg_run([
                    "ffmpeg", "-y",
                    "-i", in_vid,
                    "-i", in_aud,
                    "-map", "0:v:0",
                    "-map", "1:a:0",
                    "-c:v", "copy",
                    "-c:a", "aac",
                    "-shortest",
                    out_path
                ])
            else:
                _ffmpeg_run([
                    "ffmpeg", "-y",
                    "-i", in_vid,
                    "-i", in_aud,
                    "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[a]",
                    "-map", "0:v:0",
                    "-map", "[a]",
                    "-c:v", "copy",
                    "-c:a", "aac",
                    "-shortest",
                    out_path
                ])
        except RuntimeError as e:
            return jsonify(error=str(e), req_id=req_id), 500

    return jsonify(
        url=f"/api/output/{out_name}",
        output_id=f"audio_{mode}_{out_name}",
        req_id=req_id,
    )




@app.post("/api/enhance/frame")
def api_enhance_frame():
    req_id = request.req_id

    image = request.files.get("image")
    if not image or not image.filename:
        return jsonify(error="Missing image", req_id=req_id), 400

    ui_prompt = (request.form.get("prompt") or "").strip()
    model = (request.form.get("model") or "grok-imagine-image").strip() or "grok-imagine-image"

    try:
        raw = image.read()
        image.seek(0)
    except Exception:
        return jsonify(error="Failed to read image", req_id=req_id), 400

    if not raw:
        return jsonify(error="Empty image upload (0 bytes)", req_id=req_id), 400

    import hashlib
    sha = hashlib.sha256(raw).hexdigest()
    mime = image.mimetype or "image/png"

    # Keep under gRPC message limits. Base64 expands ~33%, so cap raw bytes.
    max_raw = 2_800_000
    if len(raw) > max_raw:
        return jsonify(
            error="Image too large for enhance request (downscale; enhance before heavy upscale).",
            input_bytes=len(raw),
            input_sha256=sha,
            req_id=req_id,
        ), 400

    data_uri = f"data:{mime};base64,{base64.b64encode(raw).decode('utf-8')}"

    base_prompt = (
        "Enhance the provided image ONLY.\n"
        "Preserve the original content exactly: same subject, identity, pose, clothing, background, camera, framing.\n"
        "Do not add/remove objects or text. Do not change the scene.\n"
        "Only improve quality: reduce compression/blocking, mild denoise, restore detail, micro-contrast, sharpen (no halos), keep colors faithful.\n"
        "Optional subtle natural film grain.\n"
    )
    prompt = base_prompt + (("\nUser intent:\n" + ui_prompt) if ui_prompt else "")

    log.info(
        "Enhance start req_id=%s model=%s bytes=%s sha256=%s mime=%s",
        req_id, model, len(raw), sha, mime
    )

    try:
        resp = client.image.sample(
            prompt=prompt,
            model=model,
            image_url=data_uri,
        )
    except Exception as e:
        msg = str(e)
        if "RESOURCE_EXHAUSTED" in msg or "Too many concurrent requests" in msg:
            retry_after = 90
            r = jsonify(
                error="Too many concurrent requests (rate-limited).",
                retry_after=retry_after,
                input_bytes=len(raw),
                input_sha256=sha,
                req_id=req_id,
            )
            r.status_code = 429
            r.headers["Retry-After"] = str(retry_after)
            return r
        return jsonify(
            error=f"Enhance failed: {msg}",
            input_bytes=len(raw),
            input_sha256=sha,
            req_id=req_id,
        ), 500

    remote_url = getattr(resp, "url", None)
    respect_moderation = getattr(resp, "respect_moderation", None)
    used_model = getattr(resp, "model", None)

    if respect_moderation is False:
        return jsonify(
            error="Filtered by moderation.",
            input_bytes=len(raw),
            input_sha256=sha,
            req_id=req_id,
        ), 400

    if not remote_url:
        return jsonify(
            error="Enhance failed (no url returned).",
            input_bytes=len(raw),
            input_sha256=sha,
            req_id=req_id,
        ), 500

    out_name = _output_name("enhance", "png")
    out_path = os.path.join(OUTPUT_DIR, out_name)

    try:
        _download_to_file(remote_url, out_path)
    except Exception as e:
        return jsonify(
            error=f"Enhance download failed: {e}",
            input_bytes=len(raw),
            input_sha256=sha,
            req_id=req_id,
        ), 500

    log.info("Enhance done req_id=%s out=%s", req_id, out_name)

    return jsonify(
        url=f"/api/output/{out_name}",
        remote_url=remote_url,
        model=used_model or model,
        respect_moderation=respect_moderation,
        input_bytes=len(raw),
        input_sha256=sha,
        req_id=req_id,
    )


@app.post("/api/upscale/frame")
def api_upscale_frame():
    req_id = request.req_id

    image = request.files.get("image")
    if not image or not image.filename:
        return jsonify(error="Missing image", req_id=req_id), 400

    try:
        model = int(request.form.get("model", "4"))
    except ValueError:
        model = 4

    try:
        tilesize = int(request.form.get("tilesize", "0"))
    except ValueError:
        tilesize = 0

    tta = (request.form.get("tta") or "").strip().lower() in ("1", "true", "yes", "on")
    cpu = (request.form.get("cpu") or "").strip().lower() in ("1", "true", "yes", "on")

    with tempfile.TemporaryDirectory() as td:
        in_path = os.path.join(td, "frame.png")
        image.save(in_path)

        try:
            out_path = _run_upscale_script(in_path, model=model, tilesize=tilesize, tta=tta, cpu=cpu)
        except Exception as e:
            return jsonify(error=str(e), req_id=req_id), 500

        out_name = _output_name("upscale", "png")
        final_path = os.path.join(OUTPUT_DIR, out_name)

        try:
            os.replace(out_path, final_path)
        except Exception:
            try:
                with open(out_path, "rb") as src, open(final_path, "wb") as dst:
                    dst.write(src.read())
            except Exception as e:
                return jsonify(error=f"Failed to store output: {e}", req_id=req_id), 500

    return jsonify(
        url=f"/api/output/{out_name}",
        output_id=f"upscale_{out_name}",
        req_id=req_id,
    )



if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
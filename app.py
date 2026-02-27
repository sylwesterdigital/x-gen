import os
import base64
import mimetypes
import logging
import traceback
import uuid

from flask import Flask, request, jsonify, render_template
import xai_sdk
from xai_sdk.proto import deferred_pb2

app = Flask(__name__, static_folder="static", template_folder="templates")

# ---- Logging (better than default) ----
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("grok-ui")

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
    return jsonify(
        error=str(e),
        req_id=req_id,
    ), 500


XAI_API_KEY = os.getenv("XAI_API_KEY")
if not XAI_API_KEY:
    raise RuntimeError("Missing XAI_API_KEY environment variable.")

client = xai_sdk.Client()
MODEL_DEFAULT = "grok-imagine-video"


def file_to_data_uri(file_storage) -> str:
    content = file_storage.read()
    file_storage.seek(0)

    mime = file_storage.mimetype
    if not mime or mime == "application/octet-stream":
        guessed, _ = mimetypes.guess_type(file_storage.filename or "")
        mime = guessed or "image/png"

    b64 = base64.b64encode(content).decode("utf-8")
    return f"data:{mime};base64,{b64}"


# ---- SPA routes ----
@app.get("/")
def spa_root():
    return render_template("index.html")

@app.get("/app")
@app.get("/app/<path:any_path>")
def spa_any(any_path=None):
    return render_template("index.html")


# ---- API ----
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

    # One active generation at a time per browser (best-effort server guard).
    active_id = (request.headers.get("X-Active-Request-Id") or "").strip()
    if active_id:
        try:
            st = client.video.get(active_id)
            if st.status == deferred_pb2.DeferredStatus.PENDING:
                return jsonify(
                    error="A generation is already running. Wait for it to finish or expire.",
                    active_request_id=active_id,
                    req_id=req_id,
                ), 429
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
            return jsonify(
                error="Too many concurrent requests (rate-limited). Wait ~30–120s and try again.",
                req_id=req_id,
            ), 429

        raise


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


@app.get("/api/video_proxy")
def api_video_proxy():
    import requests
    from urllib.parse import urlparse
    from flask import Response

    src = (request.args.get("url") or "").strip()
    if not src:
        return jsonify(error="Missing url", req_id=request.req_id), 400

    parsed = urlparse(src)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
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


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
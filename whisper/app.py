#!/usr/bin/env python3
"""
UmmahCast transcription sidecar.

Receives a job from the app (POST /transcribe), reads the recording from the
read-only recordings volume, runs faster-whisper with task=translate (English
out for any source language), and POSTs the transcript back to the app's
internal callback. Stdlib HTTP only — no web framework — to keep the image and
attack surface minimal. The whole container has no internet egress (internal
Docker network); the model is baked into the image at build time.
"""
import os
import re
import gc
import json
import time
import hmac
import threading
import traceback
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_NAME = os.environ.get("WHISPER_MODEL", "medium")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
CPU_THREADS = int(os.environ.get("WHISPER_CPU_THREADS", "3"))
SECRET = os.environ.get("WHISPER_SHARED_SECRET", "")
CALLBACK_URL = os.environ.get("APP_CALLBACK_URL", "")
RECORDINGS_DIR = os.environ.get("RECORDINGS_DIR", "/recordings")
PORT = int(os.environ.get("PORT", "8000"))

# Bounds — reject hostile / runaway media before it can pin the box.
MAX_DURATION_SECONDS = int(os.environ.get("MAX_DURATION_SECONDS", "10800"))  # 3h
MAX_FILE_MB = int(os.environ.get("MAX_FILE_MB", "500"))
IDLE_UNLOAD_SEC = int(os.environ.get("IDLE_UNLOAD_SEC", "900"))  # release model after 15m idle
# Caps on what we store/return (defense against pathological transcripts).
MAX_TEXT_CHARS = 200_000
MAX_SEGMENTS = 5000

SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")

_model = None
_model_lock = threading.Lock()   # guards model load/unload
_job_lock = threading.Lock()     # single-job concurrency
_last_used = 0.0


def log(*a):
    print("[whisper]", *a, flush=True)


def get_model():
    global _model, _last_used
    with _model_lock:
        if _model is None:
            from faster_whisper import WhisperModel
            log(f"loading model {MODEL_NAME} ({COMPUTE_TYPE})")
            _model = WhisperModel(
                MODEL_NAME, device="cpu", compute_type=COMPUTE_TYPE, cpu_threads=CPU_THREADS
            )
            log("model loaded")
        _last_used = time.time()
        return _model


def idle_reaper():
    """Unload the model after a period of inactivity so the container idles cheap."""
    global _model
    while True:
        time.sleep(60)
        with _model_lock:
            if _model is not None and not _job_lock.locked() \
                    and (time.time() - _last_used) > IDLE_UNLOAD_SEC:
                _model = None
                gc.collect()
                log("model unloaded (idle)")


def secure_path(org_slug, filename):
    """Resolve <recordings>/<org>/<file> and confirm it stays inside the base dir."""
    if not SAFE_NAME.match(org_slug or "") or not SAFE_NAME.match(filename or ""):
        raise ValueError("invalid name")
    base = os.path.realpath(RECORDINGS_DIR)
    full = os.path.realpath(os.path.join(base, org_slug, filename))
    if full != base and not full.startswith(base + os.sep):
        raise ValueError("path traversal")
    if not full.lower().endswith(".webm"):
        raise ValueError("not a webm")
    if not os.path.isfile(full):
        raise ValueError("file not found")
    return full


def transcribe(path):
    model = get_model()
    segments, info = model.transcribe(path, task="translate", vad_filter=True)
    if info.duration and info.duration > MAX_DURATION_SECONDS:
        raise ValueError(f"audio too long: {info.duration:.0f}s > {MAX_DURATION_SECONDS}s")
    out = []
    text_len = 0
    for s in segments:
        t = (s.text or "").strip()
        out.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": t})
        text_len += len(t)
        if len(out) >= MAX_SEGMENTS or text_len >= MAX_TEXT_CHARS:
            log("truncating: hit size cap")
            break
    full_text = " ".join(x["text"] for x in out).strip()
    return full_text, out, info


def post_back(payload):
    if not CALLBACK_URL:
        log("no APP_CALLBACK_URL; cannot return result")
        return
    data = json.dumps(payload).encode()
    req = urllib.request.Request(CALLBACK_URL, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Whisper-Secret", SECRET)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            log("callback", r.status, "rec", payload.get("recordingId"))
    except Exception as e:  # noqa: BLE001
        log("callback failed:", e)


def run_job(org_slug, filename, recording_id):
    with _job_lock:
        try:
            path = secure_path(org_slug, filename)
            size = os.path.getsize(path)
            if size > MAX_FILE_MB * 1024 * 1024:
                raise ValueError(f"file too large: {size} bytes")
            t0 = time.time()
            full_text, segs, info = transcribe(path)
            log(f"done rec={recording_id} dur={getattr(info, 'duration', 0):.0f}s "
                f"segs={len(segs)} in {time.time() - t0:.0f}s")
            post_back({
                "recordingId": recording_id, "status": "done", "lang": "en",
                "fullText": full_text, "segments": segs,
            })
        except Exception as e:  # noqa: BLE001
            log(f"job failed rec={recording_id}: {e}")
            traceback.print_exc()
            post_back({"recordingId": recording_id, "status": "failed", "error": str(e)[:200]})


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):  # silence default access logging
        pass

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "model": MODEL_NAME, "loaded": _model is not None})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            self._send(404, {"error": "not found"})
            return
        provided = self.headers.get("X-Whisper-Secret", "")
        if not SECRET or not hmac.compare_digest(provided, SECRET):
            self._send(403, {"error": "forbidden"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            length = 0
        if length <= 0 or length > 16 * 1024:
            self._send(400, {"error": "bad body"})
            return
        try:
            body = json.loads(self.rfile.read(length))
        except Exception:  # noqa: BLE001
            self._send(400, {"error": "bad json"})
            return
        org_slug = str(body.get("orgSlug", ""))
        filename = str(body.get("filename", ""))
        recording_id = body.get("recordingId")
        if not isinstance(recording_id, int) or isinstance(recording_id, bool) \
                or not SAFE_NAME.match(org_slug) or not SAFE_NAME.match(filename):
            self._send(400, {"error": "bad params"})
            return
        if _job_lock.locked():
            self._send(429, {"error": "busy"})
            return
        threading.Thread(target=run_job, args=(org_slug, filename, recording_id),
                         daemon=True).start()
        self._send(202, {"accepted": True})


def main():
    if not SECRET:
        log("WARNING: WHISPER_SHARED_SECRET not set — all jobs will be refused")
    threading.Thread(target=idle_reaper, daemon=True).start()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log(f"listening on :{PORT} model={MODEL_NAME} compute={COMPUTE_TYPE} threads={CPU_THREADS}")
    srv.serve_forever()


if __name__ == "__main__":
    main()

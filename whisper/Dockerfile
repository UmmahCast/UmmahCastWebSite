# UmmahCast transcription sidecar — faster-whisper on CPU.
# Pinned base digest (matches the python:3.12-slim already on the host) for
# reproducible builds, consistent with the app image's digest pin.
FROM python:3.12-slim@sha256:d764629ce0ddd8c71fd371e9901efb324a95789d2315a47db7e4d27e78f1b0e9

# Non-root runtime user.
RUN addgroup --gid 1001 --system whisper \
    && adduser --uid 1001 --system --ingroup whisper whisper

ENV HF_HOME=/opt/models \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Pinned dep (1.2.1 is the version validated in the feasibility spike).
RUN pip install --no-cache-dir faster-whisper==1.2.1

# Bake the model into the image at build time so the runtime container needs no
# internet egress at all. compute_type int8 matches the runtime load.
ARG WHISPER_MODEL=medium
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8')" \
    && chown -R whisper:whisper /opt/models

# Model is now baked in — forbid any network/Hub lookups at runtime.
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

COPY app.py /app/app.py

USER whisper

ENV PORT=8000 \
    WHISPER_MODEL=medium \
    WHISPER_COMPUTE_TYPE=int8 \
    WHISPER_CPU_THREADS=3 \
    RECORDINGS_DIR=/recordings

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

CMD ["python", "/app/app.py"]

// Dispatch transcription jobs to the whisper sidecar. Fire-and-forget, mirroring
// transcode.js. The sidecar reads the recording from the shared (read-only)
// recordings volume and POSTs the transcript back to the app's internal port
// (see the /internal/transcripts listener in index.js). Idempotency — i.e. "don't
// re-transcribe a recording that already has a transcript" — is enforced by the
// caller checking the DB before dispatch; the Set here only guards against a
// double-dispatch race for the same recording in the same instant.
const config = require('./config');

const inFlight = new Set();

function requestTranscript(orgSlug, filename, recordingId) {
  if (!config.WHISPER_ENABLED || !config.WHISPER_SHARED_SECRET) return;
  if (inFlight.has(recordingId)) return;
  inFlight.add(recordingId);

  const url = config.WHISPER_URL.replace(/\/$/, '') + '/transcribe';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);

  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Whisper-Secret': config.WHISPER_SHARED_SECRET,
    },
    body: JSON.stringify({ orgSlug, filename, recordingId }),
    signal: ctrl.signal,
  })
    .then((r) => {
      if (r.status === 202) {
        console.log(`[transcript] dispatched rec=${recordingId} (${orgSlug}/${filename})`);
      } else {
        console.error(`[transcript] sidecar returned ${r.status} for rec=${recordingId}`);
      }
    })
    .catch((err) => {
      console.error(`[transcript] dispatch failed rec=${recordingId}: ${err.message}`);
    })
    .finally(() => {
      clearTimeout(timer);
      inFlight.delete(recordingId);
    });
}

module.exports = { requestTranscript };

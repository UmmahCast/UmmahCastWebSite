// Transcode WebM/Opus recordings to MP3 so the podcast RSS feed works in
// Apple Podcasts / Spotify / Overcast (which reject WebM). Uses the system
// ffmpeg binary installed in the Docker image.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Dedupe parallel requests for the same target file
const inFlight = new Map();

function mp3PathFor(webmPath) {
  return webmPath.replace(/\.webm$/i, '.mp3');
}

function transcodeToMp3(webmPath) {
  const mp3Path = mp3PathFor(webmPath);

  if (fs.existsSync(mp3Path)) return Promise.resolve(mp3Path);
  if (!fs.existsSync(webmPath)) return Promise.reject(new Error('source missing: ' + webmPath));
  if (inFlight.has(mp3Path)) return inFlight.get(mp3Path);

  // -y overwrite, -i input, libmp3lame at VBR quality 4 (~165 kbps avg)
  // -map_metadata -1 strips any embedded metadata for predictability
  const args = ['-y', '-i', webmPath, '-map_metadata', '-1', '-codec:a', 'libmp3lame', '-qscale:a', '4', mp3Path];

  const promise = new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => {
      inFlight.delete(mp3Path);
      reject(err);
    });
    proc.on('close', (code) => {
      inFlight.delete(mp3Path);
      if (code === 0) {
        console.log(`[transcode] ${path.basename(webmPath)} -> ${path.basename(mp3Path)}`);
        resolve(mp3Path);
      } else {
        console.error('[transcode] ffmpeg failed (code=' + code + '): ' + stderr.slice(-500));
        try { fs.unlinkSync(mp3Path); } catch {}
        reject(new Error('ffmpeg failed'));
      }
    });
  });

  inFlight.set(mp3Path, promise);
  return promise;
}

// Fire-and-forget version for use after recording finalization. Errors are
// logged but don't propagate — the WebM still exists, RSS will skip until MP3 lands.
function transcodeAsync(webmPath) {
  transcodeToMp3(webmPath).catch(err => {
    console.error('[transcode] background fail:', err.message);
  });
}

// One-time backfill: scan the recordings dir at startup, queue any webm
// without a matching mp3. Runs serially to avoid CPU thrash.
async function backfillMissingMp3s(recordingsDir) {
  if (!fs.existsSync(recordingsDir)) return;
  const queue = [];
  for (const orgSlug of fs.readdirSync(recordingsDir)) {
    if (orgSlug.startsWith('_') || orgSlug.startsWith('.')) continue;
    const orgDir = path.join(recordingsDir, orgSlug);
    let stat;
    try { stat = fs.statSync(orgDir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const f of fs.readdirSync(orgDir)) {
      if (!/\.webm$/i.test(f)) continue;
      const webm = path.join(orgDir, f);
      const mp3 = mp3PathFor(webm);
      if (!fs.existsSync(mp3)) queue.push(webm);
    }
  }
  if (queue.length === 0) return;
  console.log(`[transcode] backfill queue: ${queue.length} recording(s)`);
  for (const webm of queue) {
    try { await transcodeToMp3(webm); }
    catch (err) { console.error('[transcode] backfill skip:', path.basename(webm), err.message); }
  }
  console.log('[transcode] backfill complete');
}

module.exports = { transcodeToMp3, transcodeAsync, backfillMissingMp3s, mp3PathFor };

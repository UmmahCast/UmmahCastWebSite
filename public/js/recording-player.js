// UmmahCast Recording Player — custom UI on top of native <audio>
// Usage:
//   const el = RecordingPlayer.create({
//     id: 42, orgSlug: 'default', filename: 'main_2026-04-19.webm',
//     title: 'Friday Khutbah', durationSeconds: 1820,
//     roomSlug: 'main', autoplay: false, startSeconds: 0
//   });
//   container.appendChild(el);
(function () {
  const STORAGE_PREFIX = 'uc.rec.';
  const SKIP_SEC = 15;

  // Inline SVG icons
  const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  const PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>';
  const BACK = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.5 7v3.5L7 6l4.5-4.5V5C16.6 5 21 9.4 21 14.5S16.6 24 11.5 24 2 19.6 2 14.5h2c0 4.1 3.4 7.5 7.5 7.5S19 18.6 19 14.5 15.6 7 11.5 7zM7.6 14.4l-.4 1.5c.4.1.8.2 1.2.2.8 0 1.5-.3 2-.8.5-.5.7-1.1.7-1.9 0-.7-.2-1.3-.7-1.7-.4-.4-1-.7-1.7-.7-.3 0-.6.1-.9.2l.2-1.3h2.7v-1.5H7L6.5 13l1.4.2c.1-.1.3-.1.4-.2.2-.1.4-.1.6-.1.4 0 .7.1.9.3.2.2.4.5.4.9 0 .3-.1.6-.3.9-.2.2-.5.3-.9.3-.5 0-1-.1-1.4-.2z"/></svg>';
  const FWD = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.5 7v3.5L17 6l-4.5-4.5V5C7.4 5 3 9.4 3 14.5S7.4 24 12.5 24 22 19.6 22 14.5h-2c0 4.1-3.4 7.5-7.5 7.5S5 18.6 5 14.5 8.4 7 12.5 7zm3.4 7.4L15.5 16c.4.1.7.2 1.1.2.8 0 1.5-.3 2-.8.5-.5.8-1.1.8-1.9 0-.7-.2-1.3-.7-1.7-.5-.4-1-.7-1.7-.7-.3 0-.6.1-.9.2l.2-1.3h2.7v-1.5h-3.9L14.5 13l1.4.2c.1-.1.3-.1.4-.2.2-.1.4-.1.6-.1.4 0 .7.1.9.3.2.2.4.5.4.9 0 .3-.1.6-.3.9-.2.2-.5.3-.9.3-.5 0-1-.1-1.4-.2z"/></svg>';
  const SHARE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  }

  function escHtml(s) { const d = document.createElement('div'); d.textContent = String(s || ''); return d.innerHTML; }

  function toast(msg, kind) {
    if (window.Toast?.show) return window.Toast.show(msg, kind);
    if (window.toastShow) return window.toastShow(msg, kind);
    console.log('[player]', msg);
  }

  function create({ id, orgSlug, filename, title, durationSeconds, roomSlug, autoplay = false, startSeconds = 0, noShare = false, srcOverride = null }) {
    const wrap = document.createElement('div');
    wrap.className = 'rec-player';
    wrap.dataset.recordingId = id;

    const labelTitle = title || `Recording ${id}`;
    const totalLabel = durationSeconds ? fmtTime(durationSeconds) : '--:--';

    wrap.innerHTML = `
      <div class="rec-player-header" role="button" tabindex="0" aria-expanded="false">
        <div class="rec-player-title">${escHtml(labelTitle)}</div>
        <div class="rec-player-meta">${totalLabel}</div>
      </div>
      <div class="rec-player-body">
        <input type="range" class="rec-player-scrub" min="0" max="${durationSeconds || 100}" value="0" step="0.1" aria-label="Seek">
        <div class="rec-player-controls">
          <button type="button" class="rec-player-btn primary" data-act="play" aria-label="Play">${PLAY}</button>
          <button type="button" class="rec-player-btn" data-act="back" aria-label="Back ${SKIP_SEC}s">${BACK}</button>
          <button type="button" class="rec-player-btn" data-act="fwd" aria-label="Forward ${SKIP_SEC}s">${FWD}</button>
          <select class="rec-player-select" data-act="speed" aria-label="Playback speed">
            <option value="0.75">0.75×</option>
            <option value="1" selected>1×</option>
            <option value="1.25">1.25×</option>
            <option value="1.5">1.5×</option>
            <option value="2">2×</option>
          </select>
          <span class="rec-player-time"><span data-role="cur">0:00</span> / <span data-role="dur">${totalLabel}</span></span>
          ${noShare ? '' : `<button type="button" class="rec-player-btn" data-act="share" aria-label="Share at current time">${SHARE}</button>`}
        </div>
      </div>`;

    const audio = new Audio();
    audio.preload = 'metadata';
    audio.src = srcOverride || `/recordings/${encodeURIComponent(orgSlug)}/${encodeURIComponent(filename)}`;

    const header = wrap.querySelector('.rec-player-header');
    const scrub = wrap.querySelector('.rec-player-scrub');
    const playBtn = wrap.querySelector('[data-act="play"]');
    const backBtn = wrap.querySelector('[data-act="back"]');
    const fwdBtn = wrap.querySelector('[data-act="fwd"]');
    const speedSel = wrap.querySelector('[data-act="speed"]');
    const shareBtn = wrap.querySelector('[data-act="share"]');
    const curEl = wrap.querySelector('[data-role="cur"]');
    const durEl = wrap.querySelector('[data-role="dur"]');

    const storageKey = STORAGE_PREFIX + id + '.t';

    function expand() {
      wrap.classList.add('expanded');
      header.setAttribute('aria-expanded', 'true');
    }

    function collapse() {
      wrap.classList.remove('expanded');
      header.setAttribute('aria-expanded', 'false');
    }

    function togglePlay() {
      if (audio.paused) audio.play();
      else audio.pause();
    }

    header.addEventListener('click', () => {
      if (wrap.classList.contains('expanded')) {
        // Already expanded — collapse only if play is paused; otherwise leave expanded
        if (audio.paused) collapse();
      } else {
        expand();
      }
    });
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); header.click(); }
    });

    playBtn.addEventListener('click', () => {
      expand();
      togglePlay();
    });
    backBtn.addEventListener('click', () => { audio.currentTime = Math.max(0, audio.currentTime - SKIP_SEC); });
    fwdBtn.addEventListener('click', () => { audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + SKIP_SEC); });
    speedSel.addEventListener('change', () => { audio.playbackRate = parseFloat(speedSel.value) || 1; });

    if (shareBtn) {
      shareBtn.addEventListener('click', async () => {
        const t = Math.floor(audio.currentTime || 0);
        const url = `${window.location.origin}/${encodeURIComponent(orgSlug)}/listen?recording=${id}&t=${t}`;
        try {
          if (navigator.share) {
            await navigator.share({ title: labelTitle, text: `Listen to ${labelTitle} from ${t > 0 ? fmtTime(t) : 'the start'}`, url });
          } else {
            await navigator.clipboard.writeText(url);
            toast(`Link copied (at ${fmtTime(t)})`, 'success');
          }
        } catch {
          try { await navigator.clipboard.writeText(url); toast(`Link copied (at ${fmtTime(t)})`, 'success'); }
          catch { prompt('Copy this link:', url); }
        }
      });
    }

    let scrubbing = false;
    scrub.addEventListener('input', () => { scrubbing = true; curEl.textContent = fmtTime(parseFloat(scrub.value)); });
    scrub.addEventListener('change', () => { audio.currentTime = parseFloat(scrub.value); scrubbing = false; });

    audio.addEventListener('loadedmetadata', () => {
      const d = audio.duration || durationSeconds || 0;
      scrub.max = d;
      durEl.textContent = fmtTime(d);
      wrap.querySelector('.rec-player-meta').textContent = fmtTime(d);
      // Restore last position
      try {
        const startFromUrl = startSeconds > 0 ? startSeconds : null;
        const stored = parseFloat(localStorage.getItem(storageKey) || '0');
        const target = startFromUrl != null ? Math.min(startFromUrl, d - 1) : (stored > 5 && stored < d - 5 ? stored : 0);
        if (target > 0) audio.currentTime = target;
      } catch {}
      if (autoplay) audio.play().catch(() => {});
    });

    audio.addEventListener('timeupdate', () => {
      if (scrubbing) return;
      scrub.value = audio.currentTime;
      curEl.textContent = fmtTime(audio.currentTime);
      // Persist position (throttled by browser timeupdate frequency ~250ms)
      try { localStorage.setItem(storageKey, audio.currentTime.toFixed(1)); } catch {}
    });

    audio.addEventListener('play', () => {
      playBtn.innerHTML = PAUSE;
      playBtn.setAttribute('aria-label', 'Pause');
      // Media Session API for OS-level controls
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: labelTitle,
          artist: 'UmmahCast',
          album: roomSlug || '',
          artwork: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
        });
        navigator.mediaSession.setActionHandler('play', () => audio.play());
        navigator.mediaSession.setActionHandler('pause', () => audio.pause());
        navigator.mediaSession.setActionHandler('seekbackward', () => { audio.currentTime = Math.max(0, audio.currentTime - SKIP_SEC); });
        navigator.mediaSession.setActionHandler('seekforward', () => { audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + SKIP_SEC); });
      }
    });
    audio.addEventListener('pause', () => {
      playBtn.innerHTML = PLAY;
      playBtn.setAttribute('aria-label', 'Play');
    });
    audio.addEventListener('ended', () => {
      try { localStorage.removeItem(storageKey); } catch {}
    });
    audio.addEventListener('error', () => {
      toast('Could not load recording', 'error');
    });

    // Expose audio for external control (e.g. share-at-timestamp landing)
    wrap._audio = audio;
    wrap.expand = expand;
    return wrap;
  }

  // Convenience: build from API meta payload
  async function createFromMeta(id, opts = {}) {
    try {
      const res = await fetch(`/api/recordings/${id}/meta`);
      if (!res.ok) return null;
      const meta = await res.json();
      return create({
        id, orgSlug: meta.orgSlug, filename: meta.filename,
        title: meta.title || meta.roomName, durationSeconds: meta.durationSeconds,
        roomSlug: meta.roomSlug, autoplay: !!opts.autoplay, startSeconds: opts.startSeconds || 0,
      });
    } catch { return null; }
  }

  window.RecordingPlayer = { create, createFromMeta };
})();

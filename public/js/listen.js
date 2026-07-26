const params = new URLSearchParams(location.search);
const room = params.get('room') || 'main';
const pathParts = window.location.pathname.replace(/^\//, '').split('/');
const orgSlug = pathParts[0] || 'default';
window._orgSlug = orgSlug;

// ===== Share-at-timestamp: if ?recording=ID present, render focused recording view =====
const recordingIdParam = parseInt(params.get('recording'), 10);
const recordingStartT = parseInt(params.get('t'), 10) || 0;
if (Number.isInteger(recordingIdParam) && recordingIdParam > 0) {
  document.addEventListener('DOMContentLoaded', () => renderRecordingView(recordingIdParam, recordingStartT));
  // Also try immediately in case DOM already ready
  if (document.readyState !== 'loading') renderRecordingView(recordingIdParam, recordingStartT);
}

async function renderRecordingView(id, startT) {
  // Hide name screen + player screen, swap in a recording-focused container
  const nameScreen = document.getElementById('name-screen');
  const playerScreen = document.getElementById('player-screen');
  if (nameScreen) nameScreen.classList.add('hidden');
  if (playerScreen) playerScreen.classList.add('hidden');

  let recView = document.getElementById('recording-view');
  if (!recView) {
    recView = document.createElement('main');
    recView.id = 'recording-view';
    recView.className = 'container';
    recView.style.cssText = 'max-width:540px; width:100%;';
    recView.innerHTML = `
      <h2 id="rec-room-title" style="margin-bottom:0.25rem;">Recording</h2>
      <p id="rec-org" style="font-size:0.85rem; color:var(--text-muted); margin-bottom:1.25rem;"></p>
      <div id="rec-player-host"></div>
      <div style="margin-top:1.5rem; text-align:center;">
        <a id="rec-back" href="#" class="btn-secondary" style="display:inline-block; padding:0.5rem 1rem; font-size:0.85rem; text-decoration:none; border-radius:999px;">← Back to live</a>
      </div>`;
    document.body.appendChild(recView);
  }

  if (!window.RecordingPlayer) {
    document.getElementById('rec-player-host').innerHTML = '<div class="card"><div class="stream-msg">Player unavailable.</div></div>';
    return;
  }

  try {
    const res = await fetch(`/api/recordings/${id}/meta`);
    if (!res.ok) {
      document.getElementById('rec-player-host').innerHTML = `<div class="card"><div class="stream-msg">Recording not found.</div></div>`;
      return;
    }
    const meta = await res.json();
    document.getElementById('rec-room-title').textContent = meta.title || meta.roomName || 'Recording';
    document.getElementById('rec-org').textContent = meta.orgName || '';
    document.getElementById('rec-back').href = `/${encodeURIComponent(meta.orgSlug)}/listen?room=${encodeURIComponent(meta.roomSlug || 'main')}`;
    const player = window.RecordingPlayer.create({
      id: meta.id, orgSlug: meta.orgSlug, filename: meta.filename,
      title: meta.title || meta.roomName, durationSeconds: meta.durationSeconds,
      roomSlug: meta.roomSlug, autoplay: true, startSeconds: startT,
    });
    document.getElementById('rec-player-host').appendChild(player);
    player.expand();
    document.title = `${meta.title || meta.roomName} — UmmahCast`;
  } catch (err) {
    document.getElementById('rec-player-host').innerHTML = '<div class="card"><div class="stream-msg">Could not load recording.</div></div>';
  }
}

let ws;
let mediaSource;
let _mseUrl = null;        // object URL for mediaSource — tracked so we can revoke it (no leak)
let sourceBuffer;
let queue = [];
let _lastLiveToast = null; // 'live' | 'offline' — so the toast fires only on real transitions
let reconnectAttempts = 0;
let capAttempts = 0; // separate counter so a network blip doesn't inherit cap-backoff
const MAX_RECONNECT = 12;  // stop hammering after ~a few minutes of backoff (fatal/rejected close)
let displayName = '';
let roomPassword = '';

// Skip live setup if we're in recording-share mode
const _inRecordingMode = Number.isInteger(recordingIdParam) && recordingIdParam > 0;

// Resolved once we've determined whether the room is password-protected, so auto-resume
// can wait for the real signal instead of guessing a fixed delay.
let _resolvePreload;
const preloadReady = new Promise((r) => { _resolvePreload = r; });
let _roomHasPassword = null; // null = not yet known

// Pre-load room info
(async () => {
  if (_inRecordingMode) { _resolvePreload(); return; }
  let rooms = [];
  try { rooms = await (await fetch(`/api/orgs/${orgSlug}/rooms`)).json(); } catch {}
  const info = Array.isArray(rooms) ? rooms.find(r => r.slug === room) : null;
  if (info) {
    document.getElementById('room-title-prompt').textContent = info.name;
    // Nothing ever filled #room-name, so the niche's head rendered as an empty
    // heading. The name is right here in the room info we already fetched.
    document.getElementById('room-name').textContent = info.name;
    _roomHasPassword = !!info.hasPassword;
    if (info.hasPassword) document.getElementById('password-section').classList.remove('hidden');
  }
  _resolvePreload(); // password state determined (or attempted) — unblock auto-resume

  // Load schedule
  const scheds = await (await fetch(`/api/orgs/${orgSlug}/rooms/${room}/schedule`)).json();
  if (scheds.length > 0) {
    const card = document.getElementById('schedule-card');
    const list = document.getElementById('schedule-list');
    card.classList.remove('hidden');
    scheds.forEach(s => {
      const d = new Date(s.starts_at);
      const div = document.createElement('div');
      div.className = 'schedule-item';
      div.innerHTML = `<strong>${esc(s.title)}</strong><br>${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})} — ${s.duration_minutes}min`;
      list.appendChild(div);
    });
  }

  // Countdown for next scheduled show
  if (scheds.length > 0) {
    const next = scheds[0];
    const nextTime = new Date(next.starts_at).getTime();
    const countdownBanner = document.getElementById('countdown-banner');
    const countdownTitle = document.getElementById('countdown-title');
    const countdownTimer = document.getElementById('countdown-timer');

    function updateCountdown() {
      const diff = nextTime - Date.now();
      if (diff <= 0) {
        countdownTimer.textContent = 'Starting now!';
        return;
      }
      const days = Math.floor(diff / 86400000);
      const hours = Math.floor((diff % 86400000) / 3600000);
      const mins = Math.floor((diff % 3600000) / 60000);
      const secs = Math.floor((diff % 60000) / 1000);

      let parts = [];
      if (days > 0) parts.push(`${days}d`);
      parts.push(`${String(hours).padStart(2,'0')}h`);
      parts.push(`${String(mins).padStart(2,'0')}m`);
      parts.push(`${String(secs).padStart(2,'0')}s`);

      countdownTimer.textContent = parts.join(' ');
    }

    countdownTitle.textContent = next.title;
    countdownBanner.classList.remove('hidden');
    updateCountdown();
    const countdownInterval = setInterval(updateCountdown, 1000);
    window.addEventListener('beforeunload', () => clearInterval(countdownInterval));
  }

  // Load recordings
  const recs = await (await fetch(`/api/orgs/${orgSlug}/rooms/${room}/recordings`)).json();
  if (recs.length > 0) {
    const card = document.getElementById('recordings-card');
    const list = document.getElementById('recordings-list');
    card.classList.remove('hidden');
    recs.slice(0, 10).forEach(r => {
      const d = new Date(r.recorded_at);
      const mins = Math.floor(r.duration_seconds / 60);
      const titleLabel = r.title || `${d.toLocaleDateString()} — ${mins}min`;
      if (window.RecordingPlayer) {
        const player = window.RecordingPlayer.create({
          id: r.id,
          orgSlug,
          filename: r.filename,
          title: titleLabel,
          durationSeconds: r.duration_seconds,
          roomSlug: room,
          transcriptStatus: r.transcript_status || 'none',
        });
        list.appendChild(player);
      } else {
        const div = document.createElement('div');
        div.className = 'recording-item';
        div.innerHTML = `<a href="/recordings/${encodeURIComponent(orgSlug)}/${encodeURIComponent(r.filename)}" target="_blank">${titleLabel}</a>`;
        list.appendChild(div);
      }
    });
  }
})();

const savedName = localStorage.getItem('uc_name');
if (savedName) document.getElementById('name-input').value = savedName;

let _joined = false;

function joinRoom() {
  // maybeAutoResume() clicks Join after an await, without knowing whether the
  // user already tapped it — and HTMLElement.click() fires even though
  // #name-screen is display:none by then. That opened a SECOND WebSocket while
  // the first stayed live, feeding two interleaved Opus streams into the same
  // sequence-mode SourceBuffer (audible garbling), doubling chat, and running
  // two reconnect ladders. Pre-existing race; one flag closes it.
  if (_joined) return;

  // Never connect blank to a password-protected room (the WS join would just be rejected and
  // loop). If the password field is shown but empty, focus it and bail.
  const _pwSection = document.getElementById('password-section');
  const _pwInput = document.getElementById('password-input');
  if (_pwSection && !_pwSection.classList.contains('hidden') && !(_pwInput && _pwInput.value)) {
    if (_pwInput) _pwInput.focus();
    return;
  }
  _joined = true;
  displayName = document.getElementById('name-input').value.trim() || 'Anonymous';
  roomPassword = document.getElementById('password-input')?.value || '';
  localStorage.setItem('uc_name', displayName);

  // Remember this room for the cross-page Resume pill (24h TTL, dismissible).
  try {
    const roomName = document.getElementById('room-title-prompt')?.textContent || room;
    localStorage.setItem('uc.lastRoom', JSON.stringify({
      orgSlug, roomSlug: room, roomName, ts: Date.now(),
    }));
  } catch {}

  // Marketing analytics: count one listen_join per visit
  window.UCAnalytics?.track('listen_join', { orgSlug, roomSlug: room });

  document.getElementById('name-screen').classList.add('hidden');
  document.getElementById('player-screen').classList.remove('hidden');

  // Build the audio graph HERE, inside the real click gesture. Created outside
  // one, WebKit starts the AudioContext suspended — and once
  // createMediaElementSource has captured the element, suspended means no sound
  // at all, with resume() outside a gesture handler being a no-op. Doing it here
  // also means the analyser exists from t=0, so 'connecting' is a real state.
  getAudio();
  mihrabState('connecting');

  connect();
}

// Auto-resume from the cross-page pill: if ?autoresume=1 and we have a saved
// name AND the room isn't password-protected (we have no stored password),
// click Join automatically. Password rooms still require manual entry.
(async function maybeAutoResume() {
  if (_inRecordingMode) return;
  if (params.get('autoresume') !== '1') return;
  if (!localStorage.getItem('uc_name')) return;
  // Wait for the actual pre-load to determine password state (no fixed-delay guess), and only
  // auto-join when we POSITIVELY know the room is not password-protected — fail safe otherwise.
  await preloadReady;
  if (_roomHasPassword !== false) return;
  const pwSection = document.getElementById('password-section');
  if (pwSection && !pwSection.classList.contains('hidden')) return;
  const joinBtn = document.getElementById('join-btn') || document.querySelector('[data-action="joinRoom"]');
  if (joinBtn) joinBtn.click();
  else joinRoom();
})();

const dot = document.getElementById('dot');
const statusText = document.getElementById('status-text');

// #status is role="status", i.e. a polite live region. Assigning textContent
// replaces the text node even when the string is identical, and the server
// broadcasts a status frame on every listener join and leave — so an
// unconditional write meant a 50-person room announced "LIVE" to every screen
// reader on every join. Always set status through this.
function setStatus(msg) {
  if (statusText.textContent !== msg) statusText.textContent = msg;
  statusText.classList.toggle('status-live-label', msg === 'LIVE');
}
const listenerCount = document.getElementById('listener-count');
const elapsedEl = document.getElementById('elapsed');
const offlineMsg = document.getElementById('offline-msg');
const playerArea = document.getElementById('player-area');
const chatMessages = document.getElementById('chat-messages');
const chatText = document.getElementById('chat-text');
const chatSend = document.getElementById('chat-send');

let streamStartedAt = null;
let timerInterval = null;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    reconnectAttempts = 0;
    capAttempts = 0;
    ws.send(JSON.stringify({ type: 'join', room, role: 'listener', password: roomPassword, displayName, orgSlug }));
    dot.classList.add('connected');
    setStatus('Connected — waiting for broadcast');
  };

  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) { handleAudioChunk(e.data); return; }

    const msg = JSON.parse(e.data);

    if (msg.type === 'status') {
      listenerCount.textContent = msg.listeners;
      // Listener names are now lazy-fetched on panel expand (see listeners-toggle handler).
      // Old field preserved for back-compat: do nothing if present.
      const inputRow = document.getElementById('chat-input-row');
      const notice = document.getElementById('chat-disabled-notice');
      if (inputRow && notice) {
        const off = !!msg.chatDisabled;
        inputRow.style.display = off ? 'none' : '';
        notice.style.display = off ? 'block' : 'none';
      }
      if (msg.live) { showLive(); streamStartedAt = msg.startedAt ? new Date(msg.startedAt) : null; startTimer(); }
      else { showOffline(); }
      if (msg.reactions) {
        for (const [k, v] of Object.entries(msg.reactions)) {
          const el = document.getElementById(`c-${k}`);
          if (el && v > 0) { el.textContent = v; el.classList.remove('hidden'); }
        }
      }
    } else if (msg.type === 'stream-ended') {
      showOffline(); cleanupPlayback();
    } else if (msg.type === 'chat') {
      appendChat(msg.user, msg.text);
    } else if (msg.type === 'reaction') {
      const el = document.getElementById(`c-${msg.reaction}`);
      if (el) { el.textContent = msg.count; el.classList.remove('hidden'); }
      spawnFloatingReaction(msg.reaction);
    } else if (msg.type === 'branding') {
      applyBranding(msg);
    } else if (msg.type === 'error') {
      setStatus(msg.message);
    }
  };

  ws.onclose = (event) => {
    dot.classList.remove('connected', 'live');
    cleanupPlayback();
    const code = event && event.code;
    // cleanupPlayback() has just killed MSE, so audio dies within a second —
    // continuing to measure would be dishonest. 'connecting' while we retry,
    // 'offline' once we've given up.
    mihrabState(code === 1008 || reconnectAttempts >= MAX_RECONNECT ? 'offline' : 'connecting');
    let delay;
    if (code === 1013) {
      // Room at capacity — back off harder so we don't pile on
      delay = Math.min(15000 * Math.pow(1.5, capAttempts), 120000);
      capAttempts++;
      setStatus(`Room at capacity, retrying in ${Math.round(delay / 1000)}s…`);
    } else if (code === 1008) {
      // Permanent rejection (e.g. too many connections from this network) — reconnecting just
      // hammers the server and can't succeed. Stop and tell the user.
      setStatus('Too many connections from your network — try again later.');
      return;
    } else if (reconnectAttempts >= MAX_RECONNECT) {
      // Give up after sustained failure (room deleted, server down…) instead of looping forever.
      setStatus('Disconnected — refresh the page to reconnect.');
      return;
    } else {
      delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
      reconnectAttempts++;
      setStatus('Disconnected — reconnecting...');
    }
    setTimeout(connect, delay);
  };
}

// Branding — both fields are validated server-side before storage, but re-validate
// here as defense-in-depth (these values land in CSS and <img src> at runtime).
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const SAFE_LOGO_RE = /^\/uploads\/[A-Za-z0-9._-]+$/;
function applyBranding(b) {
  if (b.accentColor && HEX_COLOR_RE.test(b.accentColor)) {
    document.documentElement.style.setProperty('--accent', b.accentColor);
    document.documentElement.style.setProperty('--accent-glow', b.accentColor + '4d');
    document.querySelectorAll('.msg-user').forEach(el => el.style.color = b.accentColor);
  }
  if (b.logoUrl && SAFE_LOGO_RE.test(b.logoUrl)) {
    const logo = document.getElementById('room-logo');
    logo.src = b.logoUrl;
    logo.classList.remove('hidden');
  }
  if (b.description) {
    const desc = document.getElementById('room-desc');
    desc.textContent = b.description;
    desc.classList.remove('hidden');
  }
}

// Reactions
const reactionEmoji = { dua: '🤲', mosque: '🕌', tasbih: '📿', crescent: '☪️' };

function react(type) {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'reaction', reaction: type }));
  if (navigator.vibrate) navigator.vibrate([50, 30, 50]);
}
window.react = react;

function spawnFloatingReaction(type) {
  // Rise inside the niche, clipped by the arch as they go — the reaction
  // belongs to the lit room, not to the whole viewport.
  const host = document.getElementById('mihrab-niche') || document.body;
  const el = document.createElement('div');
  el.className = 'float-reaction';
  el.textContent = reactionEmoji[type] || '❤️';
  el.style.left = (18 + Math.random() * 56) + '%';
  el.style.bottom = host === document.body ? '20%' : '8%';
  host.appendChild(el);
  setTimeout(() => el.remove(), 1700);
}

// Audio + volume boost via Web Audio API
let audio;
let audioCtx;
let gainNode;
let analyserNode;

// Tuning for the Mihrab light. The two knobs most likely to need a nudge
// against a real broadcast are NOISE_FLOOR and CURVE; the ballistics should not.
const MIHRAB = {
  FFT_SIZE: 1024,        // 21.3ms @48k — about two cycles of a 90Hz voice, so
                         // the RMS doesn't wobble at the pitch rate (was 64,
                         // i.e. 1.33ms: an eighth of one cycle)
  FRAME_MS: 33,          // ~30Hz. The 45ms attack bandlimits the signal to
                         // ~10Hz, so this is 3x Nyquist for it, and 33ms is
                         // exactly every 2nd vsync at 60Hz — no beating.
  DT_CLAMP_MS: 250,
  NOISE_FLOOR: 0.008,    // ~-42dBFS: above mosque HVAC hiss through Opus,
                         // below a murmur at 1m. broadcast.js treats peak<0.02
                         // as silence, which is ~0.005-0.006 RMS — consistent.
  REF_MIN: 0.030,
  REF_MAX: 0.600,
  REF_ATTACK_MS: 400,
  REF_RELEASE_MS: 10000,
  ATTACK_MS: 45,         // 63% in 45ms: instant, with a hint of filament
  RELEASE_MS: 420,       // a 150ms inter-word gap only decays to 70% — the
                         // lamp breathes, it does not strobe per syllable
  BLOOM_MS: 1200,        // at a 1s pause level is at 9% but bloom is still 44%;
                         // that lag between core and halo is the whole point
  CURVE: 0.6,            // ~Stevens' brightness exponent
  IDLE_FLOOR: 0.06,
  DECIMALS: 2,
  REDUCED_LEVEL: 0.55,
};

let _graphBuilt = false;

function getAudio() {
  if (!audio) audio = document.getElementById('audio');
  buildAudioGraph();
  return audio;
}

// Graph: source -> analyser -> gain -> destination.
// The analyser sits BEFORE the gain deliberately, so the light measures the
// broadcaster's voice and not the listener's volume slider. Post-gain (the old
// order) meant muting to 0% killed the light while someone was still speaking,
// and 200% pinned it — the slider is a private playback preference and carries
// no information about the khatib.
// createMediaElementSource can only ever be called once per element, and a
// second call can permanently silence it — hence the latch, set BEFORE the try
// so a throw can never license a retry.
function buildAudioGraph() {
  if (_graphBuilt || !audio) return;
  _graphBuilt = true;
  let source = null;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    source = audioCtx.createMediaElementSource(audio);
    gainNode = audioCtx.createGain();
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = MIHRAB.FFT_SIZE;
    // NB: no smoothingTimeConstant — it only smooths the frequency-magnitude
    // array and has no effect on the time-domain getters we use for RMS.
    source.connect(analyserNode);
    analyserNode.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    audioCtx.addEventListener('statechange', mihrabOnCtxState);
  } catch (err) {
    console.warn('[audio] Web Audio graph unavailable, falling back to element volume', err);
    // If createMediaElementSource succeeded but a later step threw, the element
    // is captured by the graph and connected to nothing — total silence. Bypass
    // straight to the destination so audio is always audible. Never close the
    // context: a closed context leaves a captured element permanently silent.
    if (source && audioCtx) { try { source.connect(audioCtx.destination); } catch {} }
    gainNode = null;
    analyserNode = null;
  }
  mihrabInit();
}

// ===== The Mihrab light: audio RMS -> two CSS custom properties =====
// Everything visual is derived in CSS from --mihrab-level and --mihrab-bloom.
// This module never sets a colour, a size or a filter, and never reads layout.

function mihrabCoef(dt, tauMs) { return 1 - Math.exp(-dt / tauMs); }

let _mkEl = null;
let _mkBuf = null;
let _mkUseFloat = false;
let _mkRaf = 0;
let _mkRunning = false;
let _mkInited = false;
let _mkSeed = true;
let _mkLastTs = 0;
let _mkRef = MIHRAB.REF_MIN;
let _mkEnv = 0;
let _mkBloom = 0;
let _mkLevelStr = '';
let _mkBloomStr = '';
let _mkState = 'connecting';
let _mkUnmetered = false;
let _mkVisible = true;
let _mkMq = null;
let _mkIo = null;

function mihrabInit() {
  if (_mkInited) return;
  _mkEl = document.getElementById('mihrab');
  if (!_mkEl) return;              // no markup yet — the engine simply no-ops
  _mkInited = true;

  _mkMq = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (_mkMq.addEventListener) _mkMq.addEventListener('change', mihrabOnMotion);
  else if (_mkMq.addListener) _mkMq.addListener(mihrabOnMotion);

  if (analyserNode) {
    _mkUseFloat = typeof analyserNode.getFloatTimeDomainData === 'function';
    _mkBuf = _mkUseFloat ? new Float32Array(analyserNode.fftSize)
                         : new Uint8Array(analyserNode.fftSize);
  } else {
    // No analyser will ever appear — hand the whole appearance to CSS.
    mihrabSetUnmetered(true);
  }

  document.addEventListener('visibilitychange', mihrabOnVisibility);
  window.addEventListener('pagehide', mihrabOnPageHide);
  window.addEventListener('pageshow', mihrabOnPageShow);
  if (audio) {
    audio.addEventListener('playing', mihrabOnPlaying);
    audio.addEventListener('pause', mihrabOnPause);
    audio.addEventListener('ended', mihrabOnPause);
    audio.addEventListener('emptied', mihrabOnPause);
  }

  // Stop writing when the niche has scrolled out of view. Without this, the
  // fixed bottom nav's backdrop-filter would keep re-blurring over a component
  // the user cannot see.
  if ('IntersectionObserver' in window) {
    _mkIo = new IntersectionObserver((entries) => {
      _mkVisible = entries[entries.length - 1].isIntersecting;
      // Also parks the CSS ember-breath. That animation runs independently of
      // this loop, and while the niche overlaps the fixed bottom nav its
      // opacity changes force that nav's backdrop-filter to re-blur.
      _mkEl.classList.toggle('mihrab--offscreen', !_mkVisible);
      if (!_mkVisible) mihrabPause();
      else if (_mkState === 'live') mihrabStart();
    }, { threshold: 0.1 });
    _mkIo.observe(_mkEl);
  }

  mihrabOnMotion();
  mihrabApplyState();
}

function mihrabReducedMotion() { return !!(_mkMq && _mkMq.matches); }

// Under `reduce` the loop never starts at all. A large bright area changing at
// 3-30Hz sits squarely in the photosensitive-seizure band, which is a worse
// problem than the vestibular one the preference nominally addresses. Nothing
// is lost: "someone is speaking" is already carried by #status-text and the dot.
function mihrabOnMotion() {
  if (!_mkEl) return;
  if (mihrabReducedMotion()) {
    _mkEl.dataset.motion = 'reduced';
    mihrabPause();
    mihrabWrite(MIHRAB.REDUCED_LEVEL, MIHRAB.REDUCED_LEVEL, true);
  } else {
    delete _mkEl.dataset.motion;
    mihrabWrite(0, 0, true);
    if (_mkState === 'live') mihrabStart();
  }
}

function mihrabSetUnmetered(on) {
  if (!_mkEl || _mkUnmetered === on) return;
  _mkUnmetered = on;
  _mkEl.classList.toggle('mihrab--unmetered', on);
  if (on) {
    // CSS supplies its own constants; stop fighting it with inline styles.
    _mkEl.style.removeProperty('--mihrab-level');
    _mkEl.style.removeProperty('--mihrab-bloom');
    _mkLevelStr = '';
    _mkBloomStr = '';
  }
}

// Quantising to 2 decimals and comparing the string gets the epsilon check and
// the allocation in one step, and skips 20-40% of writes during slow decays.
// Passing a raw number would let WebIDL stringify it to 17 significant digits.
function mihrabWrite(level, bloom, force) {
  if (!_mkEl || _mkUnmetered) return;
  const l = level.toFixed(MIHRAB.DECIMALS);
  if (force || l !== _mkLevelStr) { _mkLevelStr = l; _mkEl.style.setProperty('--mihrab-level', l); }
  const b = bloom.toFixed(MIHRAB.DECIMALS);
  if (force || b !== _mkBloomStr) { _mkBloomStr = b; _mkEl.style.setProperty('--mihrab-bloom', b); }
}

function mihrabRms() {
  if (!analyserNode || !_mkBuf) return -1;
  const buf = _mkBuf;
  const n = buf.length;
  let sum = 0;
  if (_mkUseFloat) {
    analyserNode.getFloatTimeDomainData(buf);
    for (let i = 0; i < n; i++) { const v = buf[i]; sum += v * v; }
  } else {
    analyserNode.getByteTimeDomainData(buf);
    // 128 is exact digital zero (byte = round(sample*128)+128). Dividing by
    // 127.5 instead would leave a permanent DC pedestal — a constant non-zero
    // RMS during true silence, i.e. the exact shimmer the gate exists to remove.
    for (let i = 0; i < n; i++) { const v = (buf[i] - 128) * 0.0078125; sum += v * v; }
  }
  return Math.sqrt(sum / n);
}

function mihrabFrame(ts) {
  if (!_mkRunning) { _mkRaf = 0; return; }
  _mkRaf = requestAnimationFrame(mihrabFrame);
  if (document.hidden) return;
  if (_mkLastTs && ts - _mkLastTs < MIHRAB.FRAME_MS) return;

  let dt = _mkLastTs ? ts - _mkLastTs : MIHRAB.FRAME_MS;
  if (dt > MIHRAB.DT_CLAMP_MS) dt = MIHRAB.DT_CLAMP_MS;
  _mkLastTs = ts;

  const rms = mihrabRms();
  if (rms < 0) { mihrabSetUnmetered(true); mihrabPause(); return; }

  // There is deliberately NO runtime "dead analyser" watchdog here. One was
  // tried, keyed on bit-exact zero for 5s while currentTime advanced, on the
  // premise that real rooms always have some hiss. The premise is wrong — a
  // hardware-muted mic or a mis-routed virtual input decodes to exact zeros —
  // and the failure was inverted: it handed over to .mihrab--unmetered, whose
  // canned constants (L=0.42, B=0.50) render the lamp 1.7-4x BRIGHTER than the
  // live-but-quiet state it replaced. Silence would have lit the niche up.
  // A broken tap and a silent source are indistinguishable from here and want
  // opposite renderings, so we render silence: the idle floor, a dim lamp.
  // The genuinely unmetered case (no analyser at all) is caught in mihrabInit.

  // Subtract-and-rescale rather than a hard gate, so quiet speech fades in
  // instead of popping from off to the floor-mapped brightness.
  const F = MIHRAB.NOISE_FLOOR;
  const gated = rms <= F ? 0 : (rms - F) / (1 - F);

  // Auto-normalising reference: source level varies by 20+dB between a phone on
  // a lectern and a line-in from the PA, so a fixed gain would leave half the
  // mosques permanently dim and the other half permanently pinned. The attack
  // is deliberately not instant — otherwise one door slam pins the range high
  // and dims the following 10 seconds of speech.
  _mkRef += (gated - _mkRef) * mihrabCoef(dt, gated > _mkRef ? MIHRAB.REF_ATTACK_MS : MIHRAB.REF_RELEASE_MS);
  if (_mkRef < MIHRAB.REF_MIN) _mkRef = MIHRAB.REF_MIN;
  else if (_mkRef > MIHRAB.REF_MAX) _mkRef = MIHRAB.REF_MAX;

  let target = gated / _mkRef;
  if (target > 1) target = 1;
  // Perceptual curve before the ballistics, so the ms constants below describe
  // what the eye actually sees. A power curve rather than dB: dB goes to -inf
  // at zero and re-expands the region just above the gate.
  if (target > 0) target = Math.pow(target, MIHRAB.CURVE);

  if (_mkSeed) { _mkEnv = target; _mkBloom = target; _mkSeed = false; }
  else {
    _mkEnv += (target - _mkEnv) * mihrabCoef(dt, target > _mkEnv ? MIHRAB.ATTACK_MS : MIHRAB.RELEASE_MS);
    _mkBloom += (_mkEnv - _mkBloom) * mihrabCoef(dt, MIHRAB.BLOOM_MS);
  }

  // The 0.06 floor keeps the lamp visibly a lamp mid-sentence. The longer-term
  // "live but silent for a minute" case is handled in CSS by --mihrab-rest,
  // keyed off the state rather than the signal, so we never lie about the audio.
  mihrabWrite(Math.max(MIHRAB.IDLE_FLOOR, _mkEnv), _mkBloom, false);
}

// Explicitly idempotent, and defensively cancels first. This is mandatory, not
// belt-and-braces: showLive() fires on every status frame (join, reaction, chat
// toggle...), so without the latch one reaction burst spawns N concurrent rAF
// loops — the same hazard initMSE() already guards against.
function mihrabStart() {
  if (!_mkInited || _mkRunning) return;
  // Deliberately NOT gated on _mkUnmetered. The watchdog can only clear that
  // flag from inside the loop, so refusing to restart while unmetered makes any
  // pause terminal: mute the mic for 5s, then background the tab or let a
  // reconnect fire `emptied`, and the light would never track the voice again
  // for the rest of the session. A null analyser is the only permanent case,
  // and that is what the !analyserNode guard below is for.
  if (mihrabReducedMotion() || !_mkVisible || !analyserNode) return;
  _mkRunning = true;
  _mkSeed = true;
  _mkLastTs = 0;
  if (_mkRaf) cancelAnimationFrame(_mkRaf);
  _mkRaf = requestAnimationFrame(mihrabFrame);
}

// Keeps the last published value — zeroing here would flash off then on.
function mihrabPause() {
  _mkRunning = false;
  if (_mkRaf) { cancelAnimationFrame(_mkRaf); _mkRaf = 0; }
  _mkLastTs = 0;
  _mkSeed = true;
}

function mihrabStop() {
  mihrabPause();
  _mkEnv = 0; _mkBloom = 0; _mkRef = MIHRAB.REF_MIN;
  // Under reduced motion the loop never runs, so this is the ONLY writer —
  // zeroing here would leave the niche dark for the whole broadcast. The
  // per-state --mihrab-gain still dims offline/connecting appropriately.
  const rest = mihrabReducedMotion() ? MIHRAB.REDUCED_LEVEL : 0;
  mihrabWrite(rest, rest, true);
}

function mihrabOnVisibility() {
  if (document.hidden) mihrabPause();
  else if (_mkState === 'live') mihrabStart();
}
function mihrabOnPageHide(ev) { if (ev && ev.persisted) mihrabPause(); else mihrabDestroy(); }
function mihrabOnPageShow(ev) { if (ev && ev.persisted && _mkState === 'live') mihrabStart(); }
function mihrabOnPlaying() { if (_mkState === 'live') mihrabStart(); }
function mihrabOnPause() { mihrabPause(); }

// iOS uses a non-standard 'interrupted' state (phone call, Siri, another app
// taking the audio session), so treat anything other than 'running' as blocked.
function mihrabOnCtxState() {
  if (!audioCtx) return;
  if (audioCtx.state !== 'running') mihrabPause();
  else if (_mkState === 'live') mihrabStart();
}

function mihrabApplyState() {
  if (!_mkEl) return;
  _mkEl.dataset.state = _mkState;
  if (_mkState === 'live') mihrabStart();
  else mihrabStop();
}

function mihrabState(name) {
  if (_mkState === name) return;
  _mkState = name;
  mihrabApplyState();
}
window.mihrabState = mihrabState;

function mihrabDestroy() {
  mihrabPause();
  if (_mkIo) { _mkIo.disconnect(); _mkIo = null; }
  document.removeEventListener('visibilitychange', mihrabOnVisibility);
  window.removeEventListener('pagehide', mihrabOnPageHide);
  window.removeEventListener('pageshow', mihrabOnPageShow);
  if (audio) {
    audio.removeEventListener('playing', mihrabOnPlaying);
    audio.removeEventListener('pause', mihrabOnPause);
    audio.removeEventListener('ended', mihrabOnPause);
    audio.removeEventListener('emptied', mihrabOnPause);
  }
  if (audioCtx) { try { audioCtx.removeEventListener('statechange', mihrabOnCtxState); } catch {} }
  if (_mkMq) {
    if (_mkMq.removeEventListener) _mkMq.removeEventListener('change', mihrabOnMotion);
    else if (_mkMq.removeListener) _mkMq.removeListener(mihrabOnMotion);
  }
  _mkBuf = null;
  _mkEl = null;
  _mkInited = false;
}

// Volume slider
const volumeSlider = document.getElementById('volume-slider');
const volumeLabel = document.getElementById('volume-label');
if (volumeSlider) {
  const savedVol = localStorage.getItem('uc_volume');
  if (savedVol) { volumeSlider.value = savedVol; }
  volumeSlider.addEventListener('input', () => {
    const val = parseInt(volumeSlider.value, 10);
    volumeLabel.textContent = val + '%';
    localStorage.setItem('uc_volume', val);
    if (gainNode) {
      gainNode.gain.value = val / 100;
    } else {
      getAudio().volume = Math.min(val / 100, 1);
    }
  });
  // Apply saved volume on load
  const initVol = parseInt(volumeSlider.value, 10);
  volumeLabel.textContent = initVol + '%';
}

function initMSE() {
  if (mediaSource) return; // already initializing — a burst of chunks before 'sourceopen' must
                           // not each spawn a MediaSource (orphans that leak + fight over the audio)
  const a = getAudio();
  mediaSource = new MediaSource();
  _mseUrl = URL.createObjectURL(mediaSource);
  a.src = _mseUrl;
  mediaSource.addEventListener('sourceopen', () => {
    try {
      sourceBuffer = mediaSource.addSourceBuffer('audio/webm;codecs=opus');
      sourceBuffer.mode = 'sequence';
      sourceBuffer.addEventListener('updateend', processQueue);
    } catch (err) { console.error('MSE init error:', err); }
  });
}

function handleAudioChunk(data) {
  if (!sourceBuffer) { initMSE(); queue.push(data); return; }
  queue.push(data);
  processQueue();
}

function processQueue() {
  if (!sourceBuffer || sourceBuffer.updating || queue.length === 0) return;
  const chunk = queue.shift();
  try { sourceBuffer.appendBuffer(chunk); } catch (err) {
    if (err.name === 'QuotaExceededError' && !sourceBuffer.updating) {
      const b = sourceBuffer.buffered;
      if (b.length > 0) sourceBuffer.remove(b.start(0), b.end(0) - 2);
    }
  }
  const a = getAudio();
  if (a.buffered.length > 0) {
    const edge = a.buffered.end(a.buffered.length - 1);
    if (edge - a.currentTime > 3) a.currentTime = edge - 0.5;
  }
  // Apply volume on first chunk
  if (gainNode && volumeSlider) {
    gainNode.gain.value = parseInt(volumeSlider.value, 10) / 100;
  }
  // iOS reports a non-standard 'interrupted' state (phone call, Siri), so
  // resume on anything that isn't 'running', not just 'suspended'.
  if (audioCtx && audioCtx.state !== 'running') {
    audioCtx.resume();
  }
  if (a.paused) {
    a.play().catch(() => { armAudioUnblock(a); });
  }
}

// The old version listened for one click and called only a.play() — which fixes
// nothing when the AudioContext is the thing that's suspended, and gave the user
// exactly one attempt. Retry until both the context is running and the element
// is actually playing, and accept a keypress so keyboard users aren't stranded.
const TAP_PROMPT = 'Tap anywhere to start audio';
let _unblockArmed = false;
function armAudioUnblock(a) {
  if (_unblockArmed) return;
  _unblockArmed = true;
  setStatus(TAP_PROMPT);
  const tryUnblock = () => {
    if (audioCtx && audioCtx.state !== 'running') audioCtx.resume();
    a.play().catch(() => {});
    if ((!audioCtx || audioCtx.state === 'running') && !a.paused) {
      document.removeEventListener('click', tryUnblock);
      document.removeEventListener('touchend', tryUnblock);
      document.removeEventListener('keydown', tryUnblock);
      _unblockArmed = false;
      if (statusText.textContent === TAP_PROMPT) setStatus('LIVE');
    }
  };
  document.addEventListener('click', tryUnblock);
  document.addEventListener('touchend', tryUnblock);
  document.addEventListener('keydown', tryUnblock);
}

function showLive() {
  dot.classList.remove('connected'); dot.classList.add('live');
  if (statusText.textContent !== TAP_PROMPT) setStatus('LIVE');
  mihrabState('live');
  offlineMsg.classList.add('hidden'); playerArea.classList.remove('hidden');
  startTitlePulse();
  // Toast only on a real offline→live transition. showLive() runs on every status frame (join,
  // reaction, chat-toggle…), so an unconditional toast here would spam once per frame.
  if (_lastLiveToast !== 'live') {
    if (typeof ToastManager !== 'undefined') ToastManager.live('Broadcast is live!');
    _lastLiveToast = 'live';
  }
}
function showOffline() {
  dot.classList.remove('live'); dot.classList.add('connected');
  setStatus('No broadcast right now');
  mihrabState('offline');
  offlineMsg.classList.remove('hidden'); stopTimer();
  stopTitlePulse();
  if (_lastLiveToast !== 'offline') {
    if (typeof ToastManager !== 'undefined') ToastManager.info('Broadcast ended');
    _lastLiveToast = 'offline';
  }
}

// ===== Pulsing tab title =====
let _origTitle = null;
let _titleTimer = null;
let _titleAlt = false;
function startTitlePulse() {
  if (_titleTimer) return;
  if (!_origTitle) _origTitle = document.title;
  const roomLabel = document.getElementById('room-name')?.textContent || _origTitle;
  function tick() {
    // If user is looking at the tab, don't pulse — they already know
    if (!document.hidden) { document.title = _origTitle; return; }
    _titleAlt = !_titleAlt;
    document.title = _titleAlt ? `🔴 LIVE — ${roomLabel}` : _origTitle;
  }
  _titleTimer = setInterval(tick, 2000);
  document.addEventListener('visibilitychange', _onVisibilityForTitle);
}
function stopTitlePulse() {
  if (_titleTimer) { clearInterval(_titleTimer); _titleTimer = null; }
  document.removeEventListener('visibilitychange', _onVisibilityForTitle);
  if (_origTitle) document.title = _origTitle;
}
function _onVisibilityForTitle() {
  if (!document.hidden && _origTitle) document.title = _origTitle;
}
window.addEventListener('beforeunload', stopTitlePulse);

function cleanupPlayback() {
  queue = [];
  if (mediaSource?.readyState === 'open') { try { mediaSource.endOfStream(); } catch {} }
  if (_mseUrl) { try { URL.revokeObjectURL(_mseUrl); } catch {} _mseUrl = null; }
  sourceBuffer = null; mediaSource = null;
}

function startTimer() { stopTimer(); timerInterval = setInterval(() => { if (!streamStartedAt) return; const s = Math.floor((Date.now() - streamStartedAt.getTime()) / 1000); elapsedEl.textContent = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; }, 1000); }
function stopTimer() { clearInterval(timerInterval); elapsedEl.textContent = '00:00'; }

// Periodic buffer cleanup
setInterval(() => {
  if (sourceBuffer && !sourceBuffer.updating && sourceBuffer.buffered.length > 0) {
    const a = getAudio();
    const b = sourceBuffer.buffered;
    if (b.end(b.length - 1) - a.currentTime > 10) {
      try { sourceBuffer.remove(b.start(0), a.currentTime - 2); } catch {}
    }
  }
}, 5000);

// Chat
chatSend.addEventListener('click', sendChat);
chatText.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

function sendChat() {
  const text = chatText.value.trim();
  if (!text || ws?.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'chat', text }));
  chatText.value = '';
}

const MAX_CHAT_MESSAGES = 50;
function appendChat(user, text) {
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = `<span class="msg-user">${esc(user)}</span> <span class="msg-text">${esc(text)}</span>`;
  chatMessages.appendChild(div);
  while (chatMessages.children.length > MAX_CHAT_MESSAGES) chatMessages.removeChild(chatMessages.children[0]);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// Listener list
function renderListenerList(names, total) {
  const list = document.getElementById('listeners-list');
  if (!list) return;
  list.innerHTML = '';
  if (!names || names.length === 0) { list.innerHTML = '<span style="font-size:0.8rem;color:var(--text-muted);">No one yet</span>'; return; }
  names.forEach(name => {
    const chip = document.createElement('span');
    chip.className = 'avatar-stack';
    chip.innerHTML = `<span class="avatar-sm">${esc(name[0])}</span><span style="font-size:0.75rem;color:var(--text-muted);margin-left:0.25rem;">${esc(name)}</span>`;
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:0.15rem;padding:0.2rem 0.5rem;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-pill);margin:0.1rem;';
    list.appendChild(chip);
  });
  if (total > names.length) {
    const more = document.createElement('span');
    more.style.cssText = 'font-size:0.75rem;color:var(--text-muted);padding:0.2rem 0.4rem;';
    more.textContent = `+${total - names.length} more`;
    list.appendChild(more);
  }
}

// Lazy-fetch the listener list when the panel is expanded.
// 5-second client cache prevents hammering on rapid toggle.
let _listenersCache = { ts: 0, data: null };
async function fetchListeners() {
  const now = Date.now();
  if (_listenersCache.data && (now - _listenersCache.ts) < 5000) {
    renderListenerList(_listenersCache.data.names, _listenersCache.data.count);
    return;
  }
  try {
    const headers = roomPassword ? { 'X-Room-Password': roomPassword } : {};
    const res = await fetch(`/api/orgs/${encodeURIComponent(orgSlug)}/rooms/${encodeURIComponent(room)}/listeners`, { headers });
    if (!res.ok) {
      const list = document.getElementById('listeners-list');
      if (list) list.innerHTML = '<span style="font-size:0.8rem;color:var(--text-muted);">Could not load listeners</span>';
      return;
    }
    const data = await res.json();
    _listenersCache = { ts: now, data };
    renderListenerList(data.names, data.count);
  } catch {
    const list = document.getElementById('listeners-list');
    if (list) list.innerHTML = '<span style="font-size:0.8rem;color:var(--text-muted);">Could not load listeners</span>';
  }
}

// Wire up the toggle (CSP-safe — no inline onclick)
document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('listeners-toggle');
  const list = document.getElementById('listeners-list');
  if (!toggle || !list) return;
  const toggleList = () => {
    list.classList.toggle('hidden');
    const open = !list.classList.contains('hidden');
    toggle.setAttribute('aria-expanded', String(open));
    if (open) fetchListeners();
  };
  toggle.addEventListener('click', toggleList);
  // It's a div with role="button", so Enter/Space have to be wired by hand.
  toggle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleList(); }
  });
});

// Share
async function shareStream() {
  const listenUrl = `${location.origin}/${orgSlug}/listen?room=${room}`;
  const roomLabel = room.charAt(0).toUpperCase() + room.slice(1);
  const title = 'UmmahCast';
  const text = `Listen live on UmmahCast — ${roomLabel}:`;

  if (navigator.share) {
    try {
      await navigator.share({ title, text, url: listenUrl });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }

  try {
    await navigator.clipboard.writeText(`${text}\n${listenUrl}`);
    const btn = document.getElementById('btn-share-listen');
    const orig = btn.innerHTML;
    btn.innerHTML = '✓ Copied!';
    setTimeout(() => { btn.innerHTML = orig; }, 2000);
  } catch {
    prompt('Copy this link:', listenUrl);
  }
}
window.shareStream = shareStream;

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
let sourceBuffer;
let queue = [];
let reconnectAttempts = 0;
let capAttempts = 0; // separate counter so a network blip doesn't inherit cap-backoff
let displayName = '';
let roomPassword = '';

// Skip live setup if we're in recording-share mode
const _inRecordingMode = Number.isInteger(recordingIdParam) && recordingIdParam > 0;

// Pre-load room info
(async () => {
  if (_inRecordingMode) return;
  const rooms = await (await fetch(`/api/orgs/${orgSlug}/rooms`)).json();
  const info = rooms.find(r => r.slug === room);
  if (info) {
    document.getElementById('room-title-prompt').textContent = info.name;
    if (info.hasPassword) document.getElementById('password-section').classList.remove('hidden');
  }

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

function joinRoom() {
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

  connect();
}

// Auto-resume from the cross-page pill: if ?autoresume=1 and we have a saved
// name AND the room isn't password-protected (we have no stored password),
// click Join automatically. Password rooms still require manual entry.
(function maybeAutoResume() {
  if (_inRecordingMode) return;
  if (params.get('autoresume') !== '1') return;
  if (!localStorage.getItem('uc_name')) return;
  // Wait until pre-load determines whether the room has a password.
  // The pre-load IIFE above un-hides #password-section if needed.
  setTimeout(() => {
    const pwSection = document.getElementById('password-section');
    if (pwSection && !pwSection.classList.contains('hidden')) return;
    const joinBtn = document.getElementById('join-btn') || document.querySelector('[onclick="joinRoom()"]');
    if (joinBtn) joinBtn.click();
    else joinRoom();
  }, 300);
})();

const dot = document.getElementById('dot');
const statusText = document.getElementById('status-text');
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
    statusText.textContent = 'Connected — waiting for broadcast';
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
      statusText.textContent = msg.message;
    }
  };

  ws.onclose = (event) => {
    dot.classList.remove('connected', 'live');
    cleanupPlayback();
    let delay;
    if (event && event.code === 1013) {
      // Room at capacity — back off harder so we don't pile on
      delay = Math.min(15000 * Math.pow(1.5, capAttempts), 120000);
      capAttempts++;
      statusText.textContent = `Room at capacity, retrying in ${Math.round(delay / 1000)}s…`;
    } else {
      delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
      reconnectAttempts++;
      statusText.textContent = 'Disconnected — reconnecting...';
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
  const el = document.createElement('div');
  el.className = 'float-reaction';
  el.textContent = reactionEmoji[type] || '❤️';
  el.style.left = (30 + Math.random() * 40) + '%';
  el.style.bottom = '20%';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

// Audio + volume boost via Web Audio API
let audio;
let audioCtx;
let gainNode;
let analyserNode;

function getAudio() {
  if (!audio) {
    audio = document.getElementById('audio');
    // Set up gain node for volume boost (0-200%) + analyser for visualizer
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaElementSource(audio);
      gainNode = audioCtx.createGain();
      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 64;
      analyserNode.smoothingTimeConstant = 0.7;
      source.connect(gainNode);
      gainNode.connect(analyserNode);
      analyserNode.connect(audioCtx.destination);
      startVisualizer();
    } catch {}
  }
  return audio;
}

// ===== Live audio visualizer (24 bars) =====
let vuRafId = null;
let vuStatic = false;  // for prefers-reduced-motion
function startVisualizer() {
  const canvas = document.getElementById('vu-canvas');
  if (!canvas || !analyserNode) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  vuStatic = reduced;

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2d8a4e';
  const muted = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || '#2a2a33';
  const data = new Uint8Array(analyserNode.frequencyBinCount);

  let lastFrame = 0;
  let pulsePhase = 0;

  function draw(ts) {
    vuRafId = requestAnimationFrame(draw);
    if (document.hidden) return;
    if (ts - lastFrame < 33) return;  // cap at ~30fps
    lastFrame = ts;

    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (vuStatic || !audio || audio.paused) {
      // Static state: pulsing dot
      pulsePhase = (pulsePhase + 0.04) % (Math.PI * 2);
      const alpha = 0.35 + 0.35 * (Math.sin(pulsePhase) * 0.5 + 0.5);
      ctx.fillStyle = audio && !audio.paused ? accent : muted;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, Math.min(w, h) / 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      return;
    }

    analyserNode.getByteFrequencyData(data);
    const bars = 24;
    const step = Math.floor(data.length / bars) || 1;
    const barW = w / bars;
    const gap = barW * 0.25;
    const drawW = barW - gap;
    const baseline = h * 0.95;
    const maxH = h * 0.85;

    for (let i = 0; i < bars; i++) {
      let v = 0;
      for (let j = 0; j < step; j++) v = Math.max(v, data[i * step + j] || 0);
      const norm = v / 255;
      const barH = Math.max(2 * dpr, norm * maxH);
      const x = i * barW + gap / 2;
      const y = baseline - barH;
      // Color: dim accent for quiet, full accent for loud
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.3 + 0.7 * norm;
      ctx.fillRect(x, y, drawW, barH);
    }
    ctx.globalAlpha = 1;
  }
  if (vuRafId) cancelAnimationFrame(vuRafId);
  vuRafId = requestAnimationFrame(draw);
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
  const a = getAudio();
  mediaSource = new MediaSource();
  a.src = URL.createObjectURL(mediaSource);
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
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  if (a.paused) {
    a.play().catch(() => {
      statusText.textContent = 'Tap anywhere to start audio';
      document.addEventListener('click', () => { a.play(); if (statusText.textContent.includes('Tap')) statusText.textContent = 'LIVE'; }, { once: true });
    });
  }
}

function showLive() {
  dot.classList.remove('connected'); dot.classList.add('live');
  statusText.textContent = 'LIVE';
  offlineMsg.classList.add('hidden'); playerArea.classList.remove('hidden');
  startTitlePulse();
  if (typeof ToastManager !== 'undefined') ToastManager.live('Broadcast is live!');
}
function showOffline() {
  dot.classList.remove('live'); dot.classList.add('connected');
  statusText.textContent = 'No broadcast right now';
  offlineMsg.classList.remove('hidden'); stopTimer();
  stopTitlePulse();
  if (typeof ToastManager !== 'undefined') ToastManager.info('Broadcast ended');
}

// ===== Pulsing tab title =====
let _origTitle = null;
let _titleTimer = null;
let _titleAlt = false;
function startTitlePulse() {
  if (_titleTimer) return;
  if (!_origTitle) _origTitle = document.title;
  const roomLabel = (typeof roomName !== 'undefined' && roomName?.textContent) || _origTitle;
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
  toggle.addEventListener('click', () => {
    list.classList.toggle('hidden');
    if (!list.classList.contains('hidden')) fetchListeners();
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

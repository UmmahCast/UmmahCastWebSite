let room = new URLSearchParams(location.search).get('room') || 'main';
if (!window._orgSlug) {
  const _pp = window.location.pathname.replace(/^\//, '').split('/');
  window._orgSlug = _pp[0] || 'default';
}
const orgSlug = window._orgSlug;

// Intercept any API response that signals 2FA enforcement and redirect to settings
(function () {
  const origFetch = window.fetch.bind(window);
  window.fetch = async function (...args) {
    const res = await origFetch(...args);
    if (res.status === 403) {
      try {
        const cloned = res.clone();
        const data = await cloned.json();
        if (data && data.mustEnable2fa) {
          window.location.href = `/${window._orgSlug || 'default'}/settings#totp-card`;
          return res;
        }
      } catch {}
    }
    return res;
  };
})();
let ws;
let mediaRecorder;
let stream;
let timerInterval;
let startTime;
let reconnectAttempts = 0;
let capAttempts = 0;
let pendingRecordingId = null;
let active = false;

const dot = document.getElementById('dot');
const statusText = document.getElementById('status-text');
const btnLive = document.getElementById('btn-live');
const btnStop = document.getElementById('btn-stop');
const listenerCount = document.getElementById('listener-count');
const elapsed = document.getElementById('elapsed');
const roomName = document.getElementById('room-name');
const chatMessages = document.getElementById('chat-messages');
const chatText = document.getElementById('chat-text');
const chatSend = document.getElementById('chat-send');
// Fixed at 128 kbps Opus — clean voice quality, gentle on cellular.
// Removed user-facing selector (most broadcasters picked default anyway).
const BROADCAST_BITRATE = 128000;

function initBroadcast(slug, name) {
  room = slug;
  active = true;
  
  roomName.textContent = `${'Broadcast'} — ${name || slug}`;
  loadAnalytics();
  loadRecordings();
  loadCategories();
  loadSchedule();
  connect();
}
window.initBroadcast = initBroadcast;

function disconnectBroadcast() {
  active = false;
  if (ws && ws.readyState === 1) ws.close();
  ws = null;
  clearInterval(timerInterval);
}
window.disconnectBroadcast = disconnectBroadcast;

async function loadAnalytics() {
  try {
    const res = await fetch(`/api/orgs/${orgSlug}/broadcaster/analytics/${room}`);
    if (!res.ok) return;
    const data = await res.json();
    const el = document.getElementById('activity-footnote');
    if (!el) return;
    const n = data.broadcastCount || 0;
    el.textContent = n > 0
      ? `${n} broadcast${n === 1 ? '' : 's'} in the last 30 days`
      : '';
  } catch {}
}

function connect() {
  if (!active) return;
  
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    reconnectAttempts = 0;
    capAttempts = 0;
    ws.send(JSON.stringify({ type: 'join', room, role: 'broadcaster', orgSlug }));
    dot.classList.add('connected');
    statusText.textContent = 'Connected — ready to broadcast';
  };

  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    const msg = JSON.parse(e.data);
    if (msg.type === 'status') {
      listenerCount.textContent = msg.listeners;
      // listenerNames now lazy-fetched on panel expand. Old field is harmless if present.
      applyChatDisabled(!!msg.chatDisabled);
    } else if (msg.type === 'error') {
      statusText.textContent = msg.message;
      btnLive.disabled = true;
    } else if (msg.type === 'chat') {
      appendChat(msg.user, msg.text);
    } else if (msg.type === 'recording-ready') {
      pendingRecordingId = msg.recordingId;
      document.getElementById('publish-card').classList.remove('hidden');
    }
  };

  ws.onclose = (event) => {
    if (!active) return;
    dot.classList.remove('connected', 'live');
    let delay;
    if (event && event.code === 1013) {
      // Defensive — broadcaster role bypasses the listener cap, but stay symmetric with listen.js
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

btnLive.addEventListener('click', async () => {
  // Reuse mic stream from test if active; otherwise request fresh
  if (!stream) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      statusText.textContent = 'Microphone access denied';
      return;
    }
  }
  // Tear down mic test analyser/UI now that we're going live
  stopMicTest({ keepStream: true });

  mediaRecorder = new MediaRecorder(stream, {
    mimeType: 'audio/webm;codecs=opus',
    audioBitsPerSecond: BROADCAST_BITRATE,
  });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0 && ws?.readyState === 1) ws.send(e.data);
  };

  // Tell server to go live (starts recording, marks room live)
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'go-live' }));

  mediaRecorder.start(250);

  dot.classList.remove('connected');
  dot.classList.add('live');
  statusText.textContent = 'LIVE';
  btnLive.classList.add('hidden');
  btnStop.classList.remove('hidden');
  document.getElementById('btn-share').classList.remove('hidden');

  startTime = Date.now();
  timerInterval = setInterval(updateTimer, 1000);
});

// ===== Mic test (input level meter before Go Live) =====
let micTestCtx = null;
let micTestAnalyser = null;
let micTestRaf = null;

async function startMicTest() {
  const btn = document.getElementById('btn-mic-test');
  const active = document.getElementById('mic-test-active');
  const label = document.getElementById('mic-meter-label');
  const canvas = document.getElementById('mic-meter');
  if (!btn || !active || !canvas) return;

  if (!stream) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      label.textContent = 'Mic denied';
      return;
    }
  }
  btn.classList.add('hidden');
  active.classList.remove('hidden');

  micTestCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = micTestCtx.createMediaStreamSource(stream);
  micTestAnalyser = micTestCtx.createAnalyser();
  micTestAnalyser.fftSize = 1024;
  src.connect(micTestAnalyser);
  // Do NOT connect to destination — no monitoring, no feedback

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  function resize() {
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(r.width * dpr));
    canvas.height = Math.max(1, Math.floor(r.height * dpr));
  }
  resize();
  window.addEventListener('resize', resize);

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2d8a4e';
  const yellow = '#eab308';
  const red = '#ef4444';
  const data = new Uint8Array(micTestAnalyser.fftSize);

  let silentFrames = 0;
  function draw() {
    micTestRaf = requestAnimationFrame(draw);
    micTestAnalyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const fillW = peak * w;
    let color = accent;
    if (peak > 0.85) color = red;
    else if (peak > 0.6) color = yellow;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, fillW, h);
    if (peak < 0.02) {
      silentFrames++;
      if (silentFrames > 60) label.textContent = 'No sound detected';
    } else {
      silentFrames = 0;
      if (peak > 0.85) label.textContent = 'Too loud';
      else if (peak > 0.1) label.textContent = 'Sounds great';
      else label.textContent = 'A bit quiet';
    }
  }
  draw();
}

function stopMicTest({ keepStream = false } = {}) {
  if (micTestRaf) { cancelAnimationFrame(micTestRaf); micTestRaf = null; }
  if (micTestCtx) { try { micTestCtx.close(); } catch {} micTestCtx = null; }
  micTestAnalyser = null;
  if (!keepStream && stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  const btn = document.getElementById('btn-mic-test');
  const active = document.getElementById('mic-test-active');
  if (btn) btn.classList.remove('hidden');
  if (active) { active.classList.add('hidden'); }
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btn-mic-test');
  if (btn) btn.addEventListener('click', startMicTest);
  const stop = document.getElementById('btn-mic-stop');
  if (stop) stop.addEventListener('click', () => stopMicTest({ keepStream: false }));
});

// Release mic on unload
window.addEventListener('beforeunload', () => stopMicTest({ keepStream: false }));

btnStop.addEventListener('click', () => {
  
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  if (stream) stream.getTracks().forEach(track => track.stop());
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'stop' }));

  dot.classList.remove('live');
  dot.classList.add('connected');
  statusText.textContent = 'Broadcast ended';
  btnStop.classList.add('hidden');
  btnLive.classList.remove('hidden');
  document.getElementById('btn-share').classList.add('hidden');

  clearInterval(timerInterval);
  elapsed.textContent = '00:00';
  setTimeout(() => { loadAnalytics(); loadRecordings(); }, 1000);
});

function updateTimer() {
  const s = Math.floor((Date.now() - startTime) / 1000);
  elapsed.textContent = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

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
  div.innerHTML = `<span class="msg-user">${escHtml(user)}</span> <span class="msg-text">${escHtml(text)}</span>`;
  chatMessages.appendChild(div);
  while (chatMessages.children.length > MAX_CHAT_MESSAGES) chatMessages.removeChild(chatMessages.children[0]);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// Recording
async function publishRecording() {
  if (!pendingRecordingId) return;
  const title = document.getElementById('recording-title').value.trim();
  await fetch(`/api/recordings/${pendingRecordingId}/publish`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title })
  });
  document.getElementById('publish-card').classList.add('hidden');
  
  statusText.textContent = 'Recording published';
  pendingRecordingId = null;
}
window.publishRecording = publishRecording;

function skipPublish() {
  document.getElementById('publish-card').classList.add('hidden');
  
  statusText.textContent = 'Recording saved (private)';
  pendingRecordingId = null;
}
window.skipPublish = skipPublish;

// Share
async function shareLive() {
  const listenUrl = `${location.origin}/${orgSlug}/listen?room=${room}`;
  const roomLabel = room.charAt(0).toUpperCase() + room.slice(1).replace(/-/g, ' ');
  const title = 'UmmahCast — Live Now!';
  const text = `${roomLabel} is live on UmmahCast! Join us:`;

  if (navigator.share) {
    try { await navigator.share({ title, text, url: listenUrl }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(`${text}\n${listenUrl}`);
    const btn = document.getElementById('btn-share');
    const orig = btn.textContent;
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  } catch { prompt('Copy this link:', listenUrl); }
}
window.shareLive = shareLive;

// Schedule management
let schedCollapsed = true;
function toggleSchedule() {
  const content = document.getElementById('schedule-mgmt-content');
  const chevron = document.getElementById('sched-chevron');
  schedCollapsed = !schedCollapsed;
  content.style.display = schedCollapsed ? 'none' : 'block';
  chevron.style.transform = schedCollapsed ? '' : 'rotate(180deg)';
}
window.toggleSchedule = toggleSchedule;

async function loadCategories() {
  const cats = await (await fetch(`/api/orgs/${orgSlug}/categories`)).json();
  const select = document.getElementById('sched-category');
  select.innerHTML = '';
  cats.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.name;
    opt.textContent = c.name;
    select.appendChild(opt);
  });
  // Category list for management
  const catList = document.getElementById('cat-list');
  catList.innerHTML = '';
  cats.forEach(c => {
    const chip = document.createElement('span');
    chip.style.cssText = 'display:inline-flex; align-items:center; gap:0.25rem; padding:0.2rem 0.5rem; background:var(--bg); border:1px solid var(--border); border-radius:999px; font-size:0.75rem; color:var(--text-muted);';
    chip.innerHTML = `${escHtml(c.name)} <span style="cursor:pointer; color:var(--text-muted);" onclick="deleteCat(${c.id})">✕</span>`;
    catList.appendChild(chip);
  });
}

async function addCat() {
  const input = document.getElementById('new-cat-name');
  const name = input.value.trim();
  if (!name) return;
  await fetch(`/api/orgs/${orgSlug}/categories`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  input.value = '';
  loadCategories();
}
window.addCat = addCat;

async function deleteCat(id) {
  await fetch(`/api/orgs/${orgSlug}/categories/${id}`, { method: 'DELETE' });
  loadCategories();
}
window.deleteCat = deleteCat;

async function loadSchedule() {
  const scheds = await (await fetch(`/api/orgs/${orgSlug}/rooms/${room}/schedule`)).json();
  const countEl = document.getElementById('sched-count');
  countEl.textContent = scheds.length > 0 ? `(${scheds.length})` : '';
  const list = document.getElementById('sched-list');
  list.innerHTML = '';
  scheds.forEach(s => {
    const d = new Date(s.starts_at);
    const div = document.createElement('div');
    div.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:0.4rem 0; border-bottom:1px solid var(--border); font-size:0.8rem;';
    div.innerHTML = `
      <div>
        <strong>${escHtml(s.title)}</strong>
        <div style="color:var(--text-muted); font-size:0.75rem;">${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})} — ${s.duration_minutes}min</div>
      </div>
      <button style="width:auto; padding:0.2rem 0.4rem; font-size:0.75rem; min-height:auto; background:transparent; color:var(--text-muted); border:none; cursor:pointer;" onclick="deleteEvent(${s.id})">✕</button>
    `;
    list.appendChild(div);
  });
}

async function addEvent() {
  const category = document.getElementById('sched-category').value;
  const custom = document.getElementById('sched-custom-title').value.trim();
  const datetime = document.getElementById('sched-datetime').value;
  const duration = parseInt(document.getElementById('sched-duration').value, 10) || 60;
  if (!datetime) { alert('Please select a date and time'); return; }
  const title = custom || category;
  if (!title) return;

  // Build recurrence rule from form
  const repeatKind = document.getElementById('sched-repeat')?.value || '';
  let recurrenceRule = null;
  if (repeatKind === 'DAILY') recurrenceRule = 'DAILY';
  else if (repeatKind === 'WEEKLY') {
    const days = Array.from(document.querySelectorAll('#sched-repeat-weekly input[type=checkbox]:checked')).map(c => c.value);
    if (days.length === 0) { alert('Pick at least one day for weekly repeat'); return; }
    recurrenceRule = 'WEEKLY:' + days.join(',');
  } else if (repeatKind === 'MONTHLY') {
    // Use day-of-month from the picked datetime
    const d = new Date(datetime);
    recurrenceRule = 'MONTHLY:' + d.getDate();
  }
  const recurrenceUntilEl = document.getElementById('sched-until');
  const recurrenceUntil = recurrenceUntilEl?.value || null;
  const timezone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();

  await fetch(`/api/orgs/${orgSlug}/rooms/${room}/schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title, startsAt: new Date(datetime).toISOString(), durationMinutes: duration,
      recurrenceRule, recurrenceUntil, timezone,
    })
  });
  document.getElementById('sched-custom-title').value = '';
  if (document.getElementById('sched-repeat')) document.getElementById('sched-repeat').value = '';
  document.getElementById('sched-repeat-detail')?.classList.add('hidden');
  loadSchedule();
}
window.addEvent = addEvent;

// Wire up the Repeat dropdown to show/hide detail section
document.addEventListener('DOMContentLoaded', () => {
  const sel = document.getElementById('sched-repeat');
  if (!sel) return;
  const detail = document.getElementById('sched-repeat-detail');
  const weekly = document.getElementById('sched-repeat-weekly');
  sel.addEventListener('change', () => {
    if (sel.value) {
      detail.classList.remove('hidden');
      detail.style.display = 'flex';
    } else {
      detail.classList.add('hidden');
      detail.style.display = 'none';
    }
    if (weekly) {
      if (sel.value === 'WEEKLY') weekly.classList.remove('hidden');
      else weekly.classList.add('hidden');
    }
  });
});

async function deleteEvent(id) {
  await fetch(`/api/orgs/${orgSlug}/schedule/${id}`, { method: 'DELETE' });
  loadSchedule();
}
window.deleteEvent = deleteEvent;

// Toggle recordings collapse
let recsCollapsed = true;
function toggleRecordings() {
  const list = document.getElementById('recordings-mgmt-list');
  const chevron = document.getElementById('rec-chevron');
  recsCollapsed = !recsCollapsed;
  list.style.display = recsCollapsed ? 'none' : 'block';
  chevron.style.transform = recsCollapsed ? '' : 'rotate(180deg)';
}
window.toggleRecordings = toggleRecordings;

// Recordings management
async function loadRecordings() {
  try {
    const res = await fetch(`/api/orgs/${orgSlug}/broadcaster/recordings/${room}`);
    if (!res.ok) return;
    const recs = await res.json();
    const card = document.getElementById('recordings-mgmt-card');
    const list = document.getElementById('recordings-mgmt-list');
    if (recs.length === 0) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    document.getElementById('rec-count').textContent = `(${recs.length})`;
    list.innerHTML = '';
    recs.forEach(r => {
      const d = new Date(r.recorded_at);
      const dateStr = d.toLocaleDateString();
      const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const mins = Math.floor(r.duration_seconds / 60);
      const defaultTitle = `${dateStr} ${timeStr} — ${mins}min`;
      const div = document.createElement('div');
      div.style.cssText = 'padding:0.5rem 0; border-bottom:1px solid var(--border); font-size:0.85rem;';
      div.innerHTML = `
        <div style="display:flex; align-items:center; gap:0.5rem;">
          <div style="flex:1;">
            <input type="text" value="${escHtml(r.title || '')}" placeholder="${defaultTitle}"
              data-id="${r.id}" class="rec-title-input"
              style="width:100%; padding:0.3rem 0.5rem; background:var(--bg); border:1px solid var(--border); border-radius:var(--radius); color:var(--text); font-size:0.8rem; font-family:inherit;">
          </div>
          <button class="rec-toggle-pub btn-stop" data-id="${r.id}" data-pub="${r.published}"
            style="width:auto; padding:0.3rem 0.6rem; font-size:0.75rem; min-height:auto; color:${r.published ? 'var(--accent)' : 'var(--text-muted)'};">
            ${r.published ? '● Public' : '○ Private'}
          </button>
          <button class="rec-delete" data-id="${r.id}"
            style="width:auto; padding:0.3rem 0.5rem; font-size:0.75rem; min-height:auto; background:transparent; color:var(--text-muted); border:1px solid var(--border); border-radius:var(--radius); cursor:pointer;"
            title="Delete (file archived)">✕</button>
        </div>
        <div style="font-size:0.7rem; color:var(--text-muted); margin-top:0.2rem; padding-inline-start:0.5rem;">
          ${defaultTitle}${r.published ? ' · <a href="/recordings/' + encodeURIComponent(orgSlug) + '/' + encodeURIComponent(r.filename) + '" target="_blank" style="color:var(--accent);">Listen</a>' : ''}
        </div>
      `;
      const input = div.querySelector('.rec-title-input');
      let debounce;
      input.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(async () => {
          await fetch(`/api/recordings/${r.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: input.value.trim() })
          });
        }, 500);
      });
      const toggleBtn = div.querySelector('.rec-toggle-pub');
      toggleBtn.addEventListener('click', async () => {
        const isPub = toggleBtn.dataset.pub === '1';
        const endpoint = isPub ? 'unpublish' : 'publish';
        const title = input.value.trim();
        await fetch(`/api/recordings/${r.id}/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title })
        });
        loadRecordings();
      });
      const delBtn = div.querySelector('.rec-delete');
      delBtn.addEventListener('click', async () => {
        if (!confirm('Remove this recording? The audio file is still archived on the server.')) return;
        await fetch(`/api/recordings/${r.id}`, { method: 'DELETE' });
        loadRecordings();
      });
      list.appendChild(div);
    });
  } catch {}
}

// Listener list
function renderListenerList(names, total) {
  const list = document.getElementById('listeners-list');
  if (!list) return;
  list.innerHTML = '';
  if (!names || names.length === 0) { list.innerHTML = '<span style="font-size:0.8rem;color:var(--text-muted);">No listeners yet</span>'; return; }
  names.forEach(name => {
    const chip = document.createElement('span');
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:0.15rem;padding:0.2rem 0.5rem;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-pill);margin:0.1rem;font-size:0.75rem;';
    chip.innerHTML = `<span style="width:18px;height:18px;border-radius:50%;background:var(--accent);color:white;font-size:0.55rem;font-weight:700;display:flex;align-items:center;justify-content:center;text-transform:uppercase;">${escHtml(name[0])}</span><span style="color:var(--text-muted);">${escHtml(name)}</span>`;
    list.appendChild(chip);
  });
  if (total > names.length) {
    const more = document.createElement('span');
    more.style.cssText = 'font-size:0.75rem;color:var(--text-muted);padding:0.2rem 0.4rem;';
    more.textContent = `+${total - names.length} more`;
    list.appendChild(more);
  }
}

// Lazy-fetch listener names. Broadcaster auths via session cookie — no
// X-Room-Password header needed (server bypasses password gate for this org).
// Polls every 10s while panel is expanded so the broadcaster sees joins/leaves
// without waiting for status events.
let _listenersPoll = null;
async function fetchListeners() {
  if (!room) return;
  try {
    const orgPath = window._orgSlug || (window.location.pathname.replace(/^\//, '').split('/')[0] || 'default');
    const res = await fetch(`/api/orgs/${encodeURIComponent(orgPath)}/rooms/${encodeURIComponent(room)}/listeners`);
    if (!res.ok) return;
    const data = await res.json();
    renderListenerList(data.names, data.count);
  } catch {}
}

document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('listeners-toggle');
  const list = document.getElementById('listeners-list');
  if (!toggle || !list) return;
  toggle.addEventListener('click', () => {
    list.classList.toggle('hidden');
    if (!list.classList.contains('hidden')) {
      fetchListeners();
      if (_listenersPoll) clearInterval(_listenersPoll);
      _listenersPoll = setInterval(fetchListeners, 10000);
    } else if (_listenersPoll) {
      clearInterval(_listenersPoll);
      _listenersPoll = null;
    }
  });
});

// ===== Chat disable toggle =====
const chatToggleBtn = document.getElementById('chat-toggle-btn');
const chatInputRow = document.getElementById('chat-input-row');
let chatDisabledLocal = false;

function applyChatDisabled(disabled) {
  chatDisabledLocal = !!disabled;
  if (chatToggleBtn) {
    chatToggleBtn.textContent = disabled ? 'Enable chat' : 'Disable chat';
    chatToggleBtn.setAttribute('aria-pressed', disabled ? 'true' : 'false');
  }
  if (chatInputRow) chatInputRow.style.display = disabled ? 'none' : '';
  if (chatText) chatText.disabled = !!disabled;
  if (chatSend) chatSend.disabled = !!disabled;
}

chatToggleBtn?.addEventListener('click', async () => {
  const next = !chatDisabledLocal;
  chatToggleBtn.disabled = true;
  try {
    const orgPath = window._orgSlug || (window.location.pathname.replace(/^\//, '').split('/')[0] || 'default');
    const res = await fetch(`/api/orgs/${encodeURIComponent(orgPath)}/rooms/${encodeURIComponent(room)}/chat-toggle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: next }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || 'Could not toggle chat');
    }
    // Server will broadcast a status payload that updates UI via applyChatDisabled
  } finally {
    chatToggleBtn.disabled = false;
  }
});

// If room was pre-selected via URL, initBroadcast was already called from the page script
// If not, we wait for the room picker to call initBroadcast

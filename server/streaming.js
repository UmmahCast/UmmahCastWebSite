const fs = require('fs');
const path = require('path');
const { getRoomState, broadcastToRoom, statusPayload, getRoom, addRecording, logAnalytics } = require('./rooms');
const { notifyLive, notifyTelegram } = require('./push');
const { notifyEmailSubscribers } = require('./email');
const { MAX_LISTENERS_PER_ROOM } = require('./config');
const db = require('./db');
const chatFilter = require('./chat-filter');

const BACKPRESSURE_THRESHOLD = 1024 * 64;
const RECORDINGS_DIR = require('./config').RECORDINGS_DIR || path.join(__dirname, '..', 'recordings');
const HEARTBEAT_INTERVAL = 30000;

if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// Room-password brute-force throttle: cap FAILED join-password attempts per client IP in a
// sliding window. The per-IP connection cap alone doesn't stop guessing (a rejected socket
// closes and frees its slot), so a private room's audio could be brute-forced. Successful
// joins don't count against the limit.
const _pwFails = new Map(); // ip -> { count, resetAt }
const PW_FAIL_MAX = 10;
const PW_FAIL_WINDOW_MS = 5 * 60 * 1000;
function _tooManyPwFails(ip) {
  if (!ip) return false;
  const e = _pwFails.get(ip);
  return !!e && Date.now() <= e.resetAt && e.count >= PW_FAIL_MAX;
}
function _recordPwFail(ip) {
  if (!ip) return;
  const now = Date.now();
  const e = _pwFails.get(ip);
  if (!e || now > e.resetAt) _pwFails.set(ip, { count: 1, resetAt: now + PW_FAIL_WINDOW_MS });
  else e.count++;
}
// Sweep expired entries so the map can't grow unbounded from one-off guessers.
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of _pwFails) if (now > e.resetAt) _pwFails.delete(ip);
}, PW_FAIL_WINDOW_MS).unref?.();

function handleConnection(ws, req, user, clientIp) {
  let roomSlug = null;
  let orgId = null;
  let clientName = user?.displayName || 'Anonymous';
  let recordingStream = null;
  let recordingFile = null;
  let recordingStart = null;
  let joinedAt = null;

  const isBroadcaster = user?.role === 'broadcaster';
  let assignedRole = null;
  // Synchronous latch: the message handler is async (it awaits the room-password KDF), so two
  // 'join' frames could otherwise both pass the assignedRole guard before either sets it. Set
  // this before the first await to make join strictly single-shot even under interleaving.
  let joinHandled = false;

  let alive = true;
  let heartbeatTimer = null;

  function startHeartbeat() {
    heartbeatTimer = setInterval(() => {
      if (!alive) { console.log(`[stream] Broadcaster heartbeat timeout`); ws.terminate(); return; }
      alive = false;
      ws.ping();
    }, HEARTBEAT_INTERVAL);
  }

  ws.on('pong', () => { alive = true; });

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      if (assignedRole !== 'broadcaster') return;

      const state = getRoomState(orgId, roomSlug);

      if (!state.initSegment) {
        state.initSegment = Buffer.from(data);

        if (!state.notified) {
          state.notified = true;
          const roomInfo = getRoom(roomSlug, orgId);
          notifyLive(roomInfo?.name || roomSlug, user?.displayName || 'Someone', orgId).catch(() => {});
          notifyTelegram(roomInfo?.name || roomSlug, orgId).catch(() => {});
          notifyEmailSubscribers(roomInfo?.name || roomSlug, orgId, roomSlug).catch(() => {});
          console.log(`[stream] Notifications sent for ${roomSlug} (org:${orgId})`);
        }
      }

      if (recordingStream) {
        try { recordingStream.write(Buffer.from(data)); }
        catch (err) { console.error('[record] Write error:', err.message); }
      }

      let dropped = 0;
      for (const [listener] of state.listeners) {
        if (listener.readyState !== 1) continue;
        if (listener.bufferedAmount > BACKPRESSURE_THRESHOLD) {
          listener.close(4001, 'Too slow');
          state.listeners.delete(listener);
          dropped++;
          continue;
        }
        listener.send(data, { binary: true });
      }
      // Emit at most ONE status update per media frame, only if we culled someone —
      // not a DB query + full-room broadcast per slow listener inside the hot loop.
      if (dropped > 0) broadcastToRoom(orgId, roomSlug, statusPayload(orgId, roomSlug));
      return;
    }

    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'join') {
      // Single-shot: a second join on the same socket would re-fire side effects and could
      // leave one socket registered as both a listener and the broadcaster.
      if (assignedRole || joinHandled) { ws.send(JSON.stringify({ type: 'error', message: 'Already joined' })); return; }
      joinHandled = true;
      roomSlug = msg.room || 'main';

      // Resolve org from message or user
      if (msg.orgId) {
        orgId = parseInt(msg.orgId, 10);
      } else if (msg.orgSlug) {
        const org = db.prepare('SELECT id FROM organizations WHERE slug = ?').get(msg.orgSlug);
        orgId = org?.id;
      } else if (user?.orgId) {
        orgId = user.orgId;
      }

      if (!orgId) {
        // Fallback to default org
        const def = db.prepare('SELECT id FROM organizations WHERE slug = ?').get('default');
        orgId = def?.id || 1;
      }

      const dbRoom = getRoom(roomSlug, orgId);
      if (!dbRoom) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
        ws.close();
        return;
      }

      const state = getRoomState(orgId, roomSlug);

      if (isBroadcaster && msg.role === 'broadcaster') {
        // Enforce the same mandatory-2FA grace the HTTP mutating routes enforce
        // (enforce2faGracePeriod in index.js). Going live is the single most sensitive
        // mutating action — without this gate a stolen password for a never-enrolled,
        // past-grace account could broadcast even though every HTTP admin route returns 403.
        if (require('./auth').is2faGraceExpired(user)) {
          ws.send(JSON.stringify({ type: 'error', message: '2FA setup required before you can broadcast. Enable it in Settings.', code: 'MUST_ENABLE_2FA' }));
          ws.close();
          return;
        }
        // Verify broadcaster belongs to this org (or is superadmin)
        if (!user.isSuperadmin && user.orgId !== orgId) {
          ws.send(JSON.stringify({ type: 'error', message: 'Not authorized for this organization' }));
          ws.close();
          return;
        }

        if (state.broadcaster && state.broadcaster !== ws) {
          if (state.broadcaster.readyState === 1) {
            ws.send(JSON.stringify({ type: 'error', message: 'Room already has a broadcaster' }));
            ws.close();
            return;
          }
          // Stale/closing socket still registered: force it down so its (async) close handler
          // becomes a no-op under the identity guard below, closing the takeover race window.
          try { state.broadcaster.terminate(); } catch {}
        }

        assignedRole = 'broadcaster';
        state.broadcaster = ws;
        state.broadcasterUser = user;
        // Room is NOT live yet — broadcaster is just connected/ready
        state.initSegment = null;
        state.reactions = { dua: 0, mosque: 0, tasbih: 0, crescent: 0 };
        state.notified = false;

        startHeartbeat();
        ws.send(JSON.stringify({ type: 'ready' }));
        console.log(`[stream] Broadcaster connected to ${roomSlug} (org:${orgId}) — waiting for go-live`);

      } else {
        if (dbRoom.password) {
          if (_tooManyPwFails(clientIp)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Too many attempts — try again later' }));
            ws.close(1013, 'Rate limited');
            return;
          }
          // Async KDF — keeps the scrypt work off the event loop so unauthenticated join
          // floods on a password-protected room can't starve the whole process.
          const ok = await require('./auth').verifyPasswordAsync(String(msg.password || ''), dbRoom.password);
          if (!ok) {
            _recordPwFail(clientIp);
            ws.send(JSON.stringify({ type: 'error', message: 'Incorrect room password' }));
            ws.close();
            return;
          }
        }

        if (state.listeners.size >= MAX_LISTENERS_PER_ROOM) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
          // 1013 "Try Again Later" (RFC 6455). Lets clients distinguish
          // capacity from network blip and back off accordingly.
          ws.close(1013, 'Room is full');
          return;
        }

        assignedRole = 'listener';
        if (msg.displayName) clientName = sanitizeText(msg.displayName, 30);
        joinedAt = Date.now();
        state.listeners.set(ws, { displayName: clientName, joinedAt: Date.now() });
        // Heartbeat listeners too (not just broadcasters): a half-open TCP connection that never
        // sends a FIN would otherwise hold a room-capacity slot indefinitely. A missed pong now
        // terminates the socket, firing 'close' which frees the slot.
        startHeartbeat();
        broadcastToRoom(orgId, roomSlug, statusPayload(orgId, roomSlug));
        logAnalytics(roomSlug, orgId, 'listener_join', 1);
        logAnalytics(roomSlug, orgId, 'listener_count', state.listeners.size);
        console.log(`[stream] ${clientName} joined ${roomSlug} (org:${orgId}, ${state.listeners.size} total)`);

        if (state.initSegment) {
          ws.send(JSON.stringify({ type: 'init-segment' }));
          ws.send(state.initSegment, { binary: true });
        }

        const dbRoom2 = getRoom(roomSlug, orgId);
        if (dbRoom2) {
          ws.send(JSON.stringify({
            type: 'branding',
            accentColor: dbRoom2.accent_color,
            logoUrl: dbRoom2.logo_url,
            description: dbRoom2.description,
          }));
        }
      }

    } else if (msg.type === 'go-live' && assignedRole === 'broadcaster') {
      const state = getRoomState(orgId, roomSlug);
      if (state.live) return; // Already live

      state.live = true;
      state.startedAt = new Date().toISOString();

      // Start recording
      const orgSlugVal = db.prepare('SELECT slug FROM organizations WHERE id = ?').get(orgId)?.slug || 'default';
      const recDir = path.join(RECORDINGS_DIR, orgSlugVal);
      if (!fs.existsSync(recDir)) fs.mkdirSync(recDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      recordingFile = `${roomSlug}_${ts}.webm`;
      recordingStream = fs.createWriteStream(path.join(recDir, recordingFile));
      // A writable stream emits 'error' asynchronously (ENOSPC disk full, EROFS, volume
      // unmounted mid-broadcast); an unhandled stream 'error' is rethrown as an uncaught
      // exception and would crash the whole process. Drop the recording and keep streaming.
      recordingStream.on('error', (err) => {
        console.error(`[record] Stream error for ${orgSlugVal}/${recordingFile}:`, err.message);
        try { recordingStream && recordingStream.destroy(); } catch {}
        recordingStream = null; // the binary handler's `if (recordingStream)` guard stops further writes
      });
      recordingStart = Date.now();

      broadcastToRoom(orgId, roomSlug, statusPayload(orgId, roomSlug));
      logAnalytics(roomSlug, orgId, 'broadcast_start', 1);
      console.log(`[stream] Broadcaster went LIVE in ${roomSlug} (org:${orgId})`);

    } else if (msg.type === 'stop' && assignedRole === 'broadcaster') {
      stopBroadcast(orgId, roomSlug, recordingStream, recordingFile, recordingStart, ws);
      recordingStream = null;
      recordingFile = null;
      // Keep the heartbeat running: the socket stays open and registered as the broadcaster
      // after stop, so its liveness ping must continue. It's cleared only on 'close'. Without
      // this, a stopped-but-connected broadcaster that then dies silently locks the room.

    } else if (msg.type === 'chat') {
      handleChat(ws, orgId, roomSlug, clientName, msg);

    } else if (msg.type === 'reaction') {
      handleReaction(ws, orgId, roomSlug, msg.reaction);
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeatTimer);
    if (!roomSlug || !orgId) return;
    const state = getRoomState(orgId, roomSlug);

    if (assignedRole === 'broadcaster' && state.broadcaster === ws) {
      // Only act if THIS socket is still the current broadcaster. A stale/replaced socket's
      // (async) close must not tear down the broadcaster B that already took over the room.
      if (state.live) {
        stopBroadcast(orgId, roomSlug, recordingStream, recordingFile, recordingStart, null);
        recordingStream = null;
        state.live = false;
        state.startedAt = null;
        state.initSegment = null;
        for (const [listener] of state.listeners) {
          if (listener.readyState === 1) listener.send(JSON.stringify({ type: 'stream-ended' }));
        }
      }
      state.broadcaster = null;
      state.broadcasterUser = null;
      broadcastToRoom(orgId, roomSlug, statusPayload(orgId, roomSlug));
      console.log(`[stream] Broadcaster disconnected from ${roomSlug} (org:${orgId})`);
    } else if (assignedRole === 'listener') {
      state.listeners.delete(ws);
      broadcastToRoom(orgId, roomSlug, statusPayload(orgId, roomSlug));
      logAnalytics(roomSlug, orgId, 'listener_count', state.listeners.size);
      if (joinedAt) {
        const minutes = Math.floor((Date.now() - joinedAt) / 60000);
        if (minutes > 0) logAnalytics(roomSlug, orgId, 'listen_minutes', minutes);
      }
      console.log(`[stream] Listener left ${roomSlug} (org:${orgId}, ${state.listeners.size} total)`);
    }
  });

  ws.on('error', (err) => { console.error('[ws] Error:', err.message); });
}

function stopBroadcast(orgId, roomSlug, recordingStream, recordingFile, recordingStart, broadcasterWs) {
  const state = getRoomState(orgId, roomSlug);
  state.live = false;
  state.startedAt = null;
  state.initSegment = null;
  let recordingId = null;

  if (recordingStream) {
    recordingStream.end();
    const duration = Math.floor((Date.now() - (recordingStart || Date.now())) / 1000);
    const orgSlug = db.prepare('SELECT slug FROM organizations WHERE id = ?').get(orgId)?.slug || 'default';
    const filePath = path.join(RECORDINGS_DIR, orgSlug, recordingFile);
    try {
      const stats = fs.statSync(filePath);
      // Skip ghost recordings (too short or 0 bytes)
      if (stats.size < 1024 || duration < 10) {
        try { fs.unlinkSync(filePath); } catch {}
        console.log(`[record] Discarded ghost recording ${orgSlug}/${recordingFile} (${stats.size}b, ${duration}s)`);
      } else {
        recordingId = addRecording(roomSlug, orgId, recordingFile, stats.size, duration);
        console.log(`[record] Saved ${orgSlug}/${recordingFile} (${duration}s, id=${recordingId})`);
      }
    } catch {}
  }

  for (const [listener] of state.listeners) {
    if (listener.readyState === 1) listener.send(JSON.stringify({ type: 'stream-ended' }));
  }
  broadcastToRoom(orgId, roomSlug, statusPayload(orgId, roomSlug));

  if (broadcasterWs?.readyState === 1 && recordingId) {
    broadcasterWs.send(JSON.stringify({
      type: 'recording-ready', recordingId, filename: recordingFile,
      duration: Math.floor((Date.now() - (recordingStart || Date.now())) / 1000),
    }));
  }
}

function sanitizeText(text, maxLen) {
  // Strip HTML tags + bidi/zero-width/control chars (impersonation/RTL-spoof defense)
  return String(text)
    .replace(/<[^>]*>/g, '')
    .replace(/[ -­​-‏‪-‮⁦-⁩]/g, '')
    .trim()
    .slice(0, maxLen || 500);
}

const chatLimits = new WeakMap();
function handleChat(ws, orgId, roomSlug, senderName, msg) {
  if (!roomSlug || !msg.text || typeof msg.text !== 'string') return;
  const text = sanitizeText(msg.text, 500);
  if (!text) return;

  // Per-room broadcaster kill-switch
  const room = db.prepare('SELECT chat_disabled FROM rooms WHERE slug = ? AND org_id = ?').get(roomSlug, orgId);
  if (room?.chat_disabled) {
    ws.send(JSON.stringify({ type: 'error', message: 'Chat is disabled in this room' }));
    return;
  }

  let limits = chatLimits.get(ws);
  if (!limits) { limits = []; chatLimits.set(ws, limits); }
  const now = Date.now();
  limits.push(now);
  while (limits.length > 0 && limits[0] < now - 10000) limits.shift();
  if (limits.length > 5) { ws.send(JSON.stringify({ type: 'error', message: 'Slow down' })); return; }

  // Word-boundary moderation: hits get asterisked, original is logged for review.
  const { text: cleaned, hits } = chatFilter.filter(text);
  if (hits.length > 0) {
    console.log(`[chat-filter] org=${orgId} room=${roomSlug} sender=${senderName} hits=${hits.join(',')} original=${JSON.stringify(text)}`);
  }
  broadcastToRoom(orgId, roomSlug, { type: 'chat', user: sanitizeText(senderName, 30), text: cleaned, ts: now });
}

const VALID_REACTIONS = ['dua', 'mosque', 'tasbih', 'crescent'];
const reactionLimits = new WeakMap();
function handleReaction(ws, orgId, roomSlug, reaction) {
  if (!roomSlug || !VALID_REACTIONS.includes(reaction)) return;
  const state = getRoomState(orgId, roomSlug);
  if (!state.live) return;

  // Per-listener rate limit — same 5-per-10s bucket as chat. Reactions amplify
  // (one inbound = one outbound to every listener), so flood-prevention is critical.
  let limits = reactionLimits.get(ws);
  if (!limits) { limits = []; reactionLimits.set(ws, limits); }
  const now = Date.now();
  limits.push(now);
  while (limits.length > 0 && limits[0] < now - 10000) limits.shift();
  if (limits.length > 5) return; // silently drop; no need to alert client

  state.reactions[reaction]++;
  broadcastToRoom(orgId, roomSlug, { type: 'reaction', reaction, count: state.reactions[reaction] });
}

module.exports = { handleConnection };

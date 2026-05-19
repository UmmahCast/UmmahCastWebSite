const db = require('./db');

const liveRooms = new Map();

function roomKey(orgId, slug) { return `${orgId}:${slug}`; }

function getRoomState(orgId, slug) {
  const key = roomKey(orgId, slug);
  if (!liveRooms.has(key)) {
    liveRooms.set(key, {
      broadcaster: null,
      broadcasterUser: null,
      listeners: new Map(), // ws => { displayName, joinedAt }
      initSegment: null,
      live: false,
      startedAt: null,
      reactions: { dua: 0, mosque: 0, tasbih: 0, crescent: 0 },
      notified: false,
    });
  }
  return liveRooms.get(key);
}

// Organizations
function listOrgs() {
  return db.prepare('SELECT * FROM organizations ORDER BY name').all();
}

function getOrg(slug) {
  return db.prepare('SELECT * FROM organizations WHERE slug = ?').get(slug);
}

function getOrgById(id) {
  return db.prepare('SELECT * FROM organizations WHERE id = ?').get(id);
}

// Atomic — org row + default room + default categories all commit or all roll back.
const _createOrgTx = db.transaction((slug, name) => {
  db.prepare('INSERT INTO organizations (slug, name) VALUES (?, ?)').run(slug, name);
  const org = db.prepare('SELECT * FROM organizations WHERE slug = ?').get(slug);
  db.prepare('INSERT INTO rooms (slug, name, org_id) VALUES (?, ?, ?)').run('main', 'Main Hall', org.id);
  const defaults = ['Morning Awrad', 'Dalail al-Khayrat', 'Talim', 'Jumu\'ah Khutbah', 'Quran Recitation', 'Dhikr', 'Halaqa', 'Taraweeh', 'General'];
  const ins = db.prepare('INSERT OR IGNORE INTO event_categories (name, org_id) VALUES (?, ?)');
  for (const cat of defaults) ins.run(cat, org.id);
  return org;
});
function createOrg(slug, name) { return _createOrgTx(slug, name); }

const ALLOWED_ORG_COLS = { name: 'name', accent_color: 'accent_color', logo_url: 'logo_url', description: 'description', telegram_chat_id: 'telegram_chat_id' };
const ALLOWED_ROOM_COLS = { name: 'name', password: 'password', accent_color: 'accent_color', logo_url: 'logo_url', description: 'description', chat_disabled: 'chat_disabled' };

function updateOrg(slug, updates) {
  const fields = [];
  const values = [];
  for (const [key, val] of Object.entries(updates)) {
    if (!ALLOWED_ORG_COLS[key]) continue;
    fields.push(`${ALLOWED_ORG_COLS[key]} = ?`);
    values.push(val);
  }
  if (fields.length === 0) return;
  values.push(slug);
  db.prepare(`UPDATE organizations SET ${fields.join(', ')} WHERE slug = ?`).run(...values);
}

// Atomic — all related rows go together or not at all.
const _deleteOrgRowsTx = db.transaction((orgId) => {
  db.prepare('DELETE FROM schedules WHERE org_id = ?').run(orgId);
  db.prepare('DELETE FROM recordings WHERE org_id = ?').run(orgId);
  db.prepare('DELETE FROM analytics WHERE org_id = ?').run(orgId);
  db.prepare('DELETE FROM event_categories WHERE org_id = ?').run(orgId);
  db.prepare('DELETE FROM push_subscriptions WHERE org_id = ?').run(orgId);
  db.prepare('DELETE FROM email_subscribers WHERE org_id = ?').run(orgId);
  db.prepare('DELETE FROM rooms WHERE org_id = ?').run(orgId);
  db.prepare('DELETE FROM broadcasters WHERE org_id = ?').run(orgId);
  db.prepare('DELETE FROM organizations WHERE id = ?').run(orgId);
});

// Hard immediate delete — DB rows + (after archive) recordings folder.
// Used internally by executeOrgDeletion. Not exposed directly to admin UI; admin must go through request/execute flow.
function deleteOrg(slug) {
  if (slug === 'default') return false;
  const org = getOrg(slug);
  if (!org) return false;
  _deleteOrgRowsTx(org.id);
  return true;
}

// ===== Org deletion archive flow =====
// Build a zip containing all of an org's recordings + a JSON manifest of org metadata,
// rooms, schedules, recordings list, and broadcasters (no password hashes).
// Returns a Promise that resolves to { archivePath, sizeBytes, recordingCount }.
function archiveOrg(orgId) {
  const fs = require('fs');
  const path = require('path');
  const archiver = require('archiver');
  const RECORDINGS_DIR = require('./config').RECORDINGS_DIR || path.join(__dirname, '..', 'recordings');

  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
  if (!org) return Promise.reject(new Error('Org not found'));

  const archivesDir = path.join(RECORDINGS_DIR, '_archives');
  fs.mkdirSync(archivesDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const archivePath = path.join(archivesDir, `${org.slug}-${ts}.zip`);

  // Path-resolve guard — confirm we'd write inside RECORDINGS_DIR
  const resolvedArchive = path.resolve(archivePath);
  const resolvedBase = path.resolve(RECORDINGS_DIR) + path.sep;
  if (!resolvedArchive.startsWith(resolvedBase)) return Promise.reject(new Error('Archive path escapes recordings dir'));

  const manifest = {
    archivedAt: new Date().toISOString(),
    org: { slug: org.slug, name: org.name, description: org.description, created_at: org.created_at },
    rooms: db.prepare('SELECT slug, name, description FROM rooms WHERE org_id = ?').all(orgId),
    schedules: db.prepare('SELECT * FROM schedules WHERE org_id = ?').all(orgId),
    recordings: db.prepare('SELECT id, room_slug, filename, title, size_bytes, duration_seconds, recorded_at, published FROM recordings WHERE org_id = ? AND size_bytes > 0').all(orgId),
    broadcasters: db.prepare('SELECT username, display_name, created_at FROM broadcasters WHERE org_id = ?').all(orgId),
    categories: db.prepare('SELECT name FROM event_categories WHERE org_id = ?').all(orgId),
  };

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(archivePath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', () => {
      resolve({ archivePath, sizeBytes: archive.pointer(), recordingCount: manifest.recordings.length });
    });
    archive.on('error', err => reject(err));
    archive.on('warning', err => { if (err.code !== 'ENOENT') reject(err); });

    archive.pipe(output);
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

    // Add the org's recording folder (if it exists)
    const orgRecDir = path.join(RECORDINGS_DIR, org.slug);
    const resolvedRecDir = path.resolve(orgRecDir);
    if (resolvedRecDir.startsWith(resolvedBase) && fs.existsSync(orgRecDir)) {
      archive.directory(orgRecDir, 'recordings');
    }
    archive.finalize();
  });
}

// Begin the soft-delete flow: archive everything, store token + path on the org row,
// caller should email the broadcaster the download link before scheduling actual deletion.
async function requestOrgDeletion(slug) {
  const org = getOrg(slug);
  if (!org) return { ok: false, error: 'Not found' };
  if (slug === 'default') return { ok: false, error: 'Cannot delete the default org' };
  if (org.pending_deletion_at) return { ok: false, error: 'Deletion already requested' };

  const result = await archiveOrg(org.id);
  const crypto = require('crypto');
  const archiveToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    UPDATE organizations
    SET pending_deletion_at = datetime('now'),
        archive_token = ?, archive_path = ?, archive_expires_at = ?
    WHERE id = ?
  `).run(archiveToken, result.archivePath, expiresAt, org.id);

  return { ok: true, archiveToken, archivePath: result.archivePath, sizeBytes: result.sizeBytes, recordingCount: result.recordingCount };
}

// Cancel the pending deletion + remove the archive zip from disk.
function cancelOrgDeletion(slug) {
  const org = getOrg(slug);
  if (!org || !org.pending_deletion_at) return false;
  const fs = require('fs');
  const path = require('path');
  const RECORDINGS_DIR = require('./config').RECORDINGS_DIR || path.join(__dirname, '..', 'recordings');
  const resolvedBase = path.resolve(RECORDINGS_DIR) + path.sep;
  if (org.archive_path) {
    const resolved = path.resolve(org.archive_path);
    if (resolved.startsWith(resolvedBase)) {
      try { fs.unlinkSync(resolved); } catch {}
    }
  }
  db.prepare('UPDATE organizations SET pending_deletion_at = NULL, archive_token = NULL, archive_path = NULL, archive_expires_at = NULL WHERE id = ?').run(org.id);
  return true;
}

// Execute the actual deletion — DB rows + recordings folder. Refuses if no pending state.
function executeOrgDeletion(slug) {
  const org = getOrg(slug);
  if (!org) return { ok: false, error: 'Not found' };
  if (slug === 'default') return { ok: false, error: 'Cannot delete the default org' };
  if (!org.pending_deletion_at) return { ok: false, error: 'No deletion has been requested for this org' };

  const fs = require('fs');
  const path = require('path');
  const RECORDINGS_DIR = require('./config').RECORDINGS_DIR || path.join(__dirname, '..', 'recordings');
  const resolvedBase = path.resolve(RECORDINGS_DIR) + path.sep;

  // Drop DB rows first (atomic)
  _deleteOrgRowsTx(org.id);

  // Then remove recordings dir (with path-resolve guard)
  const orgRecDir = path.join(RECORDINGS_DIR, org.slug);
  const resolvedRecDir = path.resolve(orgRecDir);
  if (resolvedRecDir.startsWith(resolvedBase) && fs.existsSync(orgRecDir)) {
    try { fs.rmSync(orgRecDir, { recursive: true, force: true }); } catch (err) { console.error('[org-delete] rmRecDir failed:', err.message); }
  }

  // Archive zip cleanup deferred to its 7-day expiry sweep — leaves a window for re-download

  return { ok: true };
}

// Verify a download token + return the archive path (for streaming response).
// Single-use enforcement is handled by the route handler clearing the token after successful stream.
function getOrgArchive(slug, token) {
  const org = db.prepare('SELECT * FROM organizations WHERE slug = ? AND archive_token = ?').get(slug, token);
  if (!org) return null;
  if (org.archive_expires_at && new Date(org.archive_expires_at).getTime() < Date.now()) return null;
  return { archivePath: org.archive_path, orgSlug: org.slug, orgName: org.name };
}

// Mark archive token consumed (called after successful download)
function consumeOrgArchiveToken(slug) {
  db.prepare('UPDATE organizations SET archive_token = NULL WHERE slug = ?').run(slug);
}

// Periodic sweep: expired archives get unlinked. Run via setInterval from index.js boot.
function sweepExpiredArchives() {
  const fs = require('fs');
  const path = require('path');
  const RECORDINGS_DIR = require('./config').RECORDINGS_DIR || path.join(__dirname, '..', 'recordings');
  const resolvedBase = path.resolve(RECORDINGS_DIR) + path.sep;
  const expired = db.prepare("SELECT id, slug, archive_path FROM organizations WHERE archive_path IS NOT NULL AND archive_expires_at IS NOT NULL AND archive_expires_at < datetime('now')").all();
  for (const o of expired) {
    if (o.archive_path) {
      const resolved = path.resolve(o.archive_path);
      if (resolved.startsWith(resolvedBase)) {
        try { fs.unlinkSync(resolved); } catch {}
      }
    }
    db.prepare('UPDATE organizations SET archive_path = NULL, archive_token = NULL, archive_expires_at = NULL WHERE id = ?').run(o.id);
  }
}

// Privacy: hard cap on initials surfaced on cards. Do NOT raise.
// See plan slice 5 — initials are derived from user-typed display names that
// are already broadcast within the room; capping at 4 keeps the card preview
// consistent with social-proof intent without bulk-leaking room participation.
const INITIALS_CAP = 4;

function deriveListenerInitials(state) {
  if (!state || !state.listeners) return [];
  const out = [];
  for (const v of state.listeners.values()) {
    const name = (v?.displayName || '').trim();
    if (!name || name.toLowerCase() === 'anonymous') continue;
    const ch = name.charAt(0).toUpperCase();
    out.push(ch);
    if (out.length >= INITIALS_CAP) break;
  }
  return out;
}

// Rooms
function listRooms(orgId) {
  const dbRooms = db.prepare('SELECT * FROM rooms WHERE org_id = ? ORDER BY id').all(orgId);
  return dbRooms.map(r => {
    const state = liveRooms.get(roomKey(orgId, r.slug));
    const nextShow = db.prepare(
      "SELECT * FROM schedules WHERE room_slug = ? AND org_id = ? AND starts_at > datetime('now') ORDER BY starts_at LIMIT 1"
    ).get(r.slug, orgId);
    return {
      id: r.id, slug: r.slug, name: r.name,
      description: r.description, accentColor: r.accent_color, logoUrl: r.logo_url,
      hasPassword: !!r.password,
      live: state?.live || false,
      listeners: state?.listeners.size || 0,
      listenerInitials: deriveListenerInitials(state),
      startedAt: state?.startedAt || null,
      nextShow: nextShow ? { title: nextShow.title, startsAt: nextShow.starts_at, duration: nextShow.duration_minutes } : null,
    };
  });
}

function getRoom(slug, orgId) {
  if (!orgId) return null;
  return db.prepare('SELECT * FROM rooms WHERE slug = ? AND org_id = ?').get(slug, orgId);
}

function createRoom(slug, name, password, orgId) {
  // Hash room passwords at rest — prior plaintext storage meant DB dump = every room password exposed.
  // Uses scrypt via existing auth helpers; same salt:hash format as broadcaster passwords.
  const hashed = password ? require('./auth').hashPassword(password) : null;
  db.prepare('INSERT INTO rooms (slug, name, password, org_id) VALUES (?, ?, ?, ?)').run(slug, name, hashed, orgId);
  return getRoom(slug, orgId);
}

function updateRoom(slug, orgId, updates) {
  const fields = [];
  const values = [];
  for (const [key, val] of Object.entries(updates)) {
    if (!ALLOWED_ROOM_COLS[key]) continue;
    // Hash room passwords at rest; null/empty stays null (clears the password)
    const stored = (key === 'password' && val) ? require('./auth').hashPassword(val) : val;
    fields.push(`${ALLOWED_ROOM_COLS[key]} = ?`);
    values.push(stored);
  }
  if (fields.length === 0) return;
  values.push(slug, orgId);
  db.prepare(`UPDATE rooms SET ${fields.join(', ')} WHERE slug = ? AND org_id = ?`).run(...values);
}

function deleteRoom(slug, orgId) {
  if (slug === 'main') return false;
  db.prepare('DELETE FROM schedules WHERE room_slug = ? AND org_id = ?').run(slug, orgId);
  db.prepare('DELETE FROM recordings WHERE room_slug = ? AND org_id = ?').run(slug, orgId);
  db.prepare('DELETE FROM analytics WHERE room_slug = ? AND org_id = ?').run(slug, orgId);
  db.prepare('DELETE FROM rooms WHERE slug = ? AND org_id = ?').run(slug, orgId);
  const key = roomKey(orgId, slug);
  if (liveRooms.has(key)) liveRooms.delete(key);
  return true;
}

// Schedules
const RECURRENCE_RE = /^(DAILY|WEEKLY:(MON|TUE|WED|THU|FRI|SAT|SUN)(,(MON|TUE|WED|THU|FRI|SAT|SUN))*|MONTHLY:-?\d{1,2})$/;
const DAY_INDEX = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function addSchedule(roomSlug, orgId, title, startsAt, durationMinutes, recurrenceRule, recurrenceUntil, timezone) {
  let rule = null;
  if (recurrenceRule && RECURRENCE_RE.test(recurrenceRule)) rule = recurrenceRule;
  let until = null;
  if (recurrenceUntil) {
    const d = new Date(recurrenceUntil);
    if (!isNaN(d.getTime())) {
      const cap = new Date(); cap.setFullYear(cap.getFullYear() + 5);
      if (d > cap) until = cap.toISOString();
      else until = d.toISOString();
    }
  }
  const tz = isValidTimezone(timezone) ? timezone : 'UTC';
  db.prepare('INSERT INTO schedules (room_slug, org_id, title, starts_at, duration_minutes, recurrence_rule, recurrence_until, timezone) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    roomSlug, orgId, title, startsAt, durationMinutes || 60, rule, until, tz
  );
}

// Get hour/minute/second of a UTC ISO timestamp as observed in a given IANA timezone
function _timeOfDayInTZ(utcIso, tz) {
  try {
    const d = new Date(utcIso);
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = Object.fromEntries(fmt.formatToParts(d).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
    return { h: parseInt(parts.hour, 10) % 24, m: parseInt(parts.minute, 10), s: parseInt(parts.second, 10) || 0 };
  } catch { return { h: 0, m: 0, s: 0 }; }
}

// Convert a date+time-of-day in a TZ to a UTC Date object
function _localToUTC(year, month, day, h, m, s, tz) {
  // Strategy: use Intl to compute the UTC offset for that local moment; iterate twice to handle DST
  // First guess: treat the local components as UTC, then measure difference between that "wall" and the actual rendering
  let guess = new Date(Date.UTC(year, month - 1, day, h, m, s));
  for (let i = 0; i < 2; i++) {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const parts = Object.fromEntries(fmt.formatToParts(guess).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
    const wall = Date.UTC(
      parseInt(parts.year, 10), parseInt(parts.month, 10) - 1, parseInt(parts.day, 10),
      parseInt(parts.hour, 10) % 24, parseInt(parts.minute, 10), parseInt(parts.second, 10) || 0
    );
    const target = Date.UTC(year, month - 1, day, h, m, s);
    const offsetMs = wall - target;
    if (offsetMs === 0) return guess;
    guess = new Date(guess.getTime() - offsetMs);
  }
  return guess;
}

// Expand a single schedule row into upcoming occurrences (UTC ISO strings)
function _expandRow(row, fromUtcMs, count) {
  const tz = row.timezone || 'UTC';
  const baseDate = new Date(row.starts_at);
  const tod = _timeOfDayInTZ(row.starts_at, tz);
  const occ = [];
  const untilMs = row.recurrence_until ? new Date(row.recurrence_until).getTime() : Infinity;

  if (!row.recurrence_rule) {
    if (baseDate.getTime() >= fromUtcMs) occ.push(baseDate.toISOString());
    return occ;
  }

  // Walk day by day from the later of (base date, fromUtcMs) and emit matching occurrences
  const startMs = Math.max(baseDate.getTime(), fromUtcMs);
  // Convert startMs to a local date in tz
  const startLocalParts = (() => {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit' });
    const p = Object.fromEntries(fmt.formatToParts(new Date(startMs)).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
    return { y: parseInt(p.year, 10), m: parseInt(p.month, 10), d: parseInt(p.day, 10) };
  })();

  let cursor = new Date(Date.UTC(startLocalParts.y, startLocalParts.m - 1, startLocalParts.d));
  const safety = 800;  // max iterations to avoid runaway

  function pushIfMatches(year, month, day) {
    const utc = _localToUTC(year, month, day, tod.h, tod.m, tod.s, tz);
    if (utc.getTime() >= fromUtcMs && utc.getTime() <= untilMs) occ.push(utc.toISOString());
  }

  if (row.recurrence_rule === 'DAILY') {
    for (let i = 0; i < safety && occ.length < count; i++) {
      const y = cursor.getUTCFullYear(), m = cursor.getUTCMonth() + 1, d = cursor.getUTCDate();
      pushIfMatches(y, m, d);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  } else if (row.recurrence_rule.startsWith('WEEKLY:')) {
    const days = row.recurrence_rule.slice('WEEKLY:'.length).split(',').map(d => DAY_INDEX[d]).filter(d => d !== undefined);
    for (let i = 0; i < safety && occ.length < count; i++) {
      const dow = cursor.getUTCDay();  // 0=Sunday in UTC; we treat the local date the same
      if (days.includes(dow)) {
        pushIfMatches(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate());
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  } else if (row.recurrence_rule.startsWith('MONTHLY:')) {
    const dom = parseInt(row.recurrence_rule.slice('MONTHLY:'.length), 10);
    for (let i = 0; i < safety && occ.length < count; i++) {
      const y = cursor.getUTCFullYear(), m = cursor.getUTCMonth() + 1;
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const day = dom < 0 ? Math.max(1, lastDay + dom + 1) : Math.min(dom, lastDay);
      const candidate = new Date(Date.UTC(y, m - 1, day));
      if (candidate.getTime() >= cursor.getTime()) {
        pushIfMatches(y, m, day);
      }
      // Move to first of next month
      cursor = new Date(Date.UTC(y, m, 1));
    }
  }

  return occ;
}

function getSchedules(roomSlug, orgId) {
  const rows = db.prepare(
    "SELECT * FROM schedules WHERE room_slug = ? AND org_id = ? ORDER BY starts_at"
  ).all(roomSlug, orgId);

  const fromUtcMs = Date.now();
  const expanded = [];
  for (const row of rows) {
    const occ = _expandRow(row, fromUtcMs, 8);
    for (const startsAt of occ) {
      expanded.push({
        id: row.id,
        room_slug: row.room_slug,
        org_id: row.org_id,
        title: row.title,
        starts_at: startsAt,
        duration_minutes: row.duration_minutes,
        recurrence_rule: row.recurrence_rule,
        timezone: row.timezone,
        recurring: !!row.recurrence_rule,
      });
    }
  }
  expanded.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  return expanded.slice(0, 8);
}

function deleteSchedule(id, orgId) {
  db.prepare('DELETE FROM schedules WHERE id = ? AND org_id = ?').run(id, orgId);
}

// Recordings
function addRecording(roomSlug, orgId, filename, sizeBytes, durationSeconds) {
  const result = db.prepare('INSERT INTO recordings (room_slug, org_id, filename, size_bytes, duration_seconds, published) VALUES (?, ?, ?, ?, ?, 0)').run(
    roomSlug, orgId, filename, sizeBytes, durationSeconds
  );
  return result.lastInsertRowid;
}

// All recording mutations require either a matching org_id or superadmin privilege.
// Returns true if a row changed; false if not found / not authorized.
function publishRecording(id, title, orgId, isSuperadmin) {
  const r = db.prepare(
    'UPDATE recordings SET published = 1, title = ? WHERE id = ? AND (org_id = ? OR ?)'
  ).run(title || null, id, orgId || -1, isSuperadmin ? 1 : 0);
  return r.changes > 0;
}

function unpublishRecording(id, orgId, isSuperadmin) {
  const r = db.prepare(
    'UPDATE recordings SET published = 0 WHERE id = ? AND (org_id = ? OR ?)'
  ).run(id, orgId || -1, isSuperadmin ? 1 : 0);
  return r.changes > 0;
}

function updateRecordingTitle(id, title, orgId, isSuperadmin) {
  const r = db.prepare(
    'UPDATE recordings SET title = ? WHERE id = ? AND (org_id = ? OR ?)'
  ).run(title, id, orgId || -1, isSuperadmin ? 1 : 0);
  return r.changes > 0;
}

function deleteRecording(id, orgId, isSuperadmin) {
  // Look up first to ensure ownership before delete; do NOT touch the file (per design — keep for accidents).
  const rec = db.prepare('SELECT * FROM recordings WHERE id = ? AND (org_id = ? OR ?)').get(id, orgId || -1, isSuperadmin ? 1 : 0);
  if (!rec) return false;
  db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
  return true;
}

function getRecordings(roomSlug, orgId, includeUnpublished) {
  if (includeUnpublished) {
    return db.prepare('SELECT * FROM recordings WHERE room_slug = ? AND org_id = ? ORDER BY recorded_at DESC').all(roomSlug, orgId);
  }
  return db.prepare('SELECT * FROM recordings WHERE room_slug = ? AND org_id = ? AND published = 1 ORDER BY recorded_at DESC').all(roomSlug, orgId);
}

// Categories
function getCategories(orgId, includeInternal) {
  const cats = db.prepare('SELECT * FROM event_categories WHERE org_id = ? ORDER BY name').all(orgId);
  if (includeInternal) return cats;
  return cats.map(c => ({ id: c.id, name: c.name }));
}

function addCategory(name, orgId) {
  db.prepare('INSERT INTO event_categories (name, org_id) VALUES (?, ?)').run(name.trim(), orgId);
}

function deleteCategory(id, orgId) {
  db.prepare('DELETE FROM event_categories WHERE id = ? AND org_id = ?').run(id, orgId);
}

// Analytics
function logAnalytics(roomSlug, orgId, event, value) {
  db.prepare('INSERT INTO analytics (room_slug, org_id, event, value) VALUES (?, ?, ?, ?)').run(roomSlug, orgId, event, value || 0);
}

function getAnalyticsSummary(roomSlug, orgId) {
  const last30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const peak = db.prepare('SELECT MAX(value) as peak FROM analytics WHERE room_slug = ? AND org_id = ? AND event = ? AND ts > ?').get(roomSlug, orgId, 'listener_count', last30d);
  const totalMinutes = db.prepare('SELECT SUM(value) as total FROM analytics WHERE room_slug = ? AND org_id = ? AND event = ? AND ts > ?').get(roomSlug, orgId, 'listen_minutes', last30d);
  const broadcasts = db.prepare('SELECT COUNT(*) as count FROM analytics WHERE room_slug = ? AND org_id = ? AND event = ? AND ts > ?').get(roomSlug, orgId, 'broadcast_start', last30d);
  return {
    peakListeners: peak?.peak || 0,
    totalListenMinutes: totalMinutes?.total || 0,
    broadcastCount: broadcasts?.count || 0,
  };
}

// Broadcast helpers
function broadcastToRoom(orgId, slug, message) {
  const state = getRoomState(orgId, slug);
  const data = typeof message === 'string' ? message : JSON.stringify(message);
  try {
    if (state.broadcaster?.readyState === 1) state.broadcaster.send(data);
  } catch (err) {
    console.error('[broadcast] Error sending to broadcaster:', err.message);
  }
  for (const [ws] of state.listeners) {
    try {
      if (ws.readyState === 1) ws.send(data);
    } catch (err) {
      console.error('[broadcast] Error sending to listener:', err.message);
    }
  }
}

function statusPayload(orgId, slug) {
  const state = getRoomState(orgId, slug);
  const names = [];
  for (const meta of state.listeners.values()) {
    names.push(meta.displayName || 'Anonymous');
    if (names.length >= 20) break;
  }
  const room = db.prepare('SELECT chat_disabled FROM rooms WHERE slug = ? AND org_id = ?').get(slug, orgId);
  // listenerNames intentionally omitted from status broadcasts — clients fetch
  // it on demand from /api/orgs/:orgSlug/rooms/:slug/listeners when they
  // expand the "Who's Listening" panel. Keeps status frames small (≤150 bytes)
  // even at high listener counts.
  return {
    type: 'status',
    room: slug,
    live: state.live,
    listeners: state.listeners.size,
    startedAt: state.startedAt,
    reactions: state.reactions,
    chatDisabled: !!room?.chat_disabled,
  };
}

// Same projection used by the lazy-fetch HTTP endpoint:
// ≤20 names, anonymous excluded, plus the total + truncation flag.
function listenerNamesFor(orgId, slug) {
  const state = getRoomState(orgId, slug);
  const names = [];
  for (const meta of state.listeners.values()) {
    const n = meta.displayName || 'Anonymous';
    if (n === 'Anonymous') continue;
    names.push(n);
    if (names.length >= 20) break;
  }
  return { names, count: state.listeners.size, truncated: state.listeners.size > names.length };
}

module.exports = {
  getRoomState, listRooms, getRoom, createRoom, updateRoom, deleteRoom,
  broadcastToRoom, statusPayload, listenerNamesFor,
  addSchedule, getSchedules, deleteSchedule,
  addRecording, getRecordings, publishRecording, unpublishRecording, updateRecordingTitle, deleteRecording,
  getCategories, addCategory, deleteCategory,
  logAnalytics, getAnalyticsSummary,
  listOrgs, getOrg, getOrgById, createOrg, updateOrg, deleteOrg,
  archiveOrg, requestOrgDeletion, cancelOrgDeletion, executeOrgDeletion, getOrgArchive, consumeOrgArchiveToken, sweepExpiredArchives,
};

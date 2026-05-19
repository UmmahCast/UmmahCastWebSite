const crypto = require('crypto');
const db = require('./db');
const { COOKIE_NAME, SESSION_SECRET, SESSION_MAX_AGE } = require('./config');
const cookieSignature = require('cookie-signature');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  if (hash.length !== check.length) return false;
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

function createBroadcaster(username, password, displayName, orgId) {
  const passwordHash = hashPassword(password);
  const result = db.prepare('INSERT INTO broadcasters (username, password_hash, display_name, org_id) VALUES (?, ?, ?, ?)').run(
    username.toLowerCase().trim(), passwordHash, displayName.trim(), orgId || null
  );
  return result.lastInsertRowid;
}

// Extended creator: sets account_type and is_org_leader atomically.
// accountType: 'individual' | 'shared'. isLeader: boolean.
function createIndividualBroadcaster(username, password, displayName, orgId, accountType, isLeader) {
  const passwordHash = hashPassword(password);
  const type = accountType === 'shared' ? 'shared' : 'individual';
  const leader = isLeader && type === 'individual' ? 1 : 0;
  const result = db.prepare(`
    INSERT INTO broadcasters (username, password_hash, display_name, org_id, account_type, is_org_leader)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(username.toLowerCase().trim(), passwordHash, displayName.trim(), orgId || null, type, leader);
  return result.lastInsertRowid;
}

function getBroadcastersByOrg(orgId) {
  return db.prepare(`
    SELECT id, username, display_name, account_type, is_org_leader, totp_enabled, first_login_at, created_at, is_superadmin
    FROM broadcasters
    WHERE org_id = ?
    ORDER BY is_org_leader DESC, created_at ASC
  `).all(orgId);
}

const _transferLeadershipTx = db.transaction((orgId, fromId, toId) => {
  // Verify both broadcasters belong to this org
  const from = db.prepare('SELECT id, account_type, is_org_leader, org_id FROM broadcasters WHERE id = ?').get(fromId);
  const to = db.prepare('SELECT id, account_type, org_id FROM broadcasters WHERE id = ?').get(toId);
  if (!from || from.org_id !== orgId || !from.is_org_leader) throw new Error('Source is not the current leader of this org');
  if (!to || to.org_id !== orgId) throw new Error('Target is not in this org');
  if (to.account_type === 'shared') throw new Error('Cannot promote a shared account to leader');
  if (fromId === toId) throw new Error('Cannot transfer to self');
  // Demote first to satisfy partial unique index, then promote
  db.prepare('UPDATE broadcasters SET is_org_leader = 0 WHERE id = ?').run(fromId);
  db.prepare('UPDATE broadcasters SET is_org_leader = 1 WHERE id = ?').run(toId);
});

function transferOrgLeadership(orgId, fromBroadcasterId, toBroadcasterId) {
  try { _transferLeadershipTx(orgId, fromBroadcasterId, toBroadcasterId); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
}

const _forceSetLeaderTx = db.transaction((orgId, broadcasterId) => {
  const target = db.prepare('SELECT id, account_type, org_id FROM broadcasters WHERE id = ?').get(broadcasterId);
  if (!target || target.org_id !== orgId) throw new Error('Broadcaster not in this org');
  if (target.account_type === 'shared') throw new Error('Cannot promote a shared account to leader');
  // Clear any existing leader, then set new one
  db.prepare('UPDATE broadcasters SET is_org_leader = 0 WHERE org_id = ? AND is_org_leader = 1').run(orgId);
  db.prepare('UPDATE broadcasters SET is_org_leader = 1 WHERE id = ?').run(broadcasterId);
});

function forceSetOrgLeader(orgId, broadcasterId) {
  try { _forceSetLeaderTx(orgId, broadcasterId); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
}

// Emergency password reset — superadmin only.
// Generates a one-time temp password (URL-safe), hashes it, sets must_change_password=1,
// terminates all existing sessions for the broadcaster. Returns the plaintext temp
// password to the caller — it is NEVER persisted in plaintext anywhere.
function adminResetPassword(broadcasterId) {
  const target = db.prepare('SELECT id, username, is_superadmin FROM broadcasters WHERE id = ?').get(broadcasterId);
  if (!target) return { ok: false, error: 'Broadcaster not found' };
  if (target.is_superadmin) return { ok: false, error: 'Cannot reset password for a superadmin via this route' };
  // 12 chars, URL-safe base64 (no +/=) so they're easy to read/type
  const tempPassword = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
  const passwordHash = hashPassword(tempPassword);
  db.prepare('UPDATE broadcasters SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(passwordHash, broadcasterId);
  // Kick any active sessions — the temp password should be the ONLY way back in
  db.prepare('DELETE FROM sessions WHERE broadcaster_id = ?').run(broadcasterId);
  return { ok: true, tempPassword, username: target.username };
}

// Emergency 2FA disable — superadmin only. Irreversible (no secret backup).
// Broadcaster must re-enroll from scratch on next visit to settings.
function adminDisableTotp(broadcasterId) {
  const target = db.prepare('SELECT id, username, totp_enabled, is_superadmin FROM broadcasters WHERE id = ?').get(broadcasterId);
  if (!target) return { ok: false, error: 'Broadcaster not found' };
  if (target.is_superadmin) return { ok: false, error: 'Cannot disable 2FA for a superadmin via this route' };
  if (!target.totp_enabled) return { ok: false, error: '2FA is not enabled for this broadcaster' };
  db.prepare('UPDATE broadcasters SET totp_secret = NULL, totp_enabled = 0, totp_backup_codes = NULL WHERE id = ?').run(broadcasterId);
  return { ok: true, username: target.username };
}

function deleteBroadcaster(broadcasterId, requesterId) {
  const target = db.prepare('SELECT id, org_id, is_org_leader, is_superadmin FROM broadcasters WHERE id = ?').get(broadcasterId);
  if (!target) return { ok: false, error: 'Not found' };
  if (target.is_superadmin) return { ok: false, error: 'Cannot delete a superadmin via this route' };
  if (broadcasterId === requesterId) return { ok: false, error: 'You cannot delete your own account' };
  if (target.is_org_leader) return { ok: false, error: 'Transfer leadership before deleting this account' };
  // Last broadcaster protection — keep at least one broadcaster per org so the org isn't orphaned
  const remaining = db.prepare('SELECT COUNT(*) AS c FROM broadcasters WHERE org_id = ? AND id != ?').get(target.org_id, broadcasterId).c;
  if (remaining === 0) return { ok: false, error: 'Cannot delete the last broadcaster in an org. Delete the org via the archive flow if you want to remove it entirely.' };
  // Clean up sessions then the row
  db.prepare('DELETE FROM sessions WHERE broadcaster_id = ?').run(broadcasterId);
  db.prepare('DELETE FROM broadcasters WHERE id = ?').run(broadcasterId);
  return { ok: true };
}

// Broadcaster invites — email-based onboarding for team members
function createBroadcasterInvite({ orgId, email, displayName, accountType, invitedById }) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const type = accountType === 'shared' ? 'shared' : 'individual';
  // For 'shared': only one allowed per org (partial unique index will block duplicates after consumption,
  // but we should also pre-check active invites + existing accounts).
  if (type === 'shared') {
    const existingShared = db.prepare("SELECT id FROM broadcasters WHERE org_id = ? AND account_type = 'shared'").get(orgId);
    if (existingShared) return { ok: false, error: 'This org already has a shared account.' };
    const pendingShared = db.prepare("SELECT id FROM broadcaster_invites WHERE org_id = ? AND account_type = 'shared' AND consumed_at IS NULL AND invite_expires_at > datetime('now')").get(orgId);
    if (pendingShared) return { ok: false, error: 'A shared-account invite is already pending for this org.' };
  }
  db.prepare(`
    INSERT INTO broadcaster_invites (org_id, invited_email, invited_display_name, account_type, invited_by, invite_token, invite_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(orgId, email.toLowerCase().trim(), displayName.trim(), type, invitedById || null, token, expiresAt);
  return { ok: true, token, expiresAt };
}

function getBroadcasterInvite(token) {
  const row = db.prepare(`
    SELECT bi.*, o.slug AS org_slug, o.name AS org_name,
           b.display_name AS inviter_display_name
    FROM broadcaster_invites bi
    JOIN organizations o ON o.id = bi.org_id
    LEFT JOIN broadcasters b ON b.id = bi.invited_by
    WHERE bi.invite_token = ?
  `).get(token);
  if (!row) return null;
  return row;
}

const _consumeBroadcasterInviteTx = db.transaction((token, username, password) => {
  const row = db.prepare("SELECT * FROM broadcaster_invites WHERE invite_token = ?").get(token);
  if (!row) throw new Error('Invitation not found');
  if (row.consumed_at) throw new Error('This invitation has already been used');
  if (new Date(row.invite_expires_at).getTime() < Date.now()) throw new Error('This invitation has expired');
  // Create the broadcaster row (NOT a leader — leaders only come from org-application bootstrap or transfer)
  const newId = createIndividualBroadcaster(username, password, row.invited_display_name, row.org_id, row.account_type, false);
  db.prepare("UPDATE broadcaster_invites SET consumed_at = datetime('now') WHERE id = ?").run(row.id);
  return { broadcasterId: newId, orgId: row.org_id, accountType: row.account_type };
});

function consumeBroadcasterInvite(token, username, password) {
  try {
    return { ok: true, ...(_consumeBroadcasterInviteTx(token, username, password)) };
  } catch (err) {
    if (err && /UNIQUE constraint failed: broadcasters\.username/i.test(err.message)) {
      return { ok: false, error: 'Username already exists. Please pick another.' };
    }
    return { ok: false, error: err.message || 'Could not complete setup' };
  }
}

function loginBroadcaster(username, password) {
  const user = db.prepare('SELECT * FROM broadcasters WHERE username = ?').get(username.toLowerCase().trim());
  if (!user || !verifyPassword(password, user.password_hash)) return null;
  return createSession(user.id);
}

// Two-stage login (TOTP-aware). Returns:
//  { ok: true, sessionToken } — no 2FA, login complete
//  { ok: true, totpRequired: true, loginToken } — 2FA enabled, need code
//  null — bad credentials
const _pendingTotpLogins = new Map();  // loginToken -> { broadcasterId, expiresAt }
function _markFirstLogin(broadcasterId) {
  // Sets first_login_at if currently NULL — starts the 2FA grace clock
  db.prepare("UPDATE broadcasters SET first_login_at = datetime('now') WHERE id = ? AND first_login_at IS NULL").run(broadcasterId);
}

function loginBroadcasterStage1(username, password) {
  const user = db.prepare('SELECT * FROM broadcasters WHERE username = ?').get(username.toLowerCase().trim());
  if (!user || !verifyPassword(password, user.password_hash)) return null;
  if (user.totp_enabled) {
    const loginToken = crypto.randomBytes(32).toString('hex');
    _pendingTotpLogins.set(loginToken, { broadcasterId: user.id, expiresAt: Date.now() + 5 * 60 * 1000 });
    return { ok: true, totpRequired: true, loginToken };
  }
  const sessionToken = createSession(user.id);
  _markFirstLogin(user.id);
  return { ok: true, sessionToken };
}

// Periodic cleanup of expired pending logins
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _pendingTotpLogins.entries()) if (v.expiresAt < now) _pendingTotpLogins.delete(k);
}, 60 * 1000);

function consumePendingTotpLogin(loginToken) {
  const entry = _pendingTotpLogins.get(loginToken);
  if (!entry) return null;
  _pendingTotpLogins.delete(loginToken);
  if (entry.expiresAt < Date.now()) return null;
  return entry.broadcasterId;
}

function getBroadcaster(id) {
  return db.prepare('SELECT * FROM broadcasters WHERE id = ?').get(id);
}

function setTotpEnabled(broadcasterId, secret, backupCodesHashed) {
  db.prepare('UPDATE broadcasters SET totp_secret = ?, totp_enabled = 1, totp_backup_codes = ? WHERE id = ?').run(secret, JSON.stringify(backupCodesHashed), broadcasterId);
}

function setTotpDisabled(broadcasterId) {
  db.prepare('UPDATE broadcasters SET totp_secret = NULL, totp_enabled = 0, totp_backup_codes = NULL WHERE id = ?').run(broadcasterId);
}

function consumeBackupCode(broadcasterId, plainCode) {
  const user = getBroadcaster(broadcasterId);
  if (!user || !user.totp_backup_codes) return false;
  let codes;
  try { codes = JSON.parse(user.totp_backup_codes); } catch { return false; }
  if (!Array.isArray(codes)) return false;
  for (let i = 0; i < codes.length; i++) {
    if (verifyPassword(plainCode, codes[i])) {
      codes.splice(i, 1);
      db.prepare('UPDATE broadcasters SET totp_backup_codes = ? WHERE id = ?').run(JSON.stringify(codes), broadcasterId);
      return true;
    }
  }
  return false;
}

function createSession(broadcasterId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE).toISOString();
  db.prepare('INSERT INTO sessions (token, broadcaster_id, expires_at) VALUES (?, ?, ?)').run(token, broadcasterId, expiresAt);
  return token;
}

function getSession(token) {
  if (!token) return null;
  const session = db.prepare(`
    SELECT s.*, b.id as broadcaster_id, b.username, b.display_name, b.org_id, b.is_superadmin,
           o.slug as org_slug, o.name as org_name
    FROM sessions s
    JOIN broadcasters b ON s.broadcaster_id = b.id
    LEFT JOIN organizations o ON b.org_id = o.id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `).get(token);
  return session || null;
}

function parseCookie(req) {
  const raw = req.cookies?.[COOKIE_NAME];
  if (!raw) return null;
  const unsigned = cookieSignature.unsign(raw, SESSION_SECRET);
  return unsigned === false ? null : unsigned;
}

// Routes a broadcaster can hit while their must_change_password flag is set —
// password change, logout, self-info, TOS gate. Everything else is blocked
// at server level so a scripted/curl client can't bypass the SPA modal.
const PW_CHANGE_ALLOWED_PATHS = new Set([
  '/api/broadcaster/password',
  '/api/broadcaster/logout',
  '/api/broadcaster/me',
  '/api/broadcaster/tos',
  '/api/broadcaster/accept-tos',
]);

function broadcasterMiddleware(req, res, next) {
  const token = parseCookie(req);
  const session = getSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Broadcaster login required' });
  }
  // Pull the extended broadcaster row (session JOIN doesn't include role columns)
  const b = db.prepare('SELECT account_type, is_org_leader, totp_enabled, first_login_at, tos_accepted_version, tos_accepted_at, must_change_password FROM broadcasters WHERE id = ?').get(session.broadcaster_id) || {};
  req.broadcaster = {
    id: session.broadcaster_id,
    username: session.username,
    displayName: session.display_name,
    orgId: session.org_id,
    orgSlug: session.org_slug,
    orgName: session.org_name,
    isSuperadmin: !!session.is_superadmin,
    accountType: b.account_type || 'individual',
    isOrgLeader: !!b.is_org_leader,
    totpEnabled: !!b.totp_enabled,
    firstLoginAt: b.first_login_at || null,
    tosAcceptedVersion: b.tos_accepted_version || null,
    tosAcceptedAt: b.tos_accepted_at || null,
    mustChangePassword: !!b.must_change_password,
  };
  // Server-side gate: forced-rotation broadcasters can only use the allow-listed paths.
  // SPA shows a blocking modal via password-gate.js; this stops scripted bypass.
  if (req.broadcaster.mustChangePassword && !PW_CHANGE_ALLOWED_PATHS.has(req.path)) {
    return res.status(403).json({ error: 'Password change required', code: 'PW_CHANGE_REQUIRED' });
  }
  next();
}

function authenticateWs(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const idx = c.indexOf('=');
    if (idx < 1) return;
    const k = c.slice(0, idx).trim();
    const v = c.slice(idx + 1).trim();
    if (k && v) cookies[k] = decodeURIComponent(v);
  });
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;
  const unsigned = cookieSignature.unsign(raw, SESSION_SECRET);
  if (unsigned === false) return null;
  const session = getSession(unsigned);
  if (!session) return null;
  return {
    id: session.broadcaster_id,
    username: session.username,
    displayName: session.display_name,
    role: 'broadcaster',
    orgId: session.org_id,
    orgSlug: session.org_slug,
    isSuperadmin: !!session.is_superadmin,
  };
}

// Clean expired sessions periodically
setInterval(() => {
  try { db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run(); } catch {}
}, 60 * 60 * 1000); // Every hour

function changePassword(userId, oldPassword, newPassword) {
  const user = db.prepare('SELECT * FROM broadcasters WHERE id = ?').get(userId);
  if (!user || !verifyPassword(oldPassword, user.password_hash)) return false;
  const newHash = hashPassword(newPassword);
  // Clear the must_change_password flag — the user has met the change requirement.
  db.prepare('UPDATE broadcasters SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(newHash, userId);
  return true;
}

function updateDisplayName(userId, displayName) {
  const clean = String(displayName).replace(/<[^>]*>/g, '').trim();
  db.prepare('UPDATE broadcasters SET display_name = ? WHERE id = ?').run(clean, userId);
}

function deleteSession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

module.exports = {
  createBroadcaster, loginBroadcaster, broadcasterMiddleware, authenticateWs,
  changePassword, updateDisplayName, deleteSession, parseCookie, getSession,
  loginBroadcasterStage1, consumePendingTotpLogin, getBroadcaster,
  setTotpEnabled, setTotpDisabled, consumeBackupCode, createSession,
  hashPassword, verifyPassword,
  createIndividualBroadcaster, getBroadcastersByOrg,
  transferOrgLeadership, forceSetOrgLeader, deleteBroadcaster,
  adminResetPassword, adminDisableTotp,
  createBroadcasterInvite, getBroadcasterInvite, consumeBroadcasterInvite,
  _markFirstLogin,
};

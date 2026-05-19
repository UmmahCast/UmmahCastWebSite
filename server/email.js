const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const { SMTP_FROM, SMTP_PROVIDERS } = require('./config');
const { notifyAdmin } = require('./push');
const db = require('./db');

// In-memory "already alerted today" tracking
const _alertedToday = new Set();
function alertOncePerDay(key, fn) {
  const today = new Date().toISOString().slice(0, 10);
  const alertKey = `${key}:${today}`;
  if (_alertedToday.has(alertKey)) return;
  _alertedToday.add(alertKey);
  // Cleanup old keys (keep last 7 days max)
  if (_alertedToday.size > 100) {
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    for (const k of _alertedToday) if (k.split(':').pop() < cutoff) _alertedToday.delete(k);
  }
  fn();
}

// Build nodemailer transports from config
const transports = SMTP_PROVIDERS.map(p => ({
  name: p.name,
  dailyLimit: p.dailyLimit,
  transport: nodemailer.createTransport({
    host: p.host,
    port: p.port,
    secure: p.port === 465,
    auth: { user: p.user, pass: p.pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  }),
}));

if (transports.length > 0) {
  console.log(`[email] ${transports.length} SMTP provider(s) loaded: ${transports.map(t => t.name + (t.dailyLimit ? ` (${t.dailyLimit}/day)` : '')).join(', ')}`);
} else {
  console.log('[email] No SMTP providers configured — email notifications disabled');
}

// Persistent daily counter helpers
function todayUTC() { return new Date().toISOString().slice(0, 10); }
function getSent(provider) {
  const row = db.prepare('SELECT sent FROM smtp_daily_counters WHERE provider = ? AND date = ?').get(provider, todayUTC());
  return row?.sent || 0;
}
function incrementSent(provider) {
  db.prepare(`
    INSERT INTO smtp_daily_counters (provider, date, sent) VALUES (?, ?, 1)
    ON CONFLICT(provider, date) DO UPDATE SET sent = sent + 1
  `).run(provider, todayUTC());
}

// Public: get today's send counts for admin/visibility
function getDailyStats() {
  const date = todayUTC();
  return transports.map(t => ({
    provider: t.name,
    sent: getSent(t.name),
    limit: t.dailyLimit,
    remaining: t.dailyLimit ? Math.max(0, t.dailyLimit - getSent(t.name)) : null,
    exhausted: t.dailyLimit ? getSent(t.name) >= t.dailyLimit : false,
  }));
}

// Send a single email through the chain (failover, with proactive limit skip)
async function sendEmail(to, subject, html, text) {
  if (transports.length === 0) return { ok: false, error: 'No SMTP providers configured' };

  for (const t of transports) {
    // Proactive skip if we know this provider is exhausted today
    if (t.dailyLimit) {
      const sent = getSent(t.name);
      if (sent >= t.dailyLimit) {
        // Skip silently, but log occasionally
        continue;
      }
    }
    try {
      const info = await t.transport.sendMail({ from: SMTP_FROM, to, subject, html, text });
      incrementSent(t.name);
      const sent = getSent(t.name);
      const limitStr = t.dailyLimit ? ` [${sent}/${t.dailyLimit}]` : '';
      console.log(`[email] Sent via ${t.name} to ${to} (${info.messageId})${limitStr}`);
      // Alert at 90% threshold (once per day per provider)
      if (t.dailyLimit && sent >= Math.floor(t.dailyLimit * 0.9) && sent < t.dailyLimit) {
        alertOncePerDay(`smtp-90-${t.name}`, () => {
          notifyAdmin(`SMTP provider *${t.name}* at ${sent}/${t.dailyLimit} (${Math.round(sent/t.dailyLimit*100)}%) — failover will kick in soon.`, 'warn');
        });
      }
      return { ok: true, provider: t.name, messageId: info.messageId };
    } catch (err) {
      console.warn(`[email] ${t.name} failed for ${to}: ${err.message}`);
    }
  }
  console.error(`[email] All providers failed/exhausted for ${to}`);
  alertOncePerDay('smtp-all-failed', () => {
    const stats = transports.map(t => `${t.name}: ${getSent(t.name)}/${t.dailyLimit || '∞'}`).join(', ');
    notifyAdmin(`*All SMTP providers exhausted or failing.* Email notifications are not being delivered.\n\nProvider state today: ${stats}`, 'critical');
  });
  return { ok: false, error: 'All SMTP providers failed or exhausted' };
}

// Email template wrapper — modern, dark/light mode aware, table-based for compatibility
function emailWrap({ previewText, body, token, includeFooter = true }) {
  const prefsUrl = token ? `https://ummahcast.com/preferences/${token}` : null;
  const unsubUrl = token ? `https://ummahcast.com/api/email/unsubscribe/${token}` : null;

  const footer = (token && includeFooter) ? `
    <tr>
      <td style="padding:24px 32px 12px;border-top:1px solid rgba(127,127,127,0.15);">
        <p style="margin:0;font-size:11px;line-height:1.6;color:#71717a;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
          🕌 <strong style="color:#2d8a4e;">UmmahCast</strong> — Mosque Live Audio
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:8px 32px 4px;">
        <p style="margin:0;font-size:11px;line-height:1.6;color:#71717a;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
          <a href="${prefsUrl}" style="color:#2d8a4e;text-decoration:none;font-weight:500;">Manage Preferences</a>
          &nbsp;·&nbsp;
          <a href="${unsubUrl}" style="color:#71717a;text-decoration:none;">Unsubscribe</a>
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:4px 32px 24px;">
        <p style="margin:0;font-size:10px;line-height:1.5;color:#9ca3af;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
          UmmahCast &middot; 1207 Delaware Ave #4061, Wilmington, DE 19806<br>
          You are receiving this because you subscribed to notifications at <a href="https://ummahcast.com" style="color:#9ca3af;text-decoration:underline;">ummahcast.com</a>.
        </p>
      </td>
    </tr>` : '';

  return `<!DOCTYPE html>
<html lang="en" style="margin:0;padding:0;">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>UmmahCast</title>
<style>
  @media (prefers-color-scheme: dark) {
    .uc-bg { background:#0f0f11 !important; }
    .uc-card { background:#1a1a1f !important; }
    .uc-text { color:#e4e4e7 !important; }
    .uc-muted { color:#a1a1aa !important; }
    .uc-divider { border-color:rgba(255,255,255,0.1) !important; }
  }
  a { color:#2d8a4e; }
</style>
</head>
<body class="uc-bg" style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <!-- Inbox preview text -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:transparent;">
    ${escapeHtml(previewText || '')}
    &nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
  </div>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="uc-bg" style="background:#f4f4f5;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="uc-card" style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">

          <!-- Header bar with gold accent -->
          <tr>
            <td style="height:4px;background:linear-gradient(90deg,#2d8a4e 0%,#c9a84c 100%);font-size:0;line-height:0;">&nbsp;</td>
          </tr>

          <!-- Brand block -->
          <tr>
            <td style="padding:28px 32px 8px;text-align:center;">
              <div style="font-size:13px;font-weight:700;letter-spacing:1.5px;color:#2d8a4e;text-transform:uppercase;">UmmahCast</div>
              <div style="margin-top:6px;font-size:18px;color:#c9a84c;font-style:italic;font-family:'Times New Roman',serif;">بسم الله الرحمن الرحيم</div>
            </td>
          </tr>

          <!-- Body content -->
          <tr>
            <td class="uc-text" style="padding:8px 32px 28px;color:#0f0f11;font-size:15px;line-height:1.6;">
              ${body}
            </td>
          </tr>

          ${footer}

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// Reusable CTA button (inline-friendly)
function ctaButton(href, text) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto;">
    <tr>
      <td style="background:linear-gradient(135deg,#2d8a4e 0%,#246e3e 100%);border-radius:999px;box-shadow:0 2px 8px rgba(45,138,78,0.3);">
        <a href="${href}" style="display:inline-block;padding:14px 32px;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;letter-spacing:0.3px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">${text}</a>
      </td>
    </tr>
  </table>`;
}

// Verification email (double opt-in)
async function sendVerificationEmail(email, token, orgName) {
  const verifyUrl = `https://ummahcast.com/api/email/verify/${token}`;
  const name = orgName || 'UmmahCast';
  const subject = `Verify your email — ${name}`;
  const body = `
    <p style="margin:0 0 12px;font-size:18px;font-weight:600;text-align:center;">As-salamu alaykum!</p>
    <p style="margin:0 0 20px;text-align:center;" class="uc-muted">You requested email notifications from <strong>${escapeHtml(name)}</strong>. Verify your email to start receiving alerts when broadcasts go live.</p>
    ${ctaButton(verifyUrl, 'Verify Email')}
    <p style="margin:20px 0 0;font-size:12px;text-align:center;color:#71717a;">If you didn't request this, you can safely ignore this email.</p>`;
  const html = emailWrap({
    previewText: `Tap to verify and start getting notifications from ${name}`,
    body,
    token,
    includeFooter: false,  // No prefs link before verification
  });
  const text = `As-salamu alaykum! Verify your email for ${name} notifications: ${verifyUrl}`;
  return sendEmail(email, subject, html, text);
}

// Go-live notification to one subscriber
async function sendLiveNotification(email, roomName, orgName, orgSlug, token) {
  const listenUrl = `https://ummahcast.com/${orgSlug || 'default'}`;
  const name = orgName || 'UmmahCast';
  const subject = `🔴 ${roomName} is live now — ${name}`;
  const body = `
    <div style="text-align:center;margin-bottom:8px;">
      <span style="display:inline-block;padding:4px 12px;background:#ef4444;color:#ffffff;font-size:11px;font-weight:700;letter-spacing:1px;border-radius:999px;text-transform:uppercase;">● Live</span>
    </div>
    <h1 style="margin:8px 0 4px;font-size:24px;font-weight:700;text-align:center;line-height:1.25;" class="uc-text">${escapeHtml(roomName)}</h1>
    <p style="margin:0 0 24px;text-align:center;font-size:14px;" class="uc-muted">is broadcasting now from <strong>${escapeHtml(name)}</strong></p>
    ${ctaButton(listenUrl, '🎧 Listen Now')}
    <p style="margin:20px 0 0;font-size:13px;text-align:center;color:#71717a;">Tap above to join the live audio stream — no app needed.</p>`;
  const html = emailWrap({
    previewText: `${roomName} is broadcasting now — tap to listen live`,
    body,
    token,
  });
  const text = `${roomName} is now live on ${name}!\nListen: ${listenUrl}\n\nManage preferences: https://ummahcast.com/preferences/${token}`;
  return sendEmail(email, subject, html, text);
}

// Daily digest email — multiple events combined
async function sendDigestEmail(email, orgName, orgSlug, items, token) {
  const listenUrl = `https://ummahcast.com/${orgSlug || 'default'}`;
  const name = orgName || 'UmmahCast';
  const count = items.length;
  const subject = `Your daily digest — ${count} broadcast${count === 1 ? '' : 's'} from ${name}`;
  const itemRows = items.map(it => {
    const time = new Date(it.occurred_at + 'Z').toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    return `<tr>
      <td style="padding:12px 0;border-bottom:1px solid rgba(127,127,127,0.12);" class="uc-divider">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td style="vertical-align:top;width:32px;font-size:18px;">🕌</td>
            <td>
              <div style="font-weight:600;font-size:14px;line-height:1.4;" class="uc-text">${escapeHtml(it.room_name)}</div>
              <div style="font-size:12px;color:#71717a;margin-top:2px;">${escapeHtml(time)}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
  }).join('');
  const body = `
    <h1 style="margin:0 0 4px;font-size:22px;font-weight:700;text-align:center;" class="uc-text">Daily Digest</h1>
    <p style="margin:0 0 20px;text-align:center;font-size:14px;" class="uc-muted">${count} broadcast${count === 1 ? '' : 's'} from <strong>${escapeHtml(name)}</strong></p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 24px;">
      ${itemRows}
    </table>
    ${ctaButton(listenUrl, 'Visit UmmahCast')}`;
  const html = emailWrap({
    previewText: `${count} broadcast${count === 1 ? '' : 's'} from ${name} today`,
    body,
    token,
  });
  const text = `Daily digest — ${count} broadcasts from ${name}:\n\n${items.map(i => `- ${i.room_name}`).join('\n')}\n\nManage preferences: https://ummahcast.com/preferences/${token}`;
  return sendEmail(email, subject, html, text);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Check if current time is within subscriber's quiet hours (in their timezone)
function inQuietHours(sub) {
  if (!sub.quiet_hours_start || !sub.quiet_hours_end) return false;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: sub.timezone || 'UTC',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const parts = fmt.formatToParts(new Date());
    const hh = parts.find(p => p.type === 'hour').value;
    const mm = parts.find(p => p.type === 'minute').value;
    const nowMin = parseInt(hh, 10) * 60 + parseInt(mm, 10);
    const [sh, sm] = sub.quiet_hours_start.split(':').map(Number);
    const [eh, em] = sub.quiet_hours_end.split(':').map(Number);
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    if (startMin === endMin) return false;
    if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
    return nowMin >= startMin || nowMin < endMin;  // wraps midnight
  } catch { return false; }
}

// Get current local hour for subscriber
function localHour(sub) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: sub.timezone || 'UTC',
      hour: '2-digit', hour12: false,
    });
    const parts = fmt.formatToParts(new Date());
    return parseInt(parts.find(p => p.type === 'hour').value, 10);
  } catch { return new Date().getUTCHours(); }
}

// Notify all eligible subscribers for an org+room going live
async function notifyEmailSubscribers(roomName, orgId, roomSlug) {
  const subscribers = db.prepare(`
    SELECT id, email, verify_token, frequency, quiet_hours_start, quiet_hours_end, timezone
    FROM email_subscribers
    WHERE org_id = ? AND verified = 1 AND unsubscribed_at IS NULL AND frequency != 'disabled'
  `).all(orgId);
  if (subscribers.length === 0) return;

  const org = db.prepare('SELECT slug, name FROM organizations WHERE id = ?').get(orgId);
  const orgName = org?.name || 'UmmahCast';
  const orgSlug2 = org?.slug || 'default';

  // Telegram-only fallback when no SMTP is configured
  if (transports.length === 0) {
    const emails = subscribers.map(s => s.email).join(', ');
    console.log(`[email] No SMTP configured — ${subscribers.length} subscriber(s) would be notified for ${orgName}`);
    try {
      const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = require('./config');
      if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
        const https = require('https');
        const text = `📧 *Email Subscribers Pending*\n\n${roomName} went live. ${subscribers.length} subscriber(s) would be notified but no SMTP configured.\n\n${emails}`;
        const postData = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' });
        const req = https.request({
          hostname: 'api.telegram.org',
          path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        }, () => {});
        req.on('error', () => {});
        req.write(postData);
        req.end();
      }
    } catch {}
    return;
  }

  const subRoomStmt = db.prepare('SELECT 1 FROM email_subscriber_rooms WHERE subscriber_id = ? AND room_slug = ?');
  const queueStmt = db.prepare('INSERT INTO email_digest_queue (subscriber_id, org_id, room_slug, room_name) VALUES (?, ?, ?, ?)');

  const tasks = [];
  let queued = 0;
  for (const sub of subscribers) {
    // Per-room opt-in check
    if (!subRoomStmt.get(sub.id, roomSlug)) continue;

    // Daily digest mode → queue
    if (sub.frequency === 'daily_digest') {
      queueStmt.run(sub.id, orgId, roomSlug, roomName);
      queued++;
      continue;
    }

    // Quiet hours → queue for digest tomorrow morning
    if (inQuietHours(sub)) {
      queueStmt.run(sub.id, orgId, roomSlug, roomName);
      queued++;
      continue;
    }

    tasks.push(sendLiveNotification(sub.email, roomName, orgName, orgSlug2, sub.verify_token));
  }

  console.log(`[email] ${roomSlug} live: sending ${tasks.length} instant, queuing ${queued} for digest`);

  if (tasks.length > 0) {
    const results = await Promise.allSettled(tasks);
    const sent = results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
    console.log(`[email] Go-live results: ${sent}/${tasks.length} sent`);
  }
}

// Send digests for any subscribers whose digest hour matches now (in their timezone)
async function sendDigests() {
  if (transports.length === 0) return;

  const subs = db.prepare(`
    SELECT s.id, s.email, s.verify_token, s.timezone, s.digest_hour, s.org_id, o.name AS org_name, o.slug AS org_slug
    FROM email_subscribers s
    JOIN organizations o ON s.org_id = o.id
    WHERE s.verified = 1 AND s.unsubscribed_at IS NULL
      AND (s.frequency = 'daily_digest' OR s.frequency = 'instant')
  `).all();

  for (const sub of subs) {
    if (localHour(sub) !== sub.digest_hour) continue;

    const items = db.prepare(`
      SELECT room_slug, room_name, occurred_at FROM email_digest_queue
      WHERE subscriber_id = ? ORDER BY occurred_at ASC
    `).all(sub.id);
    if (items.length === 0) continue;

    const result = await sendDigestEmail(sub.email, sub.org_name, sub.org_slug, items, sub.verify_token);
    if (result.ok) {
      db.prepare('DELETE FROM email_digest_queue WHERE subscriber_id = ?').run(sub.id);
    }
  }
}

// Subscribe (creates unverified record + verification email; auto-opts into all current rooms)
// Atomic insert + room opt-in seeding. Returns {newSubscriber, token} on first signup,
// or {existing} if there's already a row (caller decides what to do).
const _newSubscribeTx = db.transaction((email, orgId, token) => {
  const result = db.prepare('INSERT INTO email_subscribers (email, org_id, verify_token) VALUES (?, ?, ?)').run(email, orgId, token);
  const subscriberId = result.lastInsertRowid;
  const rooms = db.prepare('SELECT slug FROM rooms WHERE org_id = ?').all(orgId);
  const insertRoom = db.prepare('INSERT OR IGNORE INTO email_subscriber_rooms (subscriber_id, room_slug) VALUES (?, ?)');
  for (const r of rooms) insertRoom.run(subscriberId, r.slug);
  return subscriberId;
});

async function subscribeEmail(email, orgId, orgName) {
  const token = uuidv4();
  try {
    _newSubscribeTx(email, orgId, token);
  } catch (err) {
    // UNIQUE(email, org_id) — already exists, fall through to handle existing
    const existing = db.prepare('SELECT id, verified, verify_token, unsubscribed_at FROM email_subscribers WHERE email = ? AND org_id = ?').get(email, orgId);
    if (existing?.verified && !existing.unsubscribed_at) return { ok: false, error: 'Already subscribed' };
    if (existing?.unsubscribed_at) {
      db.prepare('UPDATE email_subscribers SET unsubscribed_at = NULL WHERE id = ?').run(existing.id);
    }
    if (!existing?.verified) {
      await sendVerificationEmail(email, existing.verify_token, orgName);
      return { ok: true, message: 'Verification email re-sent' };
    }
    return { ok: true, message: 'Welcome back!' };
  }

  await sendVerificationEmail(email, token, orgName);
  return { ok: true, message: 'Verification email sent' };
}

function verifyEmail(token) {
  const result = db.prepare('UPDATE email_subscribers SET verified = 1 WHERE verify_token = ? AND verified = 0').run(token);
  return result.changes > 0;
}

// Soft-delete unsubscribe (token stays valid for resubscribe via preferences page)
function unsubscribeEmail(token) {
  const result = db.prepare("UPDATE email_subscribers SET unsubscribed_at = datetime('now') WHERE verify_token = ? AND unsubscribed_at IS NULL").run(token);
  return result.changes > 0;
}

// Preferences API
function getPreferences(token) {
  const sub = db.prepare(`
    SELECT s.id, s.email, s.frequency, s.quiet_hours_start, s.quiet_hours_end, s.timezone, s.digest_hour, s.unsubscribed_at,
           s.org_id, o.name AS org_name, o.slug AS org_slug
    FROM email_subscribers s JOIN organizations o ON s.org_id = o.id
    WHERE s.verify_token = ?
  `).get(token);
  if (!sub) return null;

  const rooms = db.prepare('SELECT slug, name FROM rooms WHERE org_id = ? ORDER BY name').all(sub.org_id);
  const subscribed = db.prepare('SELECT room_slug FROM email_subscriber_rooms WHERE subscriber_id = ?').all(sub.id).map(r => r.room_slug);

  // Mask email: show first char and domain
  const [local, domain] = sub.email.split('@');
  const maskedEmail = local[0] + '***@' + domain;

  return {
    email: maskedEmail,
    orgName: sub.org_name,
    orgSlug: sub.org_slug,
    frequency: sub.frequency || 'instant',
    quietStart: sub.quiet_hours_start || '',
    quietEnd: sub.quiet_hours_end || '',
    timezone: sub.timezone || 'UTC',
    digestHour: sub.digest_hour ?? 7,
    unsubscribed: !!sub.unsubscribed_at,
    rooms: rooms.map(r => ({ slug: r.slug, name: r.name, subscribed: subscribed.includes(r.slug) })),
  };
}

// Atomic preference update — preference columns + room opt-in list move together.
const _updatePrefsTx = db.transaction((subId, frequency, qs, qe, tz, digestHour, replaceRooms, roomSlugs) => {
  db.prepare(`
    UPDATE email_subscribers
    SET frequency = ?, quiet_hours_start = ?, quiet_hours_end = ?, timezone = ?, digest_hour = ?
    WHERE id = ?
  `).run(frequency, qs, qe, tz, digestHour, subId);
  if (replaceRooms) {
    db.prepare('DELETE FROM email_subscriber_rooms WHERE subscriber_id = ?').run(subId);
    const ins = db.prepare('INSERT OR IGNORE INTO email_subscriber_rooms (subscriber_id, room_slug) VALUES (?, ?)');
    for (const slug of roomSlugs) ins.run(subId, slug);
  }
});

function updatePreferences(token, prefs) {
  const sub = db.prepare('SELECT id FROM email_subscribers WHERE verify_token = ?').get(token);
  if (!sub) return { ok: false, error: 'Invalid token' };

  const validFreqs = ['instant', 'daily_digest', 'disabled'];
  const frequency = validFreqs.includes(prefs.frequency) ? prefs.frequency : 'instant';
  const tz = typeof prefs.timezone === 'string' && prefs.timezone.length < 64 ? prefs.timezone : 'UTC';
  const qs = /^\d{2}:\d{2}$/.test(prefs.quietStart || '') ? prefs.quietStart : null;
  const qe = /^\d{2}:\d{2}$/.test(prefs.quietEnd || '') ? prefs.quietEnd : null;
  const digestHour = Number.isInteger(prefs.digestHour) && prefs.digestHour >= 0 && prefs.digestHour <= 23 ? prefs.digestHour : 7;

  const replaceRooms = Array.isArray(prefs.subscribedRooms);
  const roomSlugs = replaceRooms
    ? prefs.subscribedRooms.filter(s => typeof s === 'string' && s.length < 50)
    : [];

  _updatePrefsTx(sub.id, frequency, qs, qe, tz, digestHour, replaceRooms, roomSlugs);
  return { ok: true };
}

function resubscribeByToken(token) {
  const result = db.prepare('UPDATE email_subscribers SET unsubscribed_at = NULL WHERE verify_token = ?').run(token);
  return result.changes > 0;
}

// Toggle a single room follow for a token's subscription
function toggleRoomFollow(token, roomSlug) {
  const sub = db.prepare('SELECT id, org_id FROM email_subscribers WHERE verify_token = ?').get(token);
  if (!sub) return { ok: false, error: 'Invalid token' };

  const room = db.prepare('SELECT slug FROM rooms WHERE org_id = ? AND slug = ?').get(sub.org_id, roomSlug);
  if (!room) return { ok: false, error: 'Room not found in your org' };

  const existing = db.prepare('SELECT id FROM email_subscriber_rooms WHERE subscriber_id = ? AND room_slug = ?').get(sub.id, roomSlug);
  if (existing) {
    db.prepare('DELETE FROM email_subscriber_rooms WHERE id = ?').run(existing.id);
    return { ok: true, following: false };
  }
  db.prepare('INSERT INTO email_subscriber_rooms (subscriber_id, room_slug) VALUES (?, ?)').run(sub.id, roomSlug);
  // Reactivate if this user had unsubscribed
  db.prepare('UPDATE email_subscribers SET unsubscribed_at = NULL WHERE id = ?').run(sub.id);
  return { ok: true, following: true };
}

// Find a verified subscription by email and email them their preferences link
async function emailPreferencesLink(email, orgId) {
  const sub = db.prepare('SELECT verify_token, verified FROM email_subscribers WHERE email = ? AND org_id = ?').get(email, orgId);
  if (!sub) return { ok: false, error: 'No subscription found' };

  const org = db.prepare('SELECT name FROM organizations WHERE id = ?').get(orgId);
  const orgName = org?.name || 'UmmahCast';

  if (!sub.verified) {
    // Resend verification
    await sendVerificationEmail(email, sub.verify_token, orgName);
    return { ok: true, message: 'Check your email — we re-sent your verification link' };
  }

  const prefsUrl = `https://ummahcast.com/preferences/${sub.verify_token}`;
  const subject = `Your UmmahCast email preferences — ${orgName}`;
  const body = `
    <p style="margin:0 0 20px;text-align:center;" class="uc-muted">You requested a link to manage your email preferences for <strong>${escapeHtml(orgName)}</strong>.</p>
    ${ctaButton(prefsUrl, 'Manage Preferences')}
    <p style="margin:20px 0 0;font-size:12px;text-align:center;color:#71717a;">If you didn't request this, you can safely ignore this email.</p>`;
  const html = emailWrap({
    previewText: `Tap to manage your UmmahCast email preferences for ${orgName}`,
    body,
    token: sub.verify_token,
    includeFooter: false,
  });
  await sendEmail(email, subject, html, `Manage your preferences: ${prefsUrl}`);
  return { ok: true, message: 'Check your email — we sent your preferences link' };
}

// Quick-follow: subscribe email + opt into ONLY this room (used by bell button on first follow)
async function quickFollow(email, orgId, roomSlug) {
  const org = db.prepare('SELECT name FROM organizations WHERE id = ?').get(orgId);
  const orgName = org?.name || 'UmmahCast';

  let sub = db.prepare('SELECT id, verify_token, verified FROM email_subscribers WHERE email = ? AND org_id = ?').get(email, orgId);

  if (!sub) {
    const token = uuidv4();
    const result = db.prepare('INSERT INTO email_subscribers (email, org_id, verify_token) VALUES (?, ?, ?)').run(email, orgId, token);
    sub = { id: result.lastInsertRowid, verify_token: token, verified: 0 };
    db.prepare('INSERT OR IGNORE INTO email_subscriber_rooms (subscriber_id, room_slug) VALUES (?, ?)').run(sub.id, roomSlug);
    await sendVerificationEmail(email, token, orgName);
    return { ok: true, token, verified: false, message: 'Check your email to verify and start receiving notifications' };
  }

  // Existing subscription — opt them into this room
  db.prepare('INSERT OR IGNORE INTO email_subscriber_rooms (subscriber_id, room_slug) VALUES (?, ?)').run(sub.id, roomSlug);
  // Reactivate if unsubscribed
  db.prepare('UPDATE email_subscribers SET unsubscribed_at = NULL WHERE id = ?').run(sub.id);

  if (!sub.verified) {
    await sendVerificationEmail(email, sub.verify_token, orgName);
    return { ok: true, token: sub.verify_token, verified: false, message: 'Check your email to finish verifying' };
  }

  return { ok: true, token: sub.verify_token, verified: true, message: `You're now following — notifications enabled` };
}

// Get subscribed room slugs for a token (lightweight for bell state hydration)
function getSubscribedRoomSlugs(token) {
  const sub = db.prepare('SELECT id FROM email_subscribers WHERE verify_token = ?').get(token);
  if (!sub) return null;
  return db.prepare('SELECT room_slug FROM email_subscriber_rooms WHERE subscriber_id = ?').all(sub.id).map(r => r.room_slug);
}

// Send admin a daily summary of system activity
async function sendAdminDailyDigest() {
  const today = todayUTC();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  // SMTP usage today (from persistent counter)
  const smtpRows = transports.map(t => {
    const sent = getSent(t.name);
    const limit = t.dailyLimit ? `/${t.dailyLimit}` : '';
    return `  • ${t.name}: ${sent}${limit}`;
  }).join('\n');
  const totalSent = transports.reduce((sum, t) => sum + getSent(t.name), 0);

  // Subscriber stats
  const totalSubs = db.prepare("SELECT COUNT(*) as c FROM email_subscribers WHERE verified = 1 AND unsubscribed_at IS NULL").get().c;
  const newSubsToday = db.prepare("SELECT COUNT(*) as c FROM email_subscribers WHERE date(created_at) = date('now')").get().c;
  const verifiedToday = db.prepare("SELECT COUNT(*) as c FROM email_subscribers WHERE verified = 1 AND date(created_at) = date('now')").get().c;
  const unsubsToday = db.prepare("SELECT COUNT(*) as c FROM email_subscribers WHERE unsubscribed_at IS NOT NULL AND date(unsubscribed_at) = date('now')").get().c;

  // Broadcast stats today
  let broadcasts = 0, peakListeners = 0, totalMinutes = 0, recordingsToday = 0;
  try {
    broadcasts = db.prepare("SELECT COUNT(*) as c FROM analytics WHERE event = 'broadcast_start' AND date(ts) = date('now')").get().c;
    peakListeners = db.prepare("SELECT COALESCE(MAX(value),0) as p FROM analytics WHERE event = 'listener_count' AND date(ts) = date('now')").get().p;
    totalMinutes = db.prepare("SELECT COALESCE(SUM(value),0) as m FROM analytics WHERE event = 'listen_minutes' AND date(ts) = date('now')").get().m;
    recordingsToday = db.prepare("SELECT COUNT(*) as c FROM recordings WHERE date(recorded_at) = date('now') AND size_bytes > 0").get().c;
  } catch {}

  // Contact form submissions
  let contactsToday = 0;
  try { contactsToday = db.prepare("SELECT COUNT(*) as c FROM contact_submissions WHERE date(created_at) = date('now')").get().c; } catch {}

  const lines = [
    `📊 *UmmahCast Daily Digest* — ${today}`,
    ``,
    `*📧 Email Delivery (today)*`,
    `Total sent: ${totalSent}`,
    smtpRows || '  • No providers configured',
    ``,
    `*👥 Subscribers*`,
    `Total verified: ${totalSubs}`,
    `New today: ${newSubsToday} (${verifiedToday} verified)`,
    `Unsubscribed today: ${unsubsToday}`,
    ``,
    `*🎙️ Broadcasts (today)*`,
    `Sessions: ${broadcasts}`,
    `Peak listeners: ${peakListeners}`,
    `Total listen-minutes: ${totalMinutes}`,
    `Recordings saved: ${recordingsToday}`,
    ``,
  ];
  if (contactsToday > 0) lines.push(`*📬 Contact Form*`, `Submissions today: ${contactsToday}`, ``);

  await notifyAdmin(lines.join('\n'), 'info');
}

// Schedule daily digest — call this from index.js with setInterval
function startAdminDigestSchedule() {
  // Check every 10 minutes whether it's time to send (9 UTC)
  let lastSent = null;
  setInterval(() => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getUTCHours() === 9 && lastSent !== today) {
      lastSent = today;
      sendAdminDailyDigest().catch(err => console.error('[admin-digest]', err.message));
    }
  }, 10 * 60 * 1000);
}

module.exports = {
  sendEmail, notifyEmailSubscribers, subscribeEmail, verifyEmail, unsubscribeEmail,
  sendDigests, getPreferences, updatePreferences, resubscribeByToken,
  toggleRoomFollow, emailPreferencesLink, quickFollow, getSubscribedRoomSlugs,
  getDailyStats, sendAdminDailyDigest, startAdminDigestSchedule,
};

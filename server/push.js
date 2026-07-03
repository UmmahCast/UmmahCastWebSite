const webpush = require('web-push');
const https = require('https');
const db = require('./db');
const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = require('./config');

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// Telegram parse_mode='HTML' needs only &, <, > escaped in user-controlled values (vs
// MarkdownV2's 18 specials), so formatting can be restored safely wherever we escape every
// interpolation at the call site. Ampersand first.
function escTgHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function subscribe(subscription, orgId) {
  const { endpoint, keys } = subscription;
  db.prepare(`
    INSERT OR REPLACE INTO push_subscriptions (endpoint, keys_p256dh, keys_auth, org_id)
    VALUES (?, ?, ?, ?)
  `).run(endpoint, keys.p256dh, keys.auth, orgId || null);
}

function unsubscribe(endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

async function notifyLive(roomName, broadcasterName, orgId) {
  // Only notify subscribers for this org
  const subs = orgId
    ? db.prepare('SELECT * FROM push_subscriptions WHERE org_id = ?').all(orgId)
    : db.prepare('SELECT * FROM push_subscriptions').all();

  const payload = JSON.stringify({
    title: 'UmmahCast',
    body: `${roomName} is now live — join us!`,
    url: '/',
  });

  const stale = [];
  let failed = 0;
  const errSamples = [];
  await Promise.allSettled(subs.map(async (sub) => {
    const pushSub = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth },
    };
    try {
      await webpush.sendNotification(pushSub, payload);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) stale.push(sub.endpoint);
      else { failed++; if (errSamples.length < 3) errSamples.push(err.statusCode || err.message); }
    }
  }));

  for (const endpoint of stale) {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }
  // Count non-410/404 failures separately so a provider outage (e.g. all 5xx/413) isn't
  // silently logged as "delivered".
  const delivered = subs.length - stale.length - failed;
  console.log(`[push] Sent to ${delivered}/${subs.length} subscribers (${stale.length} stale removed, ${failed} failed${errSamples.length ? ': ' + errSamples.join(', ') : ''})`);
}

// Telegram — per-org channel with global fallback
async function notifyTelegram(roomName, orgId) {
  let chatId = TELEGRAM_CHAT_ID;

  // Check for org-specific Telegram channel
  if (orgId) {
    const org = db.prepare('SELECT telegram_chat_id FROM organizations WHERE id = ?').get(orgId);
    if (org?.telegram_chat_id) chatId = org.telegram_chat_id;
  }

  if (!TELEGRAM_BOT_TOKEN || !chatId) return;

  // HTML parse_mode — roomName is the only user-controlled value and it's escaped, so a name
  // with <, > or & (or Markdown specials) can't break the parse or inject formatting/links.
  const text = `🕌 <b>${escTgHtml(roomName)}</b> is now live on UmmahCast!\n\n🎧 https://ummahcast.com`;

  const postData = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const ok = JSON.parse(data).ok;
          console.log(`[telegram] ${ok ? 'Sent' : 'Failed'}: ${roomName}`);
        } catch { console.error('[telegram] Invalid response'); }
        resolve();
      });
    });
    req.on('error', (err) => { console.error('[telegram] Error:', err.message); resolve(); });
    req.write(postData);
    req.end();
  });
}

// Telegram notification for contact form submissions
async function notifyContactForm(name, email, type, message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  // HTML parse_mode with every field escaped — the whole payload is user-controlled, but
  // escaping &, <, > neutralizes any injection while restoring the bold header/labels.
  const text = `📬 <b>New Contact Form Submission</b>\n\n<b>From:</b> ${escTgHtml(name)}\n<b>Email:</b> ${escTgHtml(email || 'Not provided')}\n<b>Type:</b> ${escTgHtml(type)}\n\n<b>Message:</b>\n${escTgHtml(message)}`;

  const postData = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { console.log(`[telegram] Contact form: ${JSON.parse(data).ok ? 'sent' : 'failed'}`); }
        catch { console.error('[telegram] Invalid response'); }
        resolve();
      });
    });
    req.on('error', (err) => { console.error('[telegram] Error:', err.message); resolve(); });
    req.write(postData);
    req.end();
  });
}

// Generic admin Telegram alert — used for system-level events
// priority: 'info' | 'warn' | 'critical'
async function notifyAdmin(text, priority = 'info') {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const prefix = priority === 'critical' ? '🚨' : priority === 'warn' ? '⚠️' : 'ℹ️';
  // parse_mode dropped — many callers interpolate broadcaster names, org names,
  // and invitee emails into the text. Markdown formatting in those values used
  // to phish or break the message. Plain text is safer.
  const payload = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text: `${prefix} ${text}`,
    disable_notification: priority === 'info',  // info doesn't ping
  });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, () => resolve());
    req.on('error', () => resolve());
    req.write(payload);
    req.end();
  });
}

module.exports = { subscribe, unsubscribe, notifyLive, notifyTelegram, notifyContactForm, notifyAdmin };

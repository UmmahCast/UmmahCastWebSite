const webpush = require('web-push');
const https = require('https');
const db = require('./db');
const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = require('./config');

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

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
  await Promise.allSettled(subs.map(async (sub) => {
    const pushSub = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth },
    };
    try {
      await webpush.sendNotification(pushSub, payload);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) stale.push(sub.endpoint);
    }
  }));

  for (const endpoint of stale) {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }
  console.log(`[push] Sent to ${subs.length - stale.length} subscribers (${stale.length} stale removed)`);
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

  // parse_mode dropped — roomName is user-controlled and Markdown special chars
  // (* _ ` [ ]) in a name break the parse, or worse, let the broadcaster slip
  // formatted links into the admin's Telegram channel.
  const text = `🕌 ${roomName} is now live on UmmahCast!\n\n🎧 https://ummahcast.com`;

  const postData = JSON.stringify({
    chat_id: chatId,
    text,
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

  // parse_mode dropped — entire payload is user-controlled. Even with escaping,
  // MarkdownV2 has too many specials to reliably sanitize. Plain text is safer.
  const text = `📬 New Contact Form Submission\n\nFrom: ${name}\nEmail: ${email || 'Not provided'}\nType: ${type}\n\nMessage:\n${message}`;

  const postData = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text,
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

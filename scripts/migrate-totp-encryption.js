#!/usr/bin/env node
// One-time migration: encrypt any plaintext TOTP secrets at rest (AES-256-GCM).
// Idempotent — rows already in "enc:v1:" format are skipped. Safe to run repeatedly.
//
// Requires TOTP_ENC_KEY (64 hex chars) in the environment, matching server/config.js.
// Run inside the app container so it uses the same env + DB:
//   docker exec ummahcast node /app/scripts/migrate-totp-encryption.js
const crypto = require('crypto');
const Database = require('better-sqlite3');

const KEY_HEX = process.env.TOTP_ENC_KEY || '';
const DB_PATH = process.env.DB_PATH || './livewave.db';
if (!/^[0-9a-fA-F]{64}$/.test(KEY_HEX)) {
  console.error('FATAL: TOTP_ENC_KEY must be set to 64 hex chars (32 bytes). Aborting.');
  process.exit(1);
}
const key = Buffer.from(KEY_HEX, 'hex');

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

const db = new Database(DB_PATH);
const rows = db.prepare("SELECT id, username, totp_secret FROM broadcasters WHERE totp_secret IS NOT NULL AND totp_secret != ''").all();
let migrated = 0, skipped = 0;
const update = db.prepare('UPDATE broadcasters SET totp_secret = ? WHERE id = ?');
const tx = db.transaction(() => {
  for (const r of rows) {
    if (typeof r.totp_secret === 'string' && r.totp_secret.startsWith('enc:v1:')) { skipped++; continue; }
    // Sanity: verify the ciphertext round-trips before committing the row.
    const enc = encrypt(r.totp_secret);
    const [, , ivH, tagH, ctH] = enc.split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivH, 'hex'));
    d.setAuthTag(Buffer.from(tagH, 'hex'));
    const back = Buffer.concat([d.update(Buffer.from(ctH, 'hex')), d.final()]).toString('utf8');
    if (back !== r.totp_secret) throw new Error(`round-trip mismatch for broadcaster ${r.id}`);
    update.run(enc, r.id);
    migrated++;
    console.log(`encrypted totp_secret for #${r.id} (${r.username})`);
  }
});
tx();
console.log(`Done. migrated=${migrated} skipped(already-encrypted)=${skipped} total=${rows.length}`);
db.close();

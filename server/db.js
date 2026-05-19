const Database = require('better-sqlite3');
const { DB_PATH } = require('./config');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Schema (new installs) ---
// Wrap in try-catch so existing DBs with different schemas don't crash
try { db.exec(`
  CREATE TABLE IF NOT EXISTS organizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    accent_color TEXT DEFAULT '#2d8a4e',
    logo_url TEXT,
    description TEXT,
    telegram_chat_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS broadcasters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    org_id INTEGER REFERENCES organizations(id),
    is_superadmin INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    password TEXT,
    org_id INTEGER REFERENCES organizations(id),
    accent_color TEXT DEFAULT '#2d8a4e',
    logo_url TEXT,
    description TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(slug, org_id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    broadcaster_id INTEGER NOT NULL REFERENCES broadcasters(id),
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT UNIQUE NOT NULL,
    keys_p256dh TEXT NOT NULL,
    keys_auth TEXT NOT NULL,
    org_id INTEGER REFERENCES organizations(id),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_slug TEXT NOT NULL,
    org_id INTEGER REFERENCES organizations(id),
    title TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    duration_minutes INTEGER DEFAULT 60,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS event_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    org_id INTEGER REFERENCES organizations(id),
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(name, org_id)
  );

  CREATE TABLE IF NOT EXISTS analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_slug TEXT NOT NULL,
    org_id INTEGER REFERENCES organizations(id),
    event TEXT NOT NULL,
    value INTEGER DEFAULT 0,
    ts TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_analytics_room_ts ON analytics(room_slug, ts);
  CREATE INDEX IF NOT EXISTS idx_rooms_org ON rooms(org_id);`);
} catch (err) {
  // Existing DB — tables exist with old schema, migrations below will add columns
  console.log('[db] Schema create skipped (existing DB), applying migrations...');
}

// --- Ensure recordings table exists ---
try { db.exec(`
  CREATE TABLE IF NOT EXISTS recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_slug TEXT NOT NULL,
    org_id INTEGER REFERENCES organizations(id),
    filename TEXT NOT NULL,
    title TEXT,
    size_bytes INTEGER DEFAULT 0,
    duration_seconds INTEGER DEFAULT 0,
    published INTEGER DEFAULT 0,
    recorded_at TEXT DEFAULT (datetime('now'))
  );
`); } catch {}

// --- Ensure organizations table exists (needed for migrations) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS organizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    accent_color TEXT DEFAULT '#2d8a4e',
    logo_url TEXT,
    description TEXT,
    telegram_chat_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// --- Migration: add columns to existing tables if upgrading ---
try { db.exec('ALTER TABLE broadcasters ADD COLUMN org_id INTEGER REFERENCES organizations(id)'); } catch {}
try { db.exec('ALTER TABLE broadcasters ADD COLUMN is_superadmin INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE broadcasters ADD COLUMN totp_secret TEXT'); } catch {}
try { db.exec('ALTER TABLE broadcasters ADD COLUMN totp_enabled INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE broadcasters ADD COLUMN totp_backup_codes TEXT'); } catch {}
try { db.exec("ALTER TABLE broadcasters ADD COLUMN account_type TEXT DEFAULT 'individual'"); } catch {}
try { db.exec('ALTER TABLE broadcasters ADD COLUMN is_org_leader INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE broadcasters ADD COLUMN must_change_password INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE broadcasters ADD COLUMN first_login_at TEXT'); } catch {}
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_one_leader_per_org ON broadcasters(org_id) WHERE is_org_leader = 1'); } catch {}
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_one_shared_per_org ON broadcasters(org_id) WHERE account_type = 'shared'"); } catch {}

// Broadcaster invites (mirrors org_signup_requests)
try { db.exec(`
  CREATE TABLE IF NOT EXISTS broadcaster_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL REFERENCES organizations(id),
    invited_email TEXT NOT NULL,
    invited_display_name TEXT NOT NULL,
    account_type TEXT NOT NULL DEFAULT 'individual',
    invited_by INTEGER REFERENCES broadcasters(id),
    invite_token TEXT NOT NULL UNIQUE,
    invite_expires_at TEXT NOT NULL,
    consumed_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_bc_invite_token ON broadcaster_invites(invite_token);
  CREATE INDEX IF NOT EXISTS idx_bc_invite_org ON broadcaster_invites(org_id);
`); } catch {}
try { db.exec('ALTER TABLE rooms ADD COLUMN org_id INTEGER REFERENCES organizations(id)'); } catch {}
try { db.exec('ALTER TABLE rooms ADD COLUMN accent_color TEXT DEFAULT \'#2d8a4e\''); } catch {}
try { db.exec('ALTER TABLE rooms ADD COLUMN logo_url TEXT'); } catch {}
try { db.exec('ALTER TABLE rooms ADD COLUMN description TEXT'); } catch {}
try { db.exec('ALTER TABLE rooms ADD COLUMN chat_disabled INTEGER DEFAULT 0'); } catch {}
// Org logo upload + superadmin approval workflow.
// Pending fields hold the freshly-uploaded image until a superadmin approves
// or rejects it. logo_url is only updated on approval.
try { db.exec('ALTER TABLE organizations ADD COLUMN pending_logo_url TEXT'); } catch {}
try { db.exec('ALTER TABLE organizations ADD COLUMN pending_logo_uploaded_at TEXT'); } catch {}
try { db.exec('ALTER TABLE organizations ADD COLUMN pending_logo_uploaded_by INTEGER REFERENCES broadcasters(id)'); } catch {}
// TOS acceptance per broadcaster — gates access to broadcaster surfaces until
// they accept the current version. Bump the constant in server/index.js to
// force re-acceptance after material changes.
try { db.exec('ALTER TABLE broadcasters ADD COLUMN tos_accepted_version TEXT'); } catch {}
try { db.exec('ALTER TABLE broadcasters ADD COLUMN tos_accepted_at TEXT'); } catch {}
// Site-wide analytics events (separate from per-room `analytics` table).
// Used for: page views, apply clicks, sample plays, ko-fi clicks, etc.
try { db.exec(`
  CREATE TABLE IF NOT EXISTS site_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    meta TEXT,
    ts TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_site_events_event_ts ON site_events(event, ts);
`); } catch {}
try { db.exec('ALTER TABLE event_categories ADD COLUMN org_id INTEGER REFERENCES organizations(id)'); } catch {}
try { db.exec('ALTER TABLE push_subscriptions ADD COLUMN org_id INTEGER REFERENCES organizations(id)'); } catch {}
try { db.exec('ALTER TABLE schedules ADD COLUMN org_id INTEGER REFERENCES organizations(id)'); } catch {}
try { db.exec("ALTER TABLE schedules ADD COLUMN recurrence_rule TEXT"); } catch {}
try { db.exec("ALTER TABLE schedules ADD COLUMN recurrence_until TEXT"); } catch {}
try { db.exec("ALTER TABLE schedules ADD COLUMN timezone TEXT DEFAULT 'UTC'"); } catch {}
try { db.exec('ALTER TABLE analytics ADD COLUMN org_id INTEGER REFERENCES organizations(id)'); } catch {}
try { db.exec('ALTER TABLE recordings ADD COLUMN org_id INTEGER REFERENCES organizations(id)'); } catch {}
try { db.exec('ALTER TABLE organizations ADD COLUMN telegram_chat_id TEXT'); } catch {}
try { db.exec('ALTER TABLE organizations ADD COLUMN pending_deletion_at TEXT'); } catch {}
try { db.exec('ALTER TABLE organizations ADD COLUMN archive_token TEXT'); } catch {}
try { db.exec('ALTER TABLE organizations ADD COLUMN archive_path TEXT'); } catch {}
try { db.exec('ALTER TABLE organizations ADD COLUMN archive_expires_at TEXT'); } catch {}

// --- Seed migration: create default org and assign existing data ---
const orgCount = db.prepare('SELECT COUNT(*) as c FROM organizations').get();
if (orgCount.c === 0) {
  db.prepare('INSERT INTO organizations (slug, name) VALUES (?, ?)').run('default', 'UmmahCast');
  const defaultOrg = db.prepare('SELECT id FROM organizations WHERE slug = ?').get('default');
  if (defaultOrg) {
    db.prepare('UPDATE broadcasters SET org_id = ? WHERE org_id IS NULL').run(defaultOrg.id);
    db.prepare('UPDATE rooms SET org_id = ? WHERE org_id IS NULL').run(defaultOrg.id);
    db.prepare('UPDATE event_categories SET org_id = ? WHERE org_id IS NULL').run(defaultOrg.id);
    db.prepare('UPDATE push_subscriptions SET org_id = ? WHERE org_id IS NULL').run(defaultOrg.id);
    db.prepare('UPDATE schedules SET org_id = ? WHERE org_id IS NULL').run(defaultOrg.id);
    db.prepare('UPDATE analytics SET org_id = ? WHERE org_id IS NULL').run(defaultOrg.id);
    db.prepare('UPDATE recordings SET org_id = ? WHERE org_id IS NULL').run(defaultOrg.id);
  }
}

// Seed default room for default org if none exist
const defaultOrg = db.prepare('SELECT id FROM organizations WHERE slug = ?').get('default');
if (defaultOrg) {
  const roomCount = db.prepare('SELECT COUNT(*) as c FROM rooms WHERE org_id = ?').get(defaultOrg.id);
  if (roomCount.c === 0) {
    db.prepare('INSERT INTO rooms (slug, name, org_id) VALUES (?, ?, ?)').run('main', 'Masjid Main Hall', defaultOrg.id);
  }
}

// Seed default categories for default org if none exist
if (defaultOrg) {
  const catCount = db.prepare('SELECT COUNT(*) as c FROM event_categories WHERE org_id = ?').get(defaultOrg.id);
  if (catCount.c === 0) {
    const defaults = ['Morning Awrad', 'Dalail al-Khayrat', 'Talim', 'Jumu\'ah Khutbah', 'Quran Recitation', 'Dhikr', 'Halaqa', 'Taraweeh', 'General'];
    const ins = db.prepare('INSERT OR IGNORE INTO event_categories (name, org_id) VALUES (?, ?)');
    for (const cat of defaults) ins.run(cat, defaultOrg.id);
  }
}

// --- Org signup requests (self-service) ---
try { db.exec(`
  CREATE TABLE IF NOT EXISTS org_signup_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposed_slug TEXT NOT NULL,
    org_name TEXT NOT NULL,
    contact_name TEXT NOT NULL,
    contact_email TEXT NOT NULL,
    description TEXT,
    city TEXT,
    status TEXT DEFAULT 'pending',
    notes TEXT,
    ip TEXT,
    reviewed_by INTEGER REFERENCES broadcasters(id),
    reviewed_at TEXT,
    invite_token TEXT,
    invite_expires_at TEXT,
    invite_consumed_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_signup_status ON org_signup_requests(status);
  CREATE INDEX IF NOT EXISTS idx_signup_invite ON org_signup_requests(invite_token);
`); } catch {}

// --- SMTP daily send counters ---
try { db.exec(`
  CREATE TABLE IF NOT EXISTS smtp_daily_counters (
    provider TEXT NOT NULL,
    date TEXT NOT NULL,
    sent INTEGER DEFAULT 0,
    PRIMARY KEY (provider, date)
  );
`); } catch {}

// --- Email subscribers table ---
try { db.exec(`
  CREATE TABLE IF NOT EXISTS email_subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    org_id INTEGER REFERENCES organizations(id),
    verified INTEGER DEFAULT 0,
    verify_token TEXT NOT NULL,
    unsubscribed_at TEXT,
    frequency TEXT DEFAULT 'instant',
    quiet_hours_start TEXT,
    quiet_hours_end TEXT,
    timezone TEXT DEFAULT 'UTC',
    digest_hour INTEGER DEFAULT 7,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(email, org_id)
  );
`); } catch {}

// Migrations for existing email_subscribers tables
try { db.exec("ALTER TABLE email_subscribers ADD COLUMN unsubscribed_at TEXT"); } catch {}
try { db.exec("ALTER TABLE email_subscribers ADD COLUMN frequency TEXT DEFAULT 'instant'"); } catch {}
try { db.exec("ALTER TABLE email_subscribers ADD COLUMN quiet_hours_start TEXT"); } catch {}
try { db.exec("ALTER TABLE email_subscribers ADD COLUMN quiet_hours_end TEXT"); } catch {}
try { db.exec("ALTER TABLE email_subscribers ADD COLUMN timezone TEXT DEFAULT 'UTC'"); } catch {}
try { db.exec("ALTER TABLE email_subscribers ADD COLUMN digest_hour INTEGER DEFAULT 7"); } catch {}

// Per-room opt-in
try { db.exec(`
  CREATE TABLE IF NOT EXISTS email_subscriber_rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_id INTEGER NOT NULL REFERENCES email_subscribers(id) ON DELETE CASCADE,
    room_slug TEXT NOT NULL,
    UNIQUE(subscriber_id, room_slug)
  );
  CREATE INDEX IF NOT EXISTS idx_email_sub_rooms_sub ON email_subscriber_rooms(subscriber_id);
`); } catch {}

// Daily digest queue
try { db.exec(`
  CREATE TABLE IF NOT EXISTS email_digest_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_id INTEGER NOT NULL REFERENCES email_subscribers(id) ON DELETE CASCADE,
    org_id INTEGER NOT NULL,
    room_slug TEXT NOT NULL,
    room_name TEXT NOT NULL,
    occurred_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_digest_queue_sub ON email_digest_queue(subscriber_id);
`); } catch {}

// --- Contact submissions table ---
try { db.exec(`
  CREATE TABLE IF NOT EXISTS contact_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    ip TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`); } catch {}

// Mark superadmin
const superadminUser = process.env.SUPERADMIN_USERNAME || 'superadmin';
db.prepare('UPDATE broadcasters SET is_superadmin = 1 WHERE username = ?').run(superadminUser);

module.exports = db;

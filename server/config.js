const isProd = process.env.NODE_ENV === 'production';

function requireEnv(name) {
  const val = process.env[name];
  if (!val && isProd) {
    console.error(`[FATAL] ${name} must be set in production`);
    process.exit(1);
  }
  return val;
}

module.exports = {
  PORT: process.env.PORT || 3000,
  // SESSION_SECRET and VAPID_*_KEY have no fallbacks — requireEnv fatals in prod if missing.
  // Never commit dev defaults for cryptographic secrets; the old fallbacks were the active prod keys.
  SESSION_SECRET: requireEnv('SESSION_SECRET'),
  DB_PATH: process.env.DB_PATH || './livewave.db',
  COOKIE_NAME: 'uc_session',
  SESSION_MAX_AGE: 24 * 60 * 60 * 1000, // 24 hours
  VAPID_PUBLIC_KEY: requireEnv('VAPID_PUBLIC_KEY'),
  VAPID_PRIVATE_KEY: requireEnv('VAPID_PRIVATE_KEY'),
  VAPID_SUBJECT: process.env.VAPID_SUBJECT || 'mailto:admin@livewave.local',
  MAX_LISTENERS_PER_ROOM: parseInt(process.env.MAX_LISTENERS_PER_ROOM || '200', 10),
  RECORDINGS_DIR: process.env.RECORDINGS_DIR,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  SUPERADMIN_USERNAME: process.env.SUPERADMIN_USERNAME || 'superadmin',

  // Email — SMTP chain (up to 8 providers, failover order)
  SMTP_FROM: process.env.SMTP_FROM || 'notifications@ummahcast.com',
  SMTP_PROVIDERS: (() => {
    const providers = [];
    for (let i = 1; i <= 8; i++) {
      const host = process.env[`SMTP${i}_HOST`];
      const port = process.env[`SMTP${i}_PORT`];
      const user = process.env[`SMTP${i}_USER`];
      const pass = process.env[`SMTP${i}_PASS`];
      if (host && user && pass) {
        const dailyLimit = parseInt(process.env[`SMTP${i}_DAILY_LIMIT`] || '0', 10);
        providers.push({
          host,
          port: parseInt(port || '587', 10),
          user,
          pass,
          name: process.env[`SMTP${i}_NAME`] || `smtp${i}`,
          dailyLimit: dailyLimit > 0 ? dailyLimit : null,
        });
      }
    }
    return providers;
  })(),
};

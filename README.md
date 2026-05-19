# UmmahCast

> Self-hosted live audio streaming for mosques. Free forever, as a sadaqah.

UmmahCast is a community-driven platform that lets mosques broadcast live audio — khutbahs, lectures, Quran recitation, halaqas — straight to their community's browsers. No app to install. No subscription. No third-party trackers.

**Live at:** [ummahcast.com](https://ummahcast.com)

---

## What it does

- **Live audio streaming** over WebSockets (Opus / WebM at 128 kbps)
- **Multi-tenancy** — every mosque gets its own org-scoped space with rooms, schedules, recordings, branding, and team
- **Push & email notifications** when a broadcast goes live (web push + double opt-in email + optional Telegram channel)
- **Auto-recording** with broadcaster-controlled publish / unpublish
- **Privacy-first analytics** — fixed allow-listed event counters, no IPs, no cookies, no third-party trackers
- **Two-factor auth** for broadcasters (TOTP + backup codes), forced password rotation, emergency superadmin recovery actions
- **PWA** — installable to home screen on iOS / Android / desktop

## Stack

| Layer | Choice |
|---|---|
| Backend | Node.js 20 + Express 5, WebSocket via `ws` |
| Storage | SQLite (`better-sqlite3`) — single-file, embedded |
| Frontend | Vanilla HTML / CSS / JS — no build step, no framework |
| Auth | scrypt password hashing, signed HttpOnly session cookies, TOTP 2FA |
| Push | Web Push (VAPID) + Telegram bot + nodemailer (multi-provider failover) |
| Container | Alpine Node base, distroless cloudflared sidecar |
| Ingress | Cloudflare Tunnel — outbound only, no inbound ports |

Full dependency attribution at [LICENSES.md](./LICENSES.md) and `/licenses` on the live site.

## License

UmmahCast is licensed under the **GNU Affero General Public License v3.0** ([LICENSE](./LICENSE)).

In plain English: anyone can use, modify, or self-host this code. If you offer a modified version *as a network service*, you must offer the modified source to your users. The license enforces the spirit of "free, forever, as a sadaqah" — nobody can fork UmmahCast and turn it into a paid mosque-streaming service without giving back to the community.

## Quick start (local)

```bash
git clone https://github.com/UmmahCast/UmmahCastWebSite.git
cd UmmahCastWebSite
cp .env.example .env  # then fill in SESSION_SECRET + any SMTP / VAPID / Telegram values you have
npm ci
node server/index.js --setup  # creates an initial superadmin broadcaster
node server/index.js
```

Then open [http://localhost:3000](http://localhost:3000).

## Deployment

Production runs as a 2-container Docker Compose stack: the Node app on an Alpine image, and an outbound `cloudflared` tunnel that exposes the app to the internet without opening inbound ports. Build with `docker compose build && docker compose up -d`. See [Dockerfile](./Dockerfile) and the compose file used in production for details.

## Contributing

This is a small, opinionated project run primarily as a community service. Issues and pull requests are welcome but may be handled slowly. If you find a security issue, please report it privately through the contact form at [ummahcast.com/contact](https://ummahcast.com/contact) rather than opening a public issue.

---

*Built with care for the Ummah.*

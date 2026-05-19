# UmmahCast — Open Source Acknowledgements

## UmmahCast's own license

UmmahCast is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**. The full license text lives in the [`LICENSE`](./LICENSE) file at the repository root. This license was chosen to keep the platform community-owned: anyone may use, modify, or self-host UmmahCast, but any modified version offered as a hosted service must also make its source available to its users.

Copyright © 2026 Brandon Lucariello. The source is not currently published publicly — but if you receive a copy through any channel, the AGPL-3.0 terms apply to your use and modification of it.

## Third-party software we rely on

This document lists the third-party open-source software the platform relies on, in gratitude to the communities and maintainers who made it possible. For each dependency below, the full license text ships inside the corresponding package directory of `node_modules/` (e.g. `node_modules/express/LICENSE`).

Last reviewed: 2026-05-18.

---

## Direct dependencies

| Package | Version | License | Purpose |
|---|---|---|---|
| [archiver](https://github.com/archiverjs/node-archiver) | ^7.0.1 | MIT | Org-deletion zip archive generation |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | ^12.8.0 | MIT | Synchronous SQLite driver |
| [compression](https://github.com/expressjs/compression) | ^1.8.1 | MIT | HTTP response compression middleware |
| [cookie-parser](https://github.com/expressjs/cookie-parser) | ^1.4.7 | MIT | Cookie parsing middleware |
| [cookie-signature](https://github.com/tj/node-cookie-signature) | ^1.2.2 | MIT | Signed-cookie utilities |
| [express](https://github.com/expressjs/express) | ^5.2.1 | MIT | HTTP server framework |
| [express-rate-limit](https://github.com/express-rate-limit/express-rate-limit) | ^8.3.2 | MIT | Per-route rate limiting |
| [helmet](https://github.com/helmetjs/helmet) | ^8.1.0 | MIT | Security-header middleware |
| [multer](https://github.com/expressjs/multer) | ^2.0.3 | MIT | File-upload middleware (logo upload pipeline) |
| [nodemailer](https://github.com/nodemailer/nodemailer) | ^8.0.5 | MIT-0 | SMTP delivery with multi-provider failover |
| [qrcode](https://github.com/soldair/node-qrcode) | ^1.5.4 | MIT | QR code rendering for 2FA enrollment |
| [sharp](https://github.com/lovell/sharp) | ^0.34.4 | Apache-2.0 | Image processing + EXIF stripping for uploads |
| [speakeasy](https://github.com/speakeasyjs/speakeasy) | ^2.0.0 | MIT | TOTP / HOTP for broadcaster 2FA |
| [uuid](https://github.com/uuidjs/uuid) | ^13.0.0 | MIT | Identifier generation |
| [web-push](https://github.com/web-push-libs/web-push) | ^3.6.7 | **MPL-2.0** | VAPID push notification delivery |
| [ws](https://github.com/websockets/ws) | ^8.20.0 | MIT | WebSocket server (live audio + chat) |

### A note on MPL-2.0 (web-push)
The Mozilla Public License is a weak-copyleft license. Because UmmahCast uses `web-push` as an unmodified library (we do not edit files inside `node_modules/web-push/`), no source-disclosure obligations attach to the rest of the codebase. If we ever fork or modify `web-push`, those modifications would themselves need to be made available under MPL-2.0.

---

## System & infrastructure

| Component | License | Purpose |
|---|---|---|
| [Node.js 20](https://nodejs.org) | MIT | JavaScript runtime |
| [Alpine Linux](https://alpinelinux.org) | MIT + others | Container base image |
| [SQLite](https://sqlite.org) | Public Domain | Embedded database engine (via better-sqlite3) |
| [cloudflared](https://github.com/cloudflare/cloudflared) | Apache-2.0 | Outbound tunnel for ingress (no inbound ports needed) |
| [FFmpeg](https://ffmpeg.org) | LGPL-2.1+ | Installed in container (currently dormant — transcode code removed when podcast UI was hidden) |

---

## Fonts

| Family | License | Source |
|---|---|---|
| [Amiri](https://github.com/alif-type/amiri) | SIL Open Font License 1.1 | Classical Arabic-inflected serif used for display headings |
| System UI sans-serif stack | — | Body text uses each platform's native UI font |

---

## Transitive dependencies

The packages above pull in roughly 200 transitive dependencies. All are under permissive licenses (MIT, ISC, BSD, Apache-2.0, BlueOak-1.0.0, WTFPL, or 0BSD). No GPL or AGPL licensed code is included in the dependency tree. Full per-package license text ships inside `node_modules/` and is recoverable at any time with `npx license-checker`.

---

## In gratitude

UmmahCast would not exist without the work of these projects and their maintainers. Thank you for sharing your work openly.

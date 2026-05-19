# Security Policy

Thank you for taking the time to look. UmmahCast is a community service used by mosques and their listeners, so security reports are taken seriously and handled promptly.

## Reporting a vulnerability

**Please do not open public GitHub issues for security problems.** Use one of these private channels instead:

- **GitHub Private Vulnerability Reporting** — preferred. Open the repository's [Security tab](https://github.com/UmmahCast/UmmahCastWebSite/security) and click *Report a vulnerability*.
- **Live-site contact form** — [ummahcast.com/contact](https://ummahcast.com/contact). Mention "security" in the subject so it routes to the right place.

Please include:
- A description of the issue and the impact you believe it has
- Steps to reproduce (proof-of-concept code or a request trace is helpful)
- Any relevant version / commit hash and the time of testing
- Your preferred contact method for follow-up

## What to expect

- **Acknowledgement** within a few days of the report
- **Triage and severity assessment** soon after
- **Coordinated disclosure** — credit (if you'd like it) once a fix is shipped and deployed
- **No bug bounty** — UmmahCast is a free, volunteer-run platform; we cannot offer monetary rewards, but we will publicly acknowledge contributors who help keep the platform safe

## Scope

In scope:
- The Node.js application and its dependencies
- The Docker deployment artifacts in this repository
- The frontend code served from `/public`

Out of scope:
- Reports against `cloudflared`, Cloudflare's edge, SQLite, or Node.js itself — please report these upstream
- Social-engineering attacks against contributors or operators
- Findings that require an already-compromised user device

## Safe-harbor

Good-faith security research that respects this policy will not be subject to legal action. Please avoid accessing or modifying data that does not belong to you, and stop testing as soon as you confirm an issue.

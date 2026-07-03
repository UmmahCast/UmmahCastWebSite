const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Scan every served HTML page for inline <script> blocks (those WITHOUT a src= attribute)
// and return their CSP source-hashes ('sha256-<base64>'). The list feeds helmet's script-src
// so inline scripts are allowed by exact-content hash instead of 'unsafe-inline'.
//
// Why this is safe here: pages are served as static files (res.sendFile), and og-inject only
// rewrites <title>/<meta> — never <script> content — so the bytes the browser hashes are
// identical to the bytes on disk that we hash here. Self-maintaining: editing a page's inline
// script changes its hash automatically on the next boot; no manual CSP updates.
//
// NOTE: this covers script-src (inline <script> blocks). Inline event-handler attributes
// (onclick=, …) are governed by script-src-attr and are NOT hashable this way — they require
// migrating handlers to addEventListener (tracked separately).
function computeInlineScriptHashes(publicDir) {
  // Match <script ...> WITHOUT a src= attribute, capturing the exact inner content.
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  const hashes = new Set();
  for (const file of fs.readdirSync(publicDir)) {
    if (!file.endsWith('.html')) continue;
    const html = fs.readFileSync(path.join(publicDir, file), 'utf8');
    let m;
    while ((m = re.exec(html))) {
      const digest = crypto.createHash('sha256').update(m[1], 'utf8').digest('base64');
      hashes.add(`'sha256-${digest}'`);
    }
  }
  return [...hashes];
}

module.exports = { computeInlineScriptHashes };

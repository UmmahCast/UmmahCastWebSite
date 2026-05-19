// Server-side OG meta tag injection for org/listen pages, so links shared to
// WhatsApp/Telegram/Twitter render with the right org name + description +
// "Live now" badge. Caches each HTML template at startup and does string
// replacement on request — no template engine, no streaming overhead.
const fs = require('fs');
const path = require('path');

const cache = new Map();

function loadTemplate(file) {
  if (cache.has(file)) return cache.get(file);
  const raw = fs.readFileSync(file, 'utf8');
  cache.set(file, raw);
  return raw;
}

function escAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Replace any single-line meta tag matching `name=` or `property=` with a
// new content value. Returns html unchanged if the tag isn't present.
function replaceMeta(html, attr, key, content) {
  const re = new RegExp(`<meta\\s+${attr}=["']${key}["']\\s+content=["'][^"']*["']\\s*\\/?>`, 'i');
  const tag = `<meta ${attr}="${key}" content="${escAttr(content)}">`;
  return re.test(html) ? html.replace(re, tag) : html;
}

function replaceTitle(html, title) {
  return html.replace(/<title>[^<]*<\/title>/i, `<title>${escAttr(title)}</title>`);
}

// opts: { title, description, url, image, twitterTitle, twitterDescription }
function inject(templatePath, opts) {
  let html = loadTemplate(templatePath);
  if (opts.title) {
    html = replaceTitle(html, opts.title);
    html = replaceMeta(html, 'property', 'og:title', opts.title);
    html = replaceMeta(html, 'name', 'twitter:title', opts.twitterTitle || opts.title);
  }
  if (opts.description) {
    html = replaceMeta(html, 'property', 'og:description', opts.description);
    html = replaceMeta(html, 'name', 'twitter:description', opts.twitterDescription || opts.description);
    html = replaceMeta(html, 'name', 'description', opts.description);
  }
  if (opts.url) {
    html = replaceMeta(html, 'property', 'og:url', opts.url);
  }
  if (opts.image) {
    html = replaceMeta(html, 'property', 'og:image', opts.image);
    html = replaceMeta(html, 'name', 'twitter:image', opts.image);
  }
  return html;
}

module.exports = { inject };

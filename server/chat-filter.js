// Chat moderation: word-boundary match against a curated wordlist.
// Asterisks-out hits rather than rejecting the message — friendlier on false
// positives and keeps community feel. All hits are logged with sender + room
// context in streaming.js so patterns can be reviewed.
//
// To extend the wordlist, edit server/chat-wordlist.json and restart the
// container. The list is loaded once at startup.

const path = require('path');
const fs = require('fs');

let WORDS = [];
try {
  const raw = fs.readFileSync(path.join(__dirname, 'chat-wordlist.json'), 'utf8');
  WORDS = JSON.parse(raw).map(w => String(w).toLowerCase());
} catch (e) {
  console.warn('[chat-filter] could not load chat-wordlist.json:', e.message);
}
const WORD_SET = new Set(WORDS);

// Common l33t-speak substitutions back to letters before matching.
// Keeps the wordlist clean; no need to enumerate every variant.
const LEET_MAP = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' };

function normalize(token) {
  return token.toLowerCase().replace(/[01345 7@$!]/g, ch => LEET_MAP[ch] || ch);
}

function filter(text) {
  if (!text || typeof text !== 'string') return { text: text || '', hits: [] };
  const hits = [];
  // Split on word boundaries so we preserve original spacing/punctuation
  // when reassembling. Word characters get checked individually.
  const cleaned = text.replace(/\w+/g, (token) => {
    const norm = normalize(token);
    if (WORD_SET.has(norm)) {
      hits.push(norm);
      return '*'.repeat(token.length);
    }
    return token;
  });
  return { text: cleaned, hits };
}

module.exports = { filter };

// UmmahCast — "Resume Listening" pill
// Persists across pages via localStorage; one-tap returns the listener to the
// last room they joined. Does NOT keep audio playing through navigation
// (multi-page architecture); the pill click re-opens the listen page and
// auto-clicks Join if the user already entered a name there before.
(function renderResumePill() {
  const KEY = 'uc.lastRoom';
  const TTL_MS = 24 * 60 * 60 * 1000;

  // Suppress on listen page itself — no point pointing back to where we already are
  if (/\/listen(\/|$|\?)/.test(window.location.pathname + window.location.search)) return;

  let entry;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    entry = JSON.parse(raw);
  } catch { return; }

  if (!entry || !entry.orgSlug || !entry.roomSlug) return;

  const now = Date.now();
  if (entry.ts && (now - entry.ts) > TTL_MS) return;
  if (entry.dismissedTs && (now - entry.dismissedTs) < TTL_MS) return;

  const pill = document.createElement('div');
  pill.className = 'resume-pill';
  pill.setAttribute('role', 'region');
  pill.setAttribute('aria-label', 'Resume listening');

  const link = document.createElement('a');
  link.className = 'resume-pill-link';
  link.href = `/${encodeURIComponent(entry.orgSlug)}/listen?room=${encodeURIComponent(entry.roomSlug)}&autoresume=1`;
  link.innerHTML = '<span class="resume-pill-icon" aria-hidden="true">▶</span><span class="resume-pill-text"></span>';
  link.querySelector('.resume-pill-text').textContent = entry.roomName ? `Resume ${entry.roomName}` : 'Resume listening';

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'resume-pill-dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.textContent = '×';
  dismiss.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
      cur.dismissedTs = Date.now();
      localStorage.setItem(KEY, JSON.stringify(cur));
    } catch {}
    pill.remove();
  });

  pill.appendChild(link);
  pill.appendChild(dismiss);
  document.body.appendChild(pill);
})();

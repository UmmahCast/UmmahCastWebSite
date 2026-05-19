// UmmahCast Follow Bells — modern, optimistic, no-login subscriptions
// API:
//   FollowBell.attach(el, { orgSlug, roomSlug })  -> turns el into a bell button
//   FollowBell.hydrate(orgSlug)                    -> updates all bells for the org from server
//   FollowBell.token()                             -> current token in localStorage (or null)
(function () {
  const TOKEN_KEY_PREFIX = 'uc.token.';

  // SVG icons (single source of truth)
  const BELL_OUTLINE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
  const BELL_FILLED = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" fill="none"/></svg>';

  // Toast helper — uses ui.js if available, else falls back
  function toast(msg, kind) {
    if (window.Toast?.show) return window.Toast.show(msg, kind);
    if (window.toastShow) return window.toastShow(msg, kind);
    console.log('[follow]', msg);
  }

  function vibrate(ms) {
    try { navigator.vibrate?.(ms); } catch {}
  }

  function tokenKey(orgSlug) { return TOKEN_KEY_PREFIX + orgSlug; }
  function getToken(orgSlug) { try { return localStorage.getItem(tokenKey(orgSlug)); } catch { return null; } }
  function setToken(orgSlug, t) { try { localStorage.setItem(tokenKey(orgSlug), t); } catch {} }
  function clearToken(orgSlug) { try { localStorage.removeItem(tokenKey(orgSlug)); } catch {} }

  // Public API: get token for current page's org (best-effort)
  function currentToken() {
    try {
      const orgSlug = window._orgSlug || (window.location.pathname.replace(/^\//, '').split('/')[0]) || 'default';
      return getToken(orgSlug);
    } catch { return null; }
  }

  // Hydrate: fetch /api/preferences/{token}/rooms and mark all bells as following
  async function hydrate(orgSlug) {
    const token = getToken(orgSlug);
    if (!token) return;
    try {
      const res = await fetch(`/api/preferences/${token}/rooms`);
      if (!res.ok) {
        if (res.status === 404) clearToken(orgSlug); // stale token
        return;
      }
      const data = await res.json();
      const slugs = new Set(data.rooms || []);
      document.querySelectorAll(`.bell-btn[data-org="${orgSlug}"]`).forEach(btn => {
        const isFollowing = slugs.has(btn.dataset.room);
        setBellState(btn, isFollowing);
      });
    } catch {}
  }

  function setBellState(btn, following, animate) {
    btn.classList.toggle('following', !!following);
    btn.innerHTML = following ? BELL_FILLED : BELL_OUTLINE;
    btn.setAttribute('aria-label', following ? 'Following — click to unfollow' : 'Follow for notifications');
    btn.setAttribute('aria-pressed', following ? 'true' : 'false');
    btn.title = following ? 'Following — click to unfollow' : 'Get notified when this room goes live';
    if (animate) {
      btn.classList.remove('just-followed');
      void btn.offsetWidth; // restart animation
      btn.classList.add('just-followed');
    }
  }

  // Wraps an action with View Transitions when available
  function transition(fn) {
    if (document.startViewTransition) return document.startViewTransition(fn);
    return fn();
  }

  // Open the email-prompt dialog and resolve to entered email (or null on cancel)
  function promptEmail(roomName) {
    return new Promise(resolve => {
      const dlg = document.createElement('dialog');
      dlg.className = 'follow-dialog';
      dlg.innerHTML = `
        <form class="follow-dialog-inner" method="dialog">
          <h3>Get notified for ${escapeHtml(roomName)}</h3>
          <p>Enter your email and we'll let you know whenever this room goes live. You can change preferences or unsubscribe anytime.</p>
          <input type="email" name="email" placeholder="you@example.com" required maxlength="200" autocomplete="email">
          <p class="follow-dialog-error" data-role="err"></p>
          <div class="follow-dialog-buttons">
            <button type="button" class="btn-ghost" value="cancel">Cancel</button>
            <button type="submit" class="btn-primary" value="ok">Follow</button>
          </div>
        </form>`;
      document.body.appendChild(dlg);
      const form = dlg.querySelector('form');
      const input = form.querySelector('input[name="email"]');
      const err = form.querySelector('[data-role="err"]');
      const cancelBtn = form.querySelector('button[value="cancel"]');

      function close(value) {
        dlg.close();
        dlg.remove();
        resolve(value);
      }
      cancelBtn.addEventListener('click', () => close(null));
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
      // Click backdrop to close
      dlg.addEventListener('click', (e) => {
        const r = dlg.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close(null);
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const email = (input.value || '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          err.textContent = 'Please enter a valid email';
          err.classList.add('show');
          return;
        }
        close(email);
      });

      dlg.showModal();
      setTimeout(() => input.focus(), 50);
    });
  }

  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = String(s || ''); return d.innerHTML; }

  // Bell click handler
  async function onBellClick(btn) {
    const orgSlug = btn.dataset.org;
    const roomSlug = btn.dataset.room;
    const roomName = btn.dataset.roomName || roomSlug;
    const token = getToken(orgSlug);

    vibrate(40);

    if (!token) {
      // First time → email prompt
      const email = await promptEmail(roomName);
      if (!email) return;
      btn.classList.add('loading');
      try {
        const res = await fetch(`/api/orgs/${orgSlug}/rooms/${roomSlug}/follow`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const data = await res.json();
        if (!res.ok) {
          toast(data.error || 'Could not subscribe', 'error');
          return;
        }
        if (data.token) setToken(orgSlug, data.token);
        transition(() => setBellState(btn, true, true));
        toast(data.verified ? `Following ${roomName}` : `Almost there — check your email to verify`, 'success');
        // Refresh "Manage Preferences" link in nav drawer if present
        if (window.refreshNavPrefsLink) window.refreshNavPrefsLink();
      } catch {
        toast('Network error', 'error');
      } finally {
        btn.classList.remove('loading');
      }
      return;
    }

    // Already have a token — toggle the room (optimistic)
    const wasFollowing = btn.classList.contains('following');
    transition(() => setBellState(btn, !wasFollowing, !wasFollowing));
    btn.classList.add('loading');
    try {
      const res = await fetch(`/api/preferences/${token}/rooms/${roomSlug}/toggle`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        // Stale token? Clear and rollback
        if (res.status === 400 && /Invalid token/i.test(data.error || '')) {
          clearToken(orgSlug);
          transition(() => setBellState(btn, false));
          toast('Your subscription session expired — click again to follow', 'error');
        } else {
          transition(() => setBellState(btn, wasFollowing));
          toast(data.error || 'Could not update', 'error');
        }
        return;
      }
      // Confirm with server's authoritative state
      transition(() => setBellState(btn, data.following, data.following && !wasFollowing));
      toast(data.following ? `Following ${roomName}` : `Unfollowed ${roomName}`, 'success');
    } catch {
      transition(() => setBellState(btn, wasFollowing));
      toast('Network error', 'error');
    } finally {
      btn.classList.remove('loading');
    }
  }

  // Attach bell behavior to an element
  function attach(el, { orgSlug, roomSlug, roomName, following }) {
    el.classList.add('bell-btn');
    el.type = 'button';
    el.dataset.org = orgSlug;
    el.dataset.room = roomSlug;
    el.dataset.roomName = roomName || roomSlug;
    setBellState(el, !!following);
    el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onBellClick(el); });
    return el;
  }

  // Helper: build a fresh button element
  function create(opts) {
    const btn = document.createElement('button');
    return attach(btn, opts);
  }

  window.FollowBell = { attach, create, hydrate, token: currentToken, setToken, clearToken };
})();

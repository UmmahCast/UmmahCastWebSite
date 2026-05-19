// Forces a password change when must_change_password = 1 (set by superadmin
// after an emergency reset). Renders a blocking modal with a change-password
// form. On success the server clears the flag and we let them through.
//
// Mirrors the tos-gate.js pattern: blocks broadcaster surfaces only, no-ops
// for unauthenticated visitors and pages where forcing a change makes no sense.
(async function passwordGate() {
  const path = window.location.pathname;
  // Skip on login + onboarding pages — broadcaster isn't fully signed in there
  if (/^\/(broadcaster-login|setup-broadcaster|invite-broadcaster|terms|privacy)/.test(path)) return;

  let me;
  try {
    const res = await fetch('/api/broadcaster/me');
    if (!res.ok) return; // not signed in — no gate
    me = await res.json();
  } catch { return; }

  if (!me || !me.mustChangePassword) return;

  const overlay = document.createElement('div');
  overlay.className = 'pw-gate-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'pw-gate-title');
  overlay.innerHTML = `
    <div class="pw-gate-card">
      <h2 id="pw-gate-title" class="pw-gate-title">🔑 Set a new password</h2>
      <p class="pw-gate-body">An administrator reset your password. You must choose a new one before continuing.</p>
      <form id="pw-gate-form" autocomplete="off">
        <div class="pw-gate-field">
          <label for="pw-gate-current">Temporary password</label>
          <input type="password" id="pw-gate-current" required autocomplete="current-password">
        </div>
        <div class="pw-gate-field">
          <label for="pw-gate-new">New password (min 8 characters)</label>
          <input type="password" id="pw-gate-new" required minlength="8" autocomplete="new-password">
        </div>
        <div class="pw-gate-field">
          <label for="pw-gate-confirm">Confirm new password</label>
          <input type="password" id="pw-gate-confirm" required minlength="8" autocomplete="new-password">
        </div>
        <div id="pw-gate-msg" class="pw-gate-msg"></div>
        <button type="submit" class="btn-primary" id="pw-gate-submit">Set new password</button>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  const form = overlay.querySelector('#pw-gate-form');
  const msg = overlay.querySelector('#pw-gate-msg');
  const submit = overlay.querySelector('#pw-gate-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const oldPw = overlay.querySelector('#pw-gate-current').value;
    const newPw = overlay.querySelector('#pw-gate-new').value;
    const confirmPw = overlay.querySelector('#pw-gate-confirm').value;
    msg.textContent = '';
    msg.className = 'pw-gate-msg';
    if (newPw !== confirmPw) { msg.textContent = 'New passwords do not match.'; msg.classList.add('err'); return; }
    if (newPw.length < 8) { msg.textContent = 'Use at least 8 characters.'; msg.classList.add('err'); return; }
    if (newPw === oldPw) { msg.textContent = 'New password must be different from the temporary one.'; msg.classList.add('err'); return; }
    submit.disabled = true; submit.textContent = 'Saving…';
    try {
      const res = await fetch('/api/broadcaster/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        msg.textContent = err.error || 'Could not change password';
        msg.classList.add('err');
        submit.disabled = false; submit.textContent = 'Set new password';
        return;
      }
      overlay.remove();
      document.body.style.overflow = prevOverflow;
    } catch {
      msg.textContent = 'Network error — try again.';
      msg.classList.add('err');
      submit.disabled = false; submit.textContent = 'Set new password';
    }
  });
})();

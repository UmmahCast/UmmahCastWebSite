// TOS acceptance gate for broadcaster surfaces. Blocks the page with a modal
// if the signed-in broadcaster hasn't accepted the current TOS version. Reads
// state from /api/broadcaster/me; gracefully no-ops for non-broadcasters
// (the call returns 401, we just skip).
(async function tosGate() {
  // Skip on the TOS page itself + onboarding flows that already include a checkbox
  const path = window.location.pathname;
  if (/^\/(terms|privacy|apply|setup-broadcaster|invite-broadcaster|broadcaster-login)/.test(path)) return;

  let me;
  try {
    const res = await fetch('/api/broadcaster/me');
    if (!res.ok) return; // not signed in as broadcaster — nothing to gate
    me = await res.json();
  } catch { return; }

  if (!me || !me.currentTosVersion) return;
  if (me.tosAcceptedVersion === me.currentTosVersion) return;

  // Build blocking overlay
  const overlay = document.createElement('div');
  overlay.className = 'tos-gate-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'tos-gate-title');
  overlay.innerHTML = `
    <div class="tos-gate-card">
      <h2 id="tos-gate-title" class="tos-gate-title">📜 Updated Terms of Service</h2>
      <p class="tos-gate-body">Before you continue using your broadcaster account, please review and agree to UmmahCast's Terms of Service. They cover what content can be streamed (including copyright responsibilities), DMCA procedures, account security, and your responsibilities as an Organization representative.</p>
      <p class="tos-gate-body"><a href="/terms" target="_blank" rel="noopener">Read the full Terms of Service →</a></p>
      <label class="tos-gate-check">
        <input type="checkbox" id="tos-gate-checkbox">
        <span>I have read and agree to the Terms of Service.</span>
      </label>
      <div class="tos-gate-actions">
        <button type="button" class="btn-primary" id="tos-gate-accept" disabled>I Agree &amp; Continue</button>
        <button type="button" class="btn-stop" id="tos-gate-decline">Sign Out</button>
      </div>
      <p class="tos-gate-note">If you do not agree, you must sign out and discontinue use of your broadcaster account. Listeners can still use the site without accepting these terms.</p>
    </div>
  `;
  document.body.appendChild(overlay);
  // Lock background scroll
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  const checkbox = overlay.querySelector('#tos-gate-checkbox');
  const acceptBtn = overlay.querySelector('#tos-gate-accept');
  const declineBtn = overlay.querySelector('#tos-gate-decline');

  checkbox.addEventListener('change', () => { acceptBtn.disabled = !checkbox.checked; });

  acceptBtn.addEventListener('click', async () => {
    acceptBtn.disabled = true;
    acceptBtn.textContent = 'Saving…';
    try {
      const res = await fetch('/api/broadcaster/accept-tos', { method: 'POST' });
      if (!res.ok) throw new Error('accept failed');
      overlay.remove();
      document.body.style.overflow = prevOverflow;
    } catch {
      acceptBtn.disabled = false;
      acceptBtn.textContent = 'I Agree & Continue';
      alert('Could not record acceptance. Try again.');
    }
  });

  declineBtn.addEventListener('click', async () => {
    if (!confirm('Sign out without accepting? You will not be able to broadcast or manage your team until you accept.')) return;
    try { await fetch('/api/broadcaster/logout', { method: 'POST' }); } catch {}
    window.location.href = '/';
  });
})();

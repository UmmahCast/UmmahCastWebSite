// UmmahCast site footer — shared across all pages
(async function renderFooter() {
  // Don't render twice
  if (document.querySelector('footer.uc-footer')) return;

  // Detect broadcaster status (controls links shown)
  let broadcaster = null;
  try {
    const res = await fetch('/api/broadcaster/me');
    if (res.ok) broadcaster = await res.json();
  } catch {}

  const year = new Date().getFullYear();

  const footer = document.createElement('footer');
  footer.className = 'uc-footer';
  footer.innerHTML = `
    <div class="uc-footer-divider" aria-hidden="true"></div>
    <div class="uc-footer-inner">
      <div class="uc-footer-brand">
        <div class="uc-footer-wordmark">UmmahCast</div>
        <div class="uc-footer-bismillah">بسم الله الرحمن الرحيم</div>
        <div class="uc-footer-tagline">Your mosque, live in your ears. Free and open for all communities.</div>
        <a class="uc-kofi-btn" href="https://ko-fi.com/ummahcast" target="_blank" rel="noopener noreferrer" aria-label="Support UmmahCast on Ko-fi" data-track="kofi_click">
          <span class="uc-kofi-cup" aria-hidden="true">☕</span>
          <span>Support UmmahCast</span>
        </a>
      </div>

      <div class="uc-footer-cols">
        <div class="uc-footer-col">
          <div class="uc-footer-heading">Listen</div>
          <a href="/communities">Communities</a>
          <a href="/notifications-guide">Get notifications</a>
        </div>

        <div class="uc-footer-col">
          <div class="uc-footer-heading">For Mosques</div>
          ${broadcaster
            ? `<a href="/${broadcaster.orgSlug || 'default'}/broadcast">Broadcast Dashboard</a>
               <a href="/${broadcaster.orgSlug || 'default'}/settings">Settings</a>`
            : `<a href="/apply">Apply to broadcast</a>
               <a href="/broadcaster-login">Broadcaster sign in</a>`}
        </div>

        <div class="uc-footer-col">
          <div class="uc-footer-heading">Resources</div>
          <a href="/faq">FAQ</a>
          <a href="/timeline">Our Journey</a>
          <a href="/contact">Feedback &amp; Contact</a>
          <a href="/terms">Terms of Service</a>
          <a href="/privacy">Privacy Policy</a>
          <a href="/licenses">Open Source</a>
          <a href="https://github.com/UmmahCast/UmmahCastWebSite" target="_blank" rel="noopener noreferrer">Source code</a>
        </div>
      </div>
    </div>

    <div class="uc-footer-bottom">
      <span>© ${year} UmmahCast</span>
      <span class="uc-footer-sep">·</span>
      <span>Built with care for the Ummah</span>
    </div>
  `;

  document.body.appendChild(footer);
})();

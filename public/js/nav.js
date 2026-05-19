async function renderNav(page) {
  

  const pathParts = window.location.pathname.replace(/^\//, '').split('/');
  const nonOrgPaths = ['broadcaster-login', 'broadcaster-login.html', 'api', 'css', 'js', 'locales', 'sw.js', 'faq', 'faq.html', 'privacy', 'privacy.html', 'notifications-guide', 'notifications-guide.html', 'contact', 'contact.html', 'timeline', 'timeline.html', 'terms', 'terms.html', 'licenses', 'licenses.html', 'preferences', 'apply', 'admin', 'setup-broadcaster', 'communities', 'manifest.json', 'og-image.png', 'icon-192.png', 'icon-512.png'];
  const orgSlug = window._orgSlug || (pathParts[0] && !nonOrgPaths.includes(pathParts[0]) ? pathParts[0] : null);

  let broadcaster = null;
  try {
    const res = await fetch('/api/broadcaster/me');
    if (res.ok) broadcaster = await res.json();
  } catch {}

  const nav = document.createElement('nav');
  nav.setAttribute('role', 'navigation');
  nav.setAttribute('aria-label', 'Main navigation');
  nav.style.cssText = 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;width:100%;max-width:860px;margin-bottom:1rem;padding:0.6rem 0;';

  // Logo
  const left = document.createElement('a');
  left.href = '/';
  left.style.cssText = 'text-decoration:none;display:flex;align-items:center;gap:0.5rem;';
  left.innerHTML = `<span style="font-size:1.25rem;font-weight:700;color:var(--text);letter-spacing:-0.02em;">UmmahCast</span>`;

  // Right side
  const right = document.createElement('div');
  right.style.cssText = 'display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap;';

  // Nav link — plain text, muted
  const link = (href, text, active) => {
    const a = document.createElement('a');
    a.href = href; a.textContent = text;
    a.className = 'top-nav-desktop-only';
    a.style.cssText = `font-size:0.85rem;font-weight:500;color:${active ? 'var(--accent)' : 'var(--text-muted)'};text-decoration:none;padding:0.35rem 0.5rem;border-radius:var(--radius-pill);transition:all 0.15s;`;
    a.addEventListener('mouseenter', () => { a.style.color = 'var(--text)'; a.style.background = 'var(--surface-hover)'; });
    a.addEventListener('mouseleave', () => { a.style.color = active ? 'var(--accent)' : 'var(--text-muted)'; a.style.background = 'transparent'; });
    return a;
  };

  // Outline button — for login
  const outlineBtn = (href, text) => {
    const a = document.createElement('a');
    a.href = href; a.textContent = text;
    a.className = 'top-nav-desktop-only'; // hidden on mobile, bottom nav has "Broadcaster Login" in More
    a.style.cssText = 'font-size:0.8rem;font-weight:600;color:var(--accent);text-decoration:none;padding:0.35rem 0.85rem;border:1px solid var(--accent);border-radius:var(--radius-pill);transition:all 0.2s;';
    a.addEventListener('mouseenter', () => { a.style.background = 'var(--accent)'; a.style.color = 'white'; });
    a.addEventListener('mouseleave', () => { a.style.background = 'transparent'; a.style.color = 'var(--accent)'; });
    return a;
  };

  // Small ghost button — for logout
  const ghostBtn = (text, onclick) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.className = 'top-nav-desktop-only';
    b.style.cssText = 'width:auto;padding:0.3rem 0.65rem;font-size:0.8rem;min-height:auto;background:transparent;color:var(--text-muted);border:1px solid var(--border);border-radius:var(--radius-pill);transition:all 0.15s;';
    b.addEventListener('mouseenter', () => { b.style.background = 'var(--surface-hover)'; b.style.color = 'var(--text)'; });
    b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; b.style.color = 'var(--text-muted)'; });
    b.addEventListener('click', onclick);
    return b;
  };

  // Avatar circle — for authenticated state
  const avatar = (name, href) => {
    const a = document.createElement('a');
    a.href = href;
    a.style.cssText = 'display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:var(--accent);color:white;font-size:0.8rem;font-weight:700;text-decoration:none;text-transform:uppercase;';
    a.textContent = (name || 'A')[0];
    a.title = name || 'Account';
    return a;
  };

  const orgBase = orgSlug ? `/${orgSlug}` : '';
  const logoutFn = async () => { await fetch('/api/broadcaster/logout', { method: 'POST' }); window.location.href = '/'; };

  // Hamburger menu — added to right side AFTER all other nav items at the end
  const hamburger = document.createElement('button');
  hamburger.innerHTML = '☰';
  hamburger.className = 'top-nav-desktop-only';
  hamburger.style.cssText = 'width:auto;padding:0.3rem 0.5rem;font-size:1.1rem;min-height:auto;background:transparent;color:var(--text-muted);border:none;cursor:pointer;line-height:1;';
  hamburger.setAttribute('aria-label', 'Menu');
  hamburger.addEventListener('click', () => {
    let overlay = document.getElementById('hamburger-overlay');
    if (overlay) { overlay.remove(); return; }
    overlay = document.createElement('div');
    overlay.id = 'hamburger-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);z-index:9999;display:flex;justify-content:flex-end;';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    const panel = document.createElement('div');
    panel.style.cssText = 'width:260px;max-width:80vw;background:var(--surface);height:100%;padding:1.5rem;display:flex;flex-direction:column;gap:0.25rem;animation:slideIn 0.2s ease;';
    const menuLink = (href, icon, text) => {
      const a = document.createElement('a');
      a.href = href;
      a.style.cssText = 'display:flex;align-items:center;gap:0.75rem;padding:0.75rem 0.5rem;font-size:0.9rem;color:var(--text);text-decoration:none;border-radius:var(--radius);transition:background 0.15s;';
      a.innerHTML = `<span style="font-size:1.1rem;width:1.5rem;text-align:center;">${icon}</span>${text}`;
      a.addEventListener('mouseenter', () => a.style.background = 'var(--surface-hover)');
      a.addEventListener('mouseleave', () => a.style.background = 'transparent');
      return a;
    };
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '✕';
    closeBtn.style.cssText = 'width:auto;padding:0.25rem 0.5rem;font-size:1rem;min-height:auto;background:transparent;color:var(--text-muted);border:none;cursor:pointer;align-self:flex-end;margin-bottom:1rem;';
    closeBtn.addEventListener('click', () => overlay.remove());
    panel.appendChild(closeBtn);

    if (page !== 'landing' && page !== 'org-landing') panel.appendChild(menuLink(orgBase || '/', '🏠', 'Home'));

    // Show "My Email Preferences" if subscriber has a token for current org
    let userToken = null;
    try {
      const slug = orgSlug || 'default';
      userToken = localStorage.getItem('uc.token.' + slug);
    } catch {}
    if (userToken) panel.appendChild(menuLink('/preferences/' + userToken, '📧', 'My Email Preferences'));

    // "Show welcome" — re-trigger the onboarding card
    const welcomeRow = document.createElement('a');
    welcomeRow.href = '#';
    welcomeRow.style.cssText = 'display:flex;align-items:center;gap:0.75rem;padding:0.75rem 0.5rem;font-size:0.9rem;color:var(--text);text-decoration:none;border-radius:var(--radius);transition:background 0.15s;';
    welcomeRow.innerHTML = '<span style="font-size:1.1rem;width:1.5rem;text-align:center;">👋</span>Show Welcome';
    welcomeRow.addEventListener('mouseenter', () => welcomeRow.style.background = 'var(--surface-hover)');
    welcomeRow.addEventListener('mouseleave', () => welcomeRow.style.background = 'transparent');
    welcomeRow.addEventListener('click', (e) => {
      e.preventDefault();
      overlay.remove();
      if (window.Onboarding?.forceShow) window.Onboarding.forceShow();
      else window.location.href = '/';
    });
    panel.appendChild(welcomeRow);

    panel.appendChild(menuLink('/faq', '❓', 'FAQ'));
    panel.appendChild(menuLink('/contact', '📬', 'Feedback & Contact'));
    panel.appendChild(menuLink('/timeline', '📅', 'Our Journey'));
    panel.appendChild(menuLink('/notifications-guide', '🔔', 'Notification Setup'));
    panel.appendChild(menuLink('/privacy', '🔒', 'Privacy Policy'));

    if (broadcaster?.isSuperadmin) {
      const sep2 = document.createElement('div');
      sep2.style.cssText = 'border-top:1px solid var(--border);margin:0.5rem 0;';
      panel.appendChild(sep2);
      panel.appendChild(menuLink('/admin/stats', '📊', 'Admin Stats'));
      panel.appendChild(menuLink('/admin/applications', '📬', 'Org Applications'));
      panel.appendChild(menuLink('/admin/photos', '📷', 'Photo Approvals'));
    }

    // Theme toggle
    const themeBtn = document.createElement('a');
    themeBtn.href = '#';
    themeBtn.style.cssText = 'display:flex;align-items:center;gap:0.75rem;padding:0.75rem 0.5rem;font-size:0.9rem;color:var(--text);text-decoration:none;border-radius:var(--radius);transition:background 0.15s;';
    function themeBtnLabel() {
      const t = window.UCTheme?.get?.() || 'dark';
      return t === 'light'
        ? '<span style="font-size:1.1rem;width:1.5rem;text-align:center;">🌙</span>Switch to Dark Mode'
        : '<span style="font-size:1.1rem;width:1.5rem;text-align:center;">☀️</span>Switch to Light Mode';
    }
    themeBtn.innerHTML = themeBtnLabel();
    themeBtn.addEventListener('mouseenter', () => themeBtn.style.background = 'var(--surface-hover)');
    themeBtn.addEventListener('mouseleave', () => themeBtn.style.background = 'transparent');
    themeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      window.UCTheme?.toggle?.();
      themeBtn.innerHTML = themeBtnLabel();
    });
    panel.appendChild(themeBtn);
    if (broadcaster) {
      const sep = document.createElement('div');
      sep.style.cssText = 'border-top:1px solid var(--border);margin:0.5rem 0;';
      panel.appendChild(sep);
      panel.appendChild(menuLink(`${orgBase || `/${broadcaster.orgSlug || 'default'}`}/broadcast`, '📡', 'Dashboard'));
      panel.appendChild(menuLink(`${orgBase || `/${broadcaster.orgSlug || 'default'}`}/settings`, '⚙️', 'Settings'));
    }
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  });
  if (page === 'landing') {
    if (broadcaster) {
      const dashOrg = broadcaster.orgSlug || 'default';
      right.appendChild(link(`/${dashOrg}/broadcast`, 'Dashboard'));
      if (broadcaster.isSuperadmin) right.appendChild(link(`/${dashOrg}/settings`, 'Settings'));
      right.appendChild(ghostBtn('Logout', logoutFn));
      right.appendChild(avatar(broadcaster.displayName, `/${dashOrg}/broadcast`));
    } else {
      right.appendChild(outlineBtn('/broadcaster-login', 'Broadcaster Login'));
    }
  } else if (page === 'org-landing') {
    if (broadcaster) {
      const canManage = broadcaster.isSuperadmin || broadcaster.orgSlug === orgSlug;
      if (canManage) right.appendChild(link(`${orgBase}/broadcast`, 'Dashboard'));
      if (canManage) right.appendChild(link(`${orgBase}/settings`, 'Settings'));
      right.appendChild(ghostBtn('Logout', logoutFn));
      right.appendChild(avatar(broadcaster.displayName, `${orgBase}/broadcast`));
    } else {
      right.appendChild(outlineBtn('/broadcaster-login', 'Broadcaster Login'));
    }
  } else if (page === 'listen') {
    right.appendChild(link(orgBase || '/', 'Rooms'));
    if (broadcaster) {
      right.appendChild(link(`${orgBase}/broadcast`, 'Dashboard'));
      right.appendChild(avatar(broadcaster.displayName, `${orgBase}/broadcast`));
    }
  } else if (page === 'broadcast' || page === 'settings') {
    if (page === 'broadcast') {
      const roomsLink = link('#', 'Rooms');
      roomsLink.addEventListener('click', (e) => {
        e.preventDefault();
        if (typeof backToRoomPicker === 'function') backToRoomPicker();
        else window.location.href = orgBase || '/';
      });
      right.appendChild(roomsLink);
      // Hide Settings link for shared accounts (they can't access it)
      if (broadcaster?.accountType !== 'shared') right.appendChild(link(`${orgBase}/settings`, 'Settings'));
    } else {
      right.appendChild(link(orgBase || '/', 'Rooms'));
      right.appendChild(link(`${orgBase}/broadcast`, 'Dashboard'));
    }
    right.appendChild(ghostBtn('Logout', logoutFn));
    if (broadcaster) right.appendChild(avatar(broadcaster.displayName, `${orgBase}/settings`));
  } else if (page === 'login') {
    right.appendChild(link('/', 'Rooms'));
  } else if (page === 'info') {
    // Info pages always link home
    right.appendChild(link('/', 'Home'));
    if (broadcaster) {
      right.appendChild(link(`/${broadcaster.orgSlug || 'default'}/broadcast`, 'Dashboard'));
    }
  }

  // Hamburger first — stable "more" anchor, separated from session/identity controls
  right.insertBefore(hamburger, right.firstChild);

  nav.appendChild(left);
  nav.appendChild(right);
  document.body.insertBefore(nav, document.body.firstChild);
}

// Bottom Tab Bar — role-aware, mobile-only (hidden on desktop via CSS)
(async function renderBottomNav() {
  // Detect org and current page
  const path = window.location.pathname;
  const pathParts = path.replace(/^\//, '').split('/');
  const nonOrgPaths = ['broadcaster-login', 'faq', 'privacy', 'notifications-guide', 'contact', 'timeline', 'preferences', 'apply', 'admin', 'setup-broadcaster', 'communities', 'faq.html', 'privacy.html', 'notifications-guide.html', 'contact.html', 'timeline.html', 'broadcaster-login.html', ''];
  const orgSlug = window._orgSlug || (pathParts[0] && !nonOrgPaths.includes(pathParts[0]) ? pathParts[0] : null);
  const orgBase = orgSlug ? `/${orgSlug}` : '';

  // Detect current page for active state
  const pageName = pathParts[pathParts.length - 1] || pathParts[0] || '';
  let activePage = 'home';
  if (pageName === 'listen' || path.includes('/listen')) activePage = 'listen';
  else if (pageName === 'communities') activePage = 'communities';
  else if (pageName === 'broadcast' || path.includes('/broadcast')) activePage = 'broadcast';
  else if (pageName === 'settings' || path.includes('/settings')) activePage = 'settings';
  else if (['faq', 'faq.html', 'privacy', 'privacy.html', 'notifications-guide', 'notifications-guide.html', 'contact', 'contact.html', 'timeline', 'timeline.html'].includes(pageName)) activePage = 'more';

  // Check if broadcaster
  let broadcaster = null;
  try {
    const res = await fetch('/api/broadcaster/me');
    if (res.ok) broadcaster = await res.json();
  } catch {}

  // Build nav items
  const items = [];

  // Home — always goes to hero landing page
  items.push({
    icon: '🏠', label: 'Home',
    href: '/',
    active: activePage === 'home' && !orgSlug
  });

  // Listen — for listeners (goes to dedicated communities page)
  if (!broadcaster) {
    items.push({
      icon: '📻', label: 'Listen',
      href: '/communities',
      active: activePage === 'listen' || activePage === 'communities' || (activePage === 'home' && !!orgSlug)
    });
  }

  // Broadcast — for broadcasters
  if (broadcaster) {
    items.push({
      icon: '🎙️', label: 'Broadcast',
      href: `${orgBase || `/${broadcaster.orgSlug || 'default'}`}/broadcast`,
      active: activePage === 'broadcast'
    });
  }

  // Alerts — for listeners
  if (!broadcaster) {
    items.push({
      icon: '🔔', label: 'Alerts',
      href: '/notifications-guide',
      active: false
    });
  }

  // Settings — for broadcasters
  if (broadcaster) {
    items.push({
      icon: '⚙️', label: 'Settings',
      href: `${orgBase || `/${broadcaster.orgSlug || 'default'}`}/settings`,
      active: activePage === 'settings'
    });
  }

  // More — always
  items.push({
    icon: '☰', label: 'More',
    href: '#more',
    active: activePage === 'more',
    isMore: true
  });

  // Render
  const nav = document.createElement('nav');
  nav.className = 'bottom-nav';
  nav.setAttribute('aria-label', 'Bottom navigation');

  items.forEach(item => {
    const a = document.createElement('a');
    a.className = 'bottom-nav-item' + (item.active ? ' active' : '');
    a.href = item.href;
    a.innerHTML = `<span class="bottom-nav-icon">${item.icon}</span>${item.label}`;

    if (item.isMore) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        toggleMoreDrawer(broadcaster, orgBase);
      });
    }

    nav.appendChild(a);
  });

  document.body.appendChild(nav);
})();

function toggleMoreDrawer(broadcaster, orgBase) {
  // Close if open
  const existing = document.querySelector('.more-drawer');
  const existingBackdrop = document.querySelector('.more-drawer-backdrop');
  if (existing) { existing.remove(); existingBackdrop?.remove(); return; }

  // Backdrop
  const backdrop = document.createElement('div');
  backdrop.className = 'more-drawer-backdrop';
  backdrop.addEventListener('click', () => { drawer.remove(); backdrop.remove(); });

  // Drawer
  const drawer = document.createElement('div');
  drawer.className = 'more-drawer';

  const link = (href, icon, text) => {
    const a = document.createElement('a');
    a.className = 'more-drawer-item';
    a.href = href;
    a.innerHTML = `<span style="font-size:1.1rem;width:1.5rem;text-align:center;">${icon}</span>${text}`;
    a.addEventListener('click', () => { drawer.remove(); backdrop.remove(); });
    return a;
  };

  // If user has an email subscription token in localStorage for this org, show preferences link
  let userToken = null;
  try {
    const slug = orgBase ? orgBase.replace(/^\//, '') : 'default';
    userToken = localStorage.getItem('uc.token.' + slug);
  } catch {}
  if (userToken) {
    drawer.appendChild(link(`/preferences/${userToken}`, '📧', 'My Email Preferences'));
  }

  // "Show welcome" — re-trigger the onboarding card
  const welcomeLink = document.createElement('a');
  welcomeLink.className = 'more-drawer-item';
  welcomeLink.href = '#';
  welcomeLink.innerHTML = '<span style="font-size:1.1rem;width:1.5rem;text-align:center;">👋</span>Show Welcome';
  welcomeLink.addEventListener('click', (e) => {
    e.preventDefault();
    drawer.remove(); backdrop.remove();
    if (window.Onboarding?.forceShow) window.Onboarding.forceShow();
    else window.location.href = '/';
  });
  drawer.appendChild(welcomeLink);

  drawer.appendChild(link('/faq', '❓', 'FAQ'));
  drawer.appendChild(link('/contact', '📬', 'Feedback & Contact'));
  drawer.appendChild(link('/timeline', '📅', 'Our Journey'));
  drawer.appendChild(link('/notifications-guide', '🔔', 'Notification Setup'));
  drawer.appendChild(link('/privacy', '🔒', 'Privacy Policy'));

  if (broadcaster?.isSuperadmin) {
    const sep = document.createElement('div');
    sep.style.cssText = 'border-top:1px solid var(--border);margin:0.5rem 0;';
    drawer.appendChild(sep);
    drawer.appendChild(link('/admin/stats', '📊', 'Admin Stats'));
    drawer.appendChild(link('/admin/applications', '📬', 'Org Applications'));
    drawer.appendChild(link('/admin/photos', '📷', 'Photo Approvals'));
  }

  // Theme toggle
  const themeRow = document.createElement('a');
  themeRow.className = 'more-drawer-item';
  themeRow.href = '#';
  function themeLabel() {
    const t = window.UCTheme?.get?.() || 'dark';
    return t === 'light'
      ? '<span style="font-size:1.1rem;width:1.5rem;text-align:center;">🌙</span>Switch to Dark Mode'
      : '<span style="font-size:1.1rem;width:1.5rem;text-align:center;">☀️</span>Switch to Light Mode';
  }
  themeRow.innerHTML = themeLabel();
  themeRow.addEventListener('click', (e) => {
    e.preventDefault();
    window.UCTheme?.toggle?.();
    themeRow.innerHTML = themeLabel();
  });
  drawer.appendChild(themeRow);

  if (broadcaster) {
    const sep = document.createElement('div');
    sep.style.cssText = 'border-top:1px solid var(--border);margin:0.5rem 0;';
    drawer.appendChild(sep);

    const logoutLink = document.createElement('a');
    logoutLink.className = 'more-drawer-item';
    logoutLink.href = '#';
    logoutLink.innerHTML = '<span style="font-size:1.1rem;width:1.5rem;text-align:center;">🚪</span>Logout';
    logoutLink.addEventListener('click', async (e) => {
      e.preventDefault();
      await fetch('/api/broadcaster/logout', { method: 'POST' });
      window.location.href = '/';
    });
    drawer.appendChild(logoutLink);
  } else {
    const sep = document.createElement('div');
    sep.style.cssText = 'border-top:1px solid var(--border);margin:0.5rem 0;';
    drawer.appendChild(sep);
    drawer.appendChild(link('/broadcaster-login', '🔑', 'Broadcaster Login'));
  }

  document.body.appendChild(backdrop);
  document.body.appendChild(drawer);
}

// Theme manager — load synchronously in <head> to avoid flash of wrong theme
(function () {
  const STORAGE_KEY = 'uc.theme';
  const DEFAULT = 'dark';

  function getStored() {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
  }
  function getSystem() {
    try { return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; } catch { return DEFAULT; }
  }
  function effectiveTheme() {
    const stored = getStored();
    if (stored === 'light' || stored === 'dark') return stored;
    return DEFAULT;
  }
  function apply(theme) {
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
  }
  function set(theme) {
    try { localStorage.setItem(STORAGE_KEY, theme); } catch {}
    apply(theme);
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
  }
  function toggle() {
    const next = effectiveTheme() === 'light' ? 'dark' : 'light';
    set(next);
    return next;
  }

  // Apply immediately
  apply(effectiveTheme());

  window.UCTheme = { get: effectiveTheme, set, toggle, getSystem };
})();

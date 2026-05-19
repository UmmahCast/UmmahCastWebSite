// Lightweight, privacy-conscious analytics: no third-party scripts, no IDs,
// no fingerprinting — just server-side counters of which pages get hit and
// which CTAs get clicked. Used for the marketing dashboard, not user tracking.
(function () {
  function track(event, meta) {
    try {
      const payload = JSON.stringify({ event, meta: meta || {} });
      const url = '/api/event';
      // sendBeacon survives page-unload (good for outbound link clicks)
      if (typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
      } else {
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true,
        }).catch(function () {});
      }
    } catch (e) {}
  }

  // Auto: page view on load
  track('page_view', { path: location.pathname });

  // Click delegation: any element with [data-track="event_name"] reports
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-track]');
    if (el && el.dataset.track) track(el.dataset.track, {});
  });

  window.UCAnalytics = { track: track };
})();

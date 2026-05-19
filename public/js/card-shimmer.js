// Per-hover randomization of the conic-gradient border sweep on cards.
// Without this, every card animates identically — starting at the same angle,
// same direction, same speed — which reads as repetitive when you mouse from
// card to card. Each mouseenter rerolls duration, direction, starting phase,
// and color pair from a curated mosque-palette set.
(function() {
  'use strict';

  // Don't randomize for users who asked for reduced motion.
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // Color pairs — all tuned for the warm sandstone / deep malachite palette.
  // Each pair is [primary, secondary]; the sweep uses primary→secondary→primary.
  const palette = [
    ['var(--accent)',  'var(--gold)'],
    ['var(--gold)',    '#a8794a'],   // gold → copper
    ['var(--accent)',  '#7a9d6e'],   // green → sage
    ['#b8985c',        '#c4895c'],   // warm gold → terracotta
    ['var(--accent)',  'var(--accent-deep)'],
    ['var(--gold)',    'var(--accent)'],
  ];

  const SELECTOR = '.card, .live-rooms .room-card, .community-card, .tile, .feature-card';

  function reroll(el) {
    // Skip live cards — their sweep is a status indicator, should stay consistent
    if (el.classList.contains('card-live') || el.classList.contains('live')) return;

    const duration = 3 + Math.random() * 5;                 // 3.0s – 8.0s
    const direction = Math.random() < 0.5 ? 'normal' : 'reverse';
    const delay = -(Math.random() * duration);              // negative offset → randomized starting phase
    const [colorA, colorB] = palette[Math.floor(Math.random() * palette.length)];

    el.style.setProperty('--sweep-duration', duration.toFixed(2) + 's');
    el.style.setProperty('--sweep-direction', direction);
    el.style.setProperty('--sweep-delay', delay.toFixed(2) + 's');
    el.style.setProperty('--sweep-color-a', colorA);
    el.style.setProperty('--sweep-color-b', colorB);
  }

  // One delegated listener — handles cards added dynamically after page load
  // (community grids, live-rooms list, etc.) without needing reattachment.
  document.addEventListener('mouseover', function(e) {
    const card = e.target.closest(SELECTOR);
    if (!card) return;
    // Only reroll on a true mouse-enter — not on every movement within the card.
    if (e.relatedTarget && card.contains(e.relatedTarget)) return;
    reroll(card);
  });
})();

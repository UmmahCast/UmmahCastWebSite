// ===== Toast Notification System =====
const ToastManager = {
  container: null,

  init() {
    if (this.container) return;
    this.container = document.createElement('div');
    this.container.className = 'toast-container';
    this.container.setAttribute('role', 'status');
    this.container.setAttribute('aria-live', 'polite');
    document.body.appendChild(this.container);
  },

  show(message, icon, duration) {
    this.init();
    const toast = document.createElement('div');
    toast.className = 'toast';
    if (icon) {
      const iconEl = document.createElement('span');
      iconEl.className = 'toast-icon';
      iconEl.textContent = icon;
      toast.appendChild(iconEl);
    }
    const textEl = document.createElement('span');
    textEl.className = 'toast-text';
    textEl.textContent = message;
    toast.appendChild(textEl);
    this.container.appendChild(toast);

    // Auto-dismiss
    setTimeout(() => {
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 250);
    }, duration || 3500);

    // Max 4 toasts visible
    while (this.container.children.length > 4) {
      this.container.children[0].remove();
    }
  },

  info(msg) { this.show(msg, 'ℹ️'); },
  success(msg) { this.show(msg, '✓'); },
  live(msg) { this.show(msg, '🔴'); },
  listener(msg) { this.show(msg, '👤'); },
  reaction(msg) { this.show(msg, '✨', 2000); },
};

// ===== First-Visit Onboarding (two-path: listener vs broadcaster) =====
const Onboarding = {
  KEY: 'uc_onboarded',

  shouldShow() {
    return !localStorage.getItem(this.KEY);
  },

  // opts: { listenTarget?: 'communities'|'rooms', onListen?: fn }
  show(opts = {}) {
    if (!this.shouldShow()) return;

    const overlay = document.createElement('div');
    overlay.className = 'onboarding-overlay';
    overlay.innerHTML = `
      <div class="onboarding-card" style="max-width:460px;">
        <div style="text-align:center;">
          <div style="font-size:1.6rem;font-weight:700;margin-bottom:0.25rem;">As-salamu alaykum 👋</div>
          <div style="font-size:0.9rem;color:var(--text-muted);margin-bottom:1.5rem;">Welcome to UmmahCast — what brings you here?</div>
        </div>

        <button type="button" class="onboard-path" data-path="listen" style="display:flex;align-items:flex-start;gap:0.75rem;width:100%;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.1rem;cursor:pointer;text-align:left;margin-bottom:0.6rem;color:var(--text);font-family:inherit;transition:border-color 0.15s,background 0.15s;">
          <span style="font-size:1.6rem;line-height:1;">🎧</span>
          <span style="flex:1;min-width:0;">
            <strong style="display:block;font-size:0.95rem;margin-bottom:0.2rem;">I want to listen</strong>
            <span style="font-size:0.8rem;color:var(--text-muted);line-height:1.5;">Tune in to live broadcasts and recordings from mosque communities.</span>
          </span>
        </button>

        <button type="button" class="onboard-path" data-path="broadcast" style="display:flex;align-items:flex-start;gap:0.75rem;width:100%;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.1rem;cursor:pointer;text-align:left;margin-bottom:0.5rem;color:var(--text);font-family:inherit;transition:border-color 0.15s,background 0.15s;">
          <span style="font-size:1.6rem;line-height:1;">🕌</span>
          <span style="flex:1;min-width:0;">
            <strong style="display:block;font-size:0.95rem;margin-bottom:0.2rem;">I represent a mosque</strong>
            <span style="font-size:0.8rem;color:var(--text-muted);line-height:1.5;">Apply to broadcast on UmmahCast — free for all communities.</span>
          </span>
        </button>

        <div style="text-align:center;margin-top:1rem;">
          <a href="#" id="onboard-skip" style="font-size:0.8rem;color:var(--text-muted);">Just looking around →</a>
        </div>
        <div style="margin-top:1rem;font-size:0.7rem;color:var(--text-muted);text-align:center;">
          Already a broadcaster? <a href="/broadcaster-login" style="color:var(--accent);">Sign in</a>
        </div>
        <div style="margin-top:0.5rem;font-size:0.65rem;color:var(--text-muted);text-align:center;">
          Essential cookies only — no tracking. <a href="/privacy" style="color:var(--text-muted);">Privacy Policy</a>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelectorAll('.onboard-path').forEach(btn => {
      btn.addEventListener('mouseenter', () => { btn.style.borderColor = 'var(--accent)'; btn.style.background = 'var(--surface-hover)'; });
      btn.addEventListener('mouseleave', () => { btn.style.borderColor = 'var(--border)'; btn.style.background = 'var(--bg)'; });
      btn.addEventListener('click', () => {
        const path = btn.dataset.path;
        Onboarding.dismiss();
        if (path === 'broadcast') {
          window.location.href = '/apply';
        } else if (path === 'listen') {
          if (typeof opts.onListen === 'function') {
            opts.onListen();
          } else {
            // Default: scroll to rooms section if present, else go to /communities
            const rooms = document.getElementById('rooms') || document.getElementById('orgs-list');
            if (rooms) rooms.scrollIntoView({ behavior: 'smooth' });
            else window.location.href = '/communities';
          }
        }
      });
    });

    document.getElementById('onboard-skip').addEventListener('click', (e) => { e.preventDefault(); Onboarding.dismiss(); });

    // Also dismiss on overlay click (outside card)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) Onboarding.dismiss();
    });
  },

  dismiss() {
    localStorage.setItem(this.KEY, '1');
    const overlay = document.querySelector('.onboarding-overlay');
    if (overlay) {
      overlay.style.animation = 'fadeIn 0.2s ease reverse';
      setTimeout(() => overlay.remove(), 200);
    }
  },

  // Re-show even if dismissed — used by "Show me again" links if we add them later
  forceShow(opts) {
    localStorage.removeItem(this.KEY);
    this.show(opts);
  },
};

// ===== Skeleton Loaders =====
window.Onboarding = Onboarding;
window.ToastManager = ToastManager;

function showSkeleton(container, count) {
  container.innerHTML = '';
  for (let i = 0; i < (count || 3); i++) {
    const card = document.createElement('div');
    card.className = 'skeleton skeleton-card card';
    card.innerHTML = `
      <div style="flex:1;">
        <div class="skeleton skeleton-text" style="width:${60 + Math.random() * 30}%;"></div>
        <div class="skeleton skeleton-text-sm"></div>
      </div>
      <div class="skeleton skeleton-btn"></div>
    `;
    container.appendChild(card);
  }
}

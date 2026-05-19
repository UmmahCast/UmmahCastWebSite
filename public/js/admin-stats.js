// Admin stats dashboard — fetch + render with vanilla SVG charts

(async function () {
  // Auth check
  let me = null;
  try {
    const res = await fetch('/api/broadcaster/me');
    if (res.ok) me = await res.json();
  } catch {}
  if (!me || !me.isSuperadmin) {
    document.getElementById('stats-sub').style.display = 'none';
    document.getElementById('auth-error').style.display = 'block';
    return;
  }

  document.getElementById('stats-sub').textContent = `Signed in as ${me.displayName} · UTC ${new Date().toISOString().slice(0, 10)}`;
  document.getElementById('dashboard').style.display = 'block';

  // Load all sections in parallel
  const [overview, email, listeners, rooms, recordings, siteEvents] = await Promise.all([
    j('/api/admin/stats/overview'),
    j('/api/admin/stats/email'),
    j('/api/admin/stats/listeners'),
    j('/api/admin/stats/rooms'),
    j('/api/admin/stats/recordings'),
    j('/api/admin/site-events?days=7'),
  ]);

  if (overview) renderOverview(overview);
  if (email) { renderEmailGauges(email.today); renderEmailHistory(email.history, email.today); }
  if (listeners) renderListenerChart(listeners);
  if (rooms) renderTopRooms(rooms.topRooms || []);
  if (recordings) renderStorage(recordings);
  if (siteEvents) renderSiteEvents(siteEvents);
})();

function renderSiteEvents(data) {
  const tbody = document.querySelector('#site-events-table tbody');
  if (!tbody) return;
  if (!data.events || data.events.length === 0) {
    tbody.innerHTML = '<tr><td colspan="2" style="text-align:center;color:var(--text-muted);">No events recorded yet.</td></tr>';
    return;
  }
  // Friendly labels
  const LABEL = {
    page_view: 'Page views',
    apply_click: 'Apply CTA clicks',
    kofi_click: 'Ko-fi support clicks',
    sample_play: 'Sample broadcast plays',
    listen_join: 'Listen joins',
    broadcaster_login_open: 'Broadcaster login opens',
    share_click: 'Share clicks',
  };
  tbody.innerHTML = data.events.map(e =>
    `<tr><td>${esc(LABEL[e.event] || e.event)}</td><td class="num">${e.count}</td></tr>`
  ).join('');
}

async function j(url) {
  try { const r = await fetch(url); if (!r.ok) return null; return await r.json(); } catch { return null; }
}

function fmtBytes(b) {
  if (!b) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function esc(s) { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; }
function cssVar(name, fb) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
}

function renderOverview(o) {
  const tiles = [
    { label: 'Organizations', num: o.orgs },
    { label: 'Verified Subscribers', num: o.verifiedSubs },
    { label: 'Broadcasts (7d)', num: o.broadcasts7d },
    { label: 'Recordings', num: o.recordings },
    { label: 'Disk Used', num: fmtBytes(o.diskBytes) },
    { label: 'Broadcasters', num: o.broadcasters },
  ];
  document.getElementById('overview').innerHTML = tiles.map(t =>
    `<div class="tile"><div class="label">${esc(t.label)}</div><div class="num">${esc(t.num)}</div></div>`
  ).join('');
}

function renderEmailGauges(providers) {
  const html = providers.map(p => {
    const pct = p.limit ? Math.min(100, Math.round((p.sent / p.limit) * 100)) : 0;
    const cls = pct >= 100 ? 'danger' : (pct >= 90 ? 'warn' : '');
    return `<div class="gauge ${cls}">
      <div class="name">${esc(p.provider)}</div>
      <div class="bar"><div class="bar-fill" style="width:${pct}%;"></div></div>
      <div class="meta"><span>${esc(p.sent)} sent</span><span>${p.limit ? esc(p.limit) + ' limit' : 'no limit'}</span></div>
    </div>`;
  }).join('');
  document.getElementById('email-gauges').innerHTML = html || '<div class="help">No SMTP providers configured.</div>';
}

// Stacked bar chart for email history (last 30 days)
function renderEmailHistory(history, today) {
  const container = document.getElementById('email-history-chart');
  const legend = document.getElementById('email-legend');
  const providers = Array.from(new Set([...(today || []).map(t => t.provider), ...history.map(h => h.provider)]));
  const palette = ['#2d8a4e', '#6366f1', '#c9a84c', '#ec4899', '#06b6d4', '#f97316', '#8b5cf6', '#22c55e'];
  const colorFor = name => palette[providers.indexOf(name) % palette.length];

  // Build day buckets for last 30 days
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const dayMap = {};
  for (const d of days) dayMap[d] = {};
  for (const r of history) {
    if (dayMap[r.date]) dayMap[r.date][r.provider] = (dayMap[r.date][r.provider] || 0) + r.sent;
  }

  // Find max stack height
  let maxStack = 0;
  for (const d of days) {
    const total = providers.reduce((s, p) => s + (dayMap[d][p] || 0), 0);
    if (total > maxStack) maxStack = total;
  }
  if (maxStack === 0) maxStack = 1;

  // Render SVG
  const W = 800, H = 220, padL = 30, padB = 24, padT = 8, padR = 8;
  const chartW = W - padL - padR, chartH = H - padT - padB;
  const barW = chartW / days.length;

  let bars = '';
  days.forEach((d, i) => {
    let yCursor = padT + chartH;
    for (const p of providers) {
      const v = dayMap[d][p] || 0;
      if (v <= 0) continue;
      const h = (v / maxStack) * chartH;
      yCursor -= h;
      bars += `<rect x="${padL + i * barW + 1}" y="${yCursor}" width="${Math.max(1, barW - 2)}" height="${h}" fill="${colorFor(p)}"><title>${esc(d)} · ${esc(p)}: ${esc(v)}</title></rect>`;
    }
  });

  // Y-axis labels (max + half)
  const muted = cssVar('--text-muted', '#8a8a97');
  const border = cssVar('--border', '#2a2a33');
  const yLabels = `
    <text x="${padL - 6}" y="${padT + 4}" text-anchor="end" font-size="10" fill="${muted}">${maxStack}</text>
    <text x="${padL - 6}" y="${padT + chartH / 2 + 4}" text-anchor="end" font-size="10" fill="${muted}">${Math.round(maxStack / 2)}</text>
    <text x="${padL - 6}" y="${padT + chartH + 4}" text-anchor="end" font-size="10" fill="${muted}">0</text>
    <line x1="${padL}" y1="${padT + chartH}" x2="${W - padR}" y2="${padT + chartH}" stroke="${border}" stroke-width="1"/>
  `;

  // X-axis: every 5 days
  let xLabels = '';
  days.forEach((d, i) => {
    if (i % 5 === 0 || i === days.length - 1) {
      const x = padL + i * barW + barW / 2;
      const label = d.slice(5);  // MM-DD
      xLabels += `<text x="${x}" y="${H - 6}" text-anchor="middle" font-size="10" fill="${muted}">${label}</text>`;
    }
  });

  container.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${yLabels}${bars}${xLabels}</svg>`;
  legend.innerHTML = providers.map(p =>
    `<span class="legend-item"><span class="legend-swatch" style="background:${colorFor(p)};"></span>${esc(p)}</span>`
  ).join('');
}

// Line chart for listener-minutes per day
function renderListenerChart(data) {
  const container = document.getElementById('listener-chart');
  // Build last 30 days bucket
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const map = {};
  for (const d of days) map[d] = 0;
  for (const r of (data.minutesPerDay || [])) if (map[r.day] !== undefined) map[r.day] = r.minutes || 0;

  let max = 0;
  for (const d of days) if (map[d] > max) max = map[d];
  if (max === 0) max = 1;

  const W = 800, H = 200, padL = 30, padB = 24, padT = 8, padR = 8;
  const chartW = W - padL - padR, chartH = H - padT - padB;
  const accent = cssVar('--accent', '#2d8a4e');
  const accentGlow = accent + '33';
  const muted = cssVar('--text-muted', '#8a8a97');
  const border = cssVar('--border', '#2a2a33');

  const points = days.map((d, i) => {
    const x = padL + (i / (days.length - 1)) * chartW;
    const y = padT + chartH - (map[d] / max) * chartH;
    return [x, y, d, map[d]];
  });
  const lineD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]} ${p[1]}`).join(' ');
  const fillD = `${lineD} L ${points[points.length - 1][0]} ${padT + chartH} L ${points[0][0]} ${padT + chartH} Z`;

  let dots = '';
  points.forEach((p, i) => {
    if (i % 3 === 0 || i === points.length - 1) {
      dots += `<circle cx="${p[0]}" cy="${p[1]}" r="2.5" fill="${accent}"><title>${esc(p[2])}: ${esc(p[3])} min</title></circle>`;
    }
  });

  let xLabels = '';
  days.forEach((d, i) => {
    if (i % 5 === 0 || i === days.length - 1) {
      const x = padL + (i / (days.length - 1)) * chartW;
      xLabels += `<text x="${x}" y="${H - 6}" text-anchor="middle" font-size="10" fill="${muted}">${d.slice(5)}</text>`;
    }
  });

  const yLabels = `
    <text x="${padL - 6}" y="${padT + 4}" text-anchor="end" font-size="10" fill="${muted}">${max}</text>
    <text x="${padL - 6}" y="${padT + chartH / 2 + 4}" text-anchor="end" font-size="10" fill="${muted}">${Math.round(max / 2)}</text>
    <text x="${padL - 6}" y="${padT + chartH + 4}" text-anchor="end" font-size="10" fill="${muted}">0</text>
    <line x1="${padL}" y1="${padT + chartH}" x2="${W - padR}" y2="${padT + chartH}" stroke="${border}" stroke-width="1"/>
  `;

  container.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}">
    ${yLabels}
    <path d="${fillD}" fill="${accentGlow}"/>
    <path d="${lineD}" fill="none" stroke="${accent}" stroke-width="2" stroke-linejoin="round"/>
    ${dots}
    ${xLabels}
  </svg>`;
}

function renderTopRooms(rows) {
  const tbody = document.querySelector('#top-rooms-table tbody');
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);">No room activity in the last 30 days.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r =>
    `<tr>
      <td>${esc(r.name)}</td>
      <td><a href="/${esc(r.org_slug)}" style="color:var(--accent);">${esc(r.org_name)}</a></td>
      <td class="num">${esc(r.broadcasts || 0)}</td>
      <td class="num">${esc(r.peak || 0)}</td>
      <td class="num">${esc(r.minutes || 0)}</td>
    </tr>`
  ).join('');
}

function renderStorage(s) {
  document.getElementById('storage-summary').innerHTML =
    `<strong>${esc(s.totalCount)}</strong> recordings · total size <strong>${esc(fmtBytes(s.totalBytes))}</strong>`;
  const tbody = document.querySelector('#storage-table tbody');
  if (!s.byOrg || s.byOrg.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text-muted);">No recordings yet.</td></tr>';
    return;
  }
  tbody.innerHTML = s.byOrg.map(o =>
    `<tr>
      <td>${esc(o.org_name)}</td>
      <td class="num">${esc(o.count)}</td>
      <td class="num">${esc(fmtBytes(o.bytes))}</td>
    </tr>`
  ).join('');
}

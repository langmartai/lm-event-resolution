// Overall dashboard view — shows counts, breakdowns, top sessions/nodes,
// upcoming resolutions, stale nodes, intent log, recent activity.
async function renderDashboard() {
  setHTML(app, '<div class="card spinner">building dashboard…</div>');
  const d = await fetchJson('/api/dashboard');

  const counts = d.counts || {};
  const tilesRow =
    '<div class="tile-grid">' +
      tile('Nodes', counts.nodes) +
      tile('Edges', counts.edges) +
      tile('Sources', counts.sources, (counts.node_sources || 0) + ' node attachments') +
      tile('Audit entries', counts.updates, (counts.intents || 0) + ' distinct intents') +
      tile('Sessions', counts.sessions, 'distinct Claude Code sessions') +
    '</div>';

  // DB health
  const h = d.health || {};
  const healthRow =
    '<div class="tile-grid">' +
      tile('DB size', humanBytes(h.db_size_bytes), h.db_path) +
      tile('WAL', humanBytes(h.db_size_wal)) +
      tile('Pages', (h.page_count || 0).toLocaleString(), (h.page_size || 0) + ' B/page · ' + (h.freelist_count || 0) + ' free') +
      tile('Integrity', h.integrity || '—', 'schema v' + (h.schema_versions || []).join(', ')) +
      tile('SQLite', h.sqlite_version || '—', (h.journal_mode || '—') + ' journal · FK ' + (h.foreign_keys ? 'on' : 'off')) +
    '</div>';

  // Performance — query timings
  const perfTiles = (d.perf || []).map(function(p) {
    return tile(p.label, p.ms.toFixed(1) + ' ms');
  }).join('');
  const perfRow = perfTiles
    ? '<div class="card"><h3>Query latency</h3><div class="tile-grid">' + perfTiles + '</div></div>'
    : '';

  // Three-up breakdown cards
  const breakdownRow =
    '<div class="card-row">' +
      breakdownCard('By type', d.byType, '#/nodes?type=') +
      breakdownCard('By status', d.byStatus, '#/nodes?status=') +
      breakdownCard('By certainty', d.byCertainty.slice(0, 8)) +
    '</div>';

  // Top sessions card
  const topSessionsHtml = d.topSessions.length === 0
    ? '<div class="meta">No sessions yet.</div>'
    : '<ul class="results">' + d.topSessions.map(function(s) {
        return '<li>' +
          '<div class="name"><a href="#/session/' + encodeURIComponent(s.session_id) + '">' + esc(s.session_id) + '</a></div>' +
          '<div class="meta"><strong>' + s.update_count + '</strong> updates · ' +
            '<strong>' + s.nodes_touched + '</strong> nodes · last ' + esc(s.last_seen) +
          '</div>' +
          (s.intents ? '<div class="meta">intent: ' + esc(s.intents) + '</div>' : '') +
        '</li>';
      }).join('') + '</ul>';

  // Most-touched nodes
  const topNodesHtml = d.topNodes.length === 0
    ? '<div class="meta">No nodes touched yet.</div>'
    : '<ul class="results">' + d.topNodes.map(function(n) {
        return '<li>' +
          '<div>' + badge('type', n.type) + ' ' + badge('status', n.status) +
            (n.asset ? ' <span class="badge">' + esc(n.asset) + '</span>' : '') +
            ' <span class="badge">' + n.touches + ' touches</span>' +
            (n.distinct_sessions > 1 ? ' <span class="badge">' + n.distinct_sessions + ' sessions</span>' : '') +
          '</div>' +
          '<div class="name"><a href="#/node/' + encodeURIComponent(n.uid) + '">' + esc(n.name) + '</a></div>' +
          '<div class="uid">' + esc(n.uid) + ' · last change ' + esc(n.last_change || '—') + '</div>' +
        '</li>';
      }).join('') + '</ul>';

  // ETA-soon
  const etaSoonHtml = d.etaSoon.length === 0
    ? '<div class="meta">Nothing scheduled to resolve in the next 30 days.</div>'
    : '<ul class="results">' + d.etaSoon.map(function(n) {
        return '<li>' +
          '<div>' + badge('type', n.type) + ' ' + badge('status', n.status) +
            (n.certainty ? ' ' + badge('cert', n.certainty.split(/\s+/)[0]) : '') +
            ' <span class="badge">eta ' + esc(n.eta_date) + '</span>' +
          '</div>' +
          '<div class="name"><a href="#/node/' + encodeURIComponent(n.uid) + '">' + esc(n.name) + '</a></div>' +
        '</li>';
      }).join('') + '</ul>';

  // Stale (Valid To passed)
  const staleHtml = d.stale.length === 0
    ? '<div class="meta">No stale active nodes.</div>'
    : '<ul class="results">' + d.stale.map(function(n) {
        return '<li>' +
          '<div>' + badge('type', n.type) + ' ' + badge('status', n.status) +
            ' <span class="badge">expired ' + esc(n.valid_to) + '</span></div>' +
          '<div class="name"><a href="#/node/' + encodeURIComponent(n.uid) + '">' + esc(n.name) + '</a></div>' +
        '</li>';
      }).join('') + '</ul>';

  // Intent log — top 15 distinct intents
  const intentsHtml = d.intents.length === 0
    ? '<div class="meta">No intents recorded yet.</div>'
    : '<ul class="results">' + d.intents.map(function(i) {
        return '<li>' +
          '<div class="name">' + esc(i.intent) + '</div>' +
          '<div class="meta"><strong>' + i.n + '</strong> mutations · ' +
            i.distinct_sessions + ' sessions · last ' + esc(i.last_seen) +
          '</div>' +
        '</li>';
      }).join('') + '</ul>';

  // Activity sparkline-style — vertical bars per day for the last 14 days
  const activityHtml = renderActivityBars(d.activityByDay);

  setHTML(app,
    '<div class="page-header">' +
      '<h2>Dashboard</h2>' +
      '<div class="sub">Snapshot of everything in the system — counts, breakdowns, who is doing what, and what is coming up.</div>' +
    '</div>' +
    tilesRow +
    '<div class="section-h">Database health</div>' +
    healthRow +
    perfRow +
    '<div class="section-h">Activity</div>' +
    '<div class="card"><h3>Mutations, last 14 days</h3>' + activityHtml + '</div>' +
    '<div class="section-h">Breakdown</div>' +
    breakdownRow +
    '<div class="card-row">' +
      '<div class="card"><h3>Most-touched nodes</h3>' + topNodesHtml + '</div>' +
      '<div class="card"><h3>Top sessions (by activity)</h3>' + topSessionsHtml + '</div>' +
    '</div>' +
    '<div class="section-h">Forward-looking</div>' +
    '<div class="card-row">' +
      '<div class="card"><h3>Upcoming resolutions (next 30 days)</h3>' + etaSoonHtml + '</div>' +
      '<div class="card"><h3>Stale (Valid To passed)</h3>' + staleHtml + '</div>' +
    '</div>' +
    '<div class="section-h">Intent log</div>' +
    '<div class="card"><h3>Why sessions are operating</h3>' + intentsHtml + '</div>' +
    '<div class="section-h">Recent activity</div>' +
    '<div class="card">' + renderUpdateRows(d.recent) + '</div>'
  );
}

function humanBytes(b) {
  if (b == null) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(2) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function breakdownCard(title, rows, linkBase) {
  if (!rows || !rows.length) return '<div class="card"><h3>' + esc(title) + '</h3><div class="meta">No data.</div></div>';
  const max = Math.max.apply(null, rows.map(function(r) { return r.n; }));
  const body = rows.map(function(r) {
    const pct = max > 0 ? Math.max(2, Math.round(r.n / max * 100)) : 0;
    const labelHtml = linkBase
      ? '<a href="' + linkBase + encodeURIComponent(r.k) + '">' + esc(r.k) + '</a>'
      : esc(r.k);
    return '<div class="tile-bar-row">' +
      '<span class="label">' + labelHtml + '</span>' +
      '<span class="bar"><div style="width:' + pct + '%"></div></span>' +
      '<span class="num">' + r.n + '</span>' +
    '</div>';
  }).join('');
  return '<div class="card"><h3>' + esc(title) + '</h3><div class="tile-bars">' + body + '</div></div>';
}

function renderActivityBars(rows) {
  if (!rows || !rows.length) return '<div class="meta">No activity in the last 14 days.</div>';
  // Build a 14-day window of dates with rows.
  const byDay = {};
  for (const r of rows) byDay[r.day] = r.n;
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({ day: key, n: byDay[key] || 0 });
  }
  const max = Math.max.apply(null, days.map(function(r) { return r.n; })) || 1;
  return '<div class="activity-bars">' + days.map(function(r) {
    const pct = r.n > 0 ? Math.max(4, Math.round(r.n / max * 100)) : 2;
    return '<div class="abar" title="' + esc(r.day) + ': ' + r.n + ' mutations">' +
      '<div class="abar-fill" style="height:' + pct + '%"></div>' +
      '<div class="abar-label">' + r.day.slice(5) + '</div>' +
    '</div>';
  }).join('') + '</div>';
}

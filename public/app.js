// lm-event-resolution — vanilla SPA.
// All user-supplied strings flow through esc() before being placed in HTML.
const app = document.getElementById('app');
const health = document.getElementById('health');
const searchForm = document.getElementById('searchForm');
const searchInput = document.getElementById('searchInput');
const filterType = document.getElementById('filterType');
const filterAsset = document.getElementById('filterAsset');
const filterStatus = document.getElementById('filterStatus');
const topnav = document.getElementById('topnav');

let META = null;

async function init() {
  await loadMeta();
  await loadHealth();
  window.addEventListener('hashchange', route);
  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = searchInput.value.trim();
    if (q) navigate('#/search?q=' + encodeURIComponent(q) + '&type=' + filterType.value + '&asset=' + filterAsset.value + '&status=' + filterStatus.value);
    else navigate('#/nodes');
  });
  route();
}

async function loadMeta() {
  const meta = await fetchJson('/api/meta');
  const assets = await fetchJson('/api/assets');
  META = meta;
  for (const t of meta.node_types) addOption(filterType, t);
  for (const a of assets) addOption(filterAsset, a.asset, a.asset + ' (' + a.n + ')');
  for (const s of meta.statuses) addOption(filterStatus, s);
}

async function loadHealth() {
  try {
    const h = await fetchJson('/api/health');
    health.textContent = h.counts.nodes + ' nodes · ' + h.counts.edges + ' edges · ' + h.counts.sources + ' sources · ' + h.counts.updates + ' updates';
  } catch { health.textContent = 'API offline'; }
}

function addOption(sel, value, label) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label || value;
  sel.appendChild(o);
}

function route() {
  const h = location.hash || '#/';
  const parts = h.slice(1).split('?');
  const path = parts[0] || '/';
  const params = Object.fromEntries(new URLSearchParams(parts[1] || ''));
  setActiveNav(path);

  if (path === '/') return renderHome();
  if (path === '/nodes') return renderNodeList(params);
  if (path.startsWith('/node/')) return renderNodeDetail(decodeURIComponent(path.slice(6)));
  if (path === '/search') {
    searchInput.value = params.q || '';
    return renderSearch(params);
  }
  if (path === '/updates') return renderUpdates();
  if (path === '/sessions') return renderSessions();
  if (path.startsWith('/session/')) return renderSessionDetail(decodeURIComponent(path.slice(9)));
  if (path === '/stats') return renderStats();
  setHTML(app, '<div class="card">Not found: ' + esc(path) + '</div>');
}

function setActiveNav(path) {
  for (const a of topnav.querySelectorAll('a')) {
    const href = a.getAttribute('href').slice(1);
    a.classList.toggle('active', href === path || (href === '/' && path === '/'));
  }
}

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function renderHome() {
  setHTML(app,
    '<div class="page-header"><div><h2>Event resolution repository</h2>' +
      '<div class="sub">Typed-graph of events, factors, sub-factors, drivers, monitors, scenarios — with source citation, FTS5 search, audit trail, and session attribution.</div></div></div>' +
    '<div class="tile-grid" id="homeTiles"></div>' +
    '<div class="card"><h3>Browse by type</h3>' +
      '<ul>' +
        '<li><a href="#/nodes?type=driver">Resolution drivers</a></li>' +
        '<li><a href="#/nodes?type=monitor">Monitors</a></li>' +
        '<li><a href="#/nodes?type=sub_factor">Sub-factors</a></li>' +
        '<li><a href="#/nodes?type=factor">Factors</a></li>' +
        '<li><a href="#/nodes?type=event">Events</a></li>' +
      '</ul>' +
    '</div>' +
    '<div class="card"><h3>Recent activity</h3><div id="recentUpdates" class="spinner">loading…</div></div>');

  const [health, updates] = await Promise.all([
    fetchJson('/api/health'),
    fetchJson('/api/updates?limit=15'),
  ]);
  setHTML(document.getElementById('homeTiles'),
    tile('Nodes', health.counts.nodes) +
    tile('Edges', health.counts.edges) +
    tile('Sources', health.counts.sources) +
    tile('Audit entries', health.counts.updates)
  );
  setHTML(document.getElementById('recentUpdates'), renderUpdateRows(updates.items || updates));
}

function tile(label, value, sub) {
  return '<div class="tile"><div class="tile-label">' + esc(label) + '</div>' +
    '<div class="tile-value">' + value + '</div>' +
    (sub ? '<div class="tile-sub">' + esc(sub) + '</div>' : '') + '</div>';
}

async function renderNodeList(params) {
  const limit = Number(params.limit) || 50;
  const offset = Number(params.offset) || 0;
  const sort = params.sort || 'updated_at';
  const order = params.order || 'desc';

  const qs = new URLSearchParams();
  if (params.type) qs.set('type', params.type);
  if (params.asset) qs.set('asset', params.asset);
  if (params.status) qs.set('status', params.status);
  qs.set('limit', limit);
  qs.set('offset', offset);
  qs.set('sort', sort);
  qs.set('order', order);

  const filters = [params.type && 'type: ' + params.type, params.asset && 'asset: ' + params.asset, params.status && 'status: ' + params.status].filter(Boolean).join(' · ');
  setHTML(app,
    '<div class="page-header"><div><h2>Nodes</h2>' +
      (filters ? '<div class="sub">' + esc(filters) + '</div>' : '') +
    '</div></div>' +
    '<div id="nodeList" class="card spinner">loading…</div>');

  const data = await fetchJson('/api/nodes?' + qs);
  const sortBar = renderSortBar({ sort, order }, [
    { key: 'updated_at', label: 'Updated' },
    { key: 'created_at', label: 'Created' },
    { key: 'name', label: 'Name' },
    { key: 'type', label: 'Type' },
    { key: 'status', label: 'Status' },
    { key: 'eta_date', label: 'ETA' },
  ]);
  setHTML(document.getElementById('nodeList'),
    sortBar +
    renderNodeRows(data.items, data.total) +
    renderPager({ total: data.total, offset: data.offset || offset, limit: data.limit || limit })
  );
  bindSortBar(document.getElementById('nodeList'));
  bindPager(document.getElementById('nodeList'));
}

async function renderNodeDetail(uid) {
  setHTML(app, '<div class="card spinner">loading ' + esc(uid) + '…</div>');
  let data;
  try { data = await fetchJson('/api/nodes/' + encodeURIComponent(uid)); }
  catch (e) { setHTML(app, '<div class="card">Not found: ' + esc(uid) + '</div>'); return; }

  const n = data.node;
  const propsHtml = Object.keys(n.props || {}).length
    ? '<pre>' + esc(JSON.stringify(n.props, null, 2)) + '</pre>' : '';

  const kvParts = [];
  if (n.asset) kvParts.push('<div class="k">asset</div><div class="v"><a href="#/nodes?asset=' + esc(n.asset) + '">' + esc(n.asset) + '</a></div>');
  if (n.valid_from) kvParts.push('<div class="k">valid from</div><div class="v">' + esc(n.valid_from) + '</div>');
  if (n.valid_to) kvParts.push('<div class="k">valid to</div><div class="v">' + esc(n.valid_to) + '</div>');
  if (n.eta_date) kvParts.push('<div class="k">eta date</div><div class="v">' + esc(n.eta_date) + '</div>');
  if (n.occurred_at) kvParts.push('<div class="k">occurred at</div><div class="v">' + esc(n.occurred_at) + '</div>');
  kvParts.push('<div class="k">created</div><div class="v">' + esc(n.created_at) + '</div>');
  kvParts.push('<div class="k">updated</div><div class="v">' + esc(n.updated_at) + '</div>');

  const sourcesHtml = data.sources.length === 0
    ? '<div class="meta">No sources attached.</div>'
    : '<ul class="results">' + data.sources.map(function(s) {
        return '<li><div class="name">' + esc(s.citation) + '</div>' +
          (s.url ? '<div><a href="' + esc(s.url) + '" target="_blank">' + esc(s.url) + '</a></div>' : '') +
          (s.evidence ? '<div class="snippet">' + esc(s.evidence) + '</div>' : '') +
          '<div class="meta">type: ' + esc(s.source_type || '-') + ' · trust: ' + (s.trust_level == null ? '-' : s.trust_level) + '</div></li>';
      }).join('') + '</ul>';

  const outEdges = data.edges.out.map(function(e) {
    return '<div class="edge-row"><span class="et">' + esc(e.type) + '</span> → <a href="#/node/' + encodeURIComponent(e.dst_uid) + '">' + esc(e.dst_name) + '</a><div class="meta">' + esc(e.dst_node_type) + (e.weight != null ? ' · w=' + e.weight : '') + '</div></div>';
  }).join('');
  const inEdges = data.edges.in.map(function(e) {
    return '<div class="edge-row"><a href="#/node/' + encodeURIComponent(e.src_uid) + '">' + esc(e.src_name) + '</a> <span class="et">' + esc(e.type) + '</span> → this<div class="meta">' + esc(e.src_node_type) + (e.weight != null ? ' · w=' + e.weight : '') + '</div></div>';
  }).join('');

  const sessions = data.sessions || [];
  const sessionsHtml = sessions.length === 0
    ? '<div class="meta">No tracked sessions have mutated this node yet.</div>'
    : '<ul class="results">' + sessions.map(function(s) {
        return '<li><div class="name"><a href="#/session/' + encodeURIComponent(s.session_id) + '">' + esc(s.session_id) + '</a></div>' +
          '<div class="meta"><strong>' + s.touches + '</strong> changes · last ' + esc(s.last_touched) + '</div>' +
          (s.change_types ? '<div class="meta">changes: ' + esc(s.change_types) + '</div>' : '') +
        '</li>';
      }).join('') + '</ul>';

  const html =
    '<div class="page-header"><div>' +
      '<h2>' + esc(n.name) + '</h2>' +
      '<div class="sub">' + esc(n.uid) + '</div>' +
    '</div><div>' +
      badge('type', n.type) + ' ' + badge('status', n.status) +
      (n.certainty ? ' ' + badge('cert', n.certainty.split(/\s+/)[0]) : '') +
      (n.direction ? ' <span class="badge">' + esc(n.direction) + '</span>' : '') +
      (n.magnitude ? ' <span class="badge">' + esc(n.magnitude) + '</span>' : '') +
      (n.significance ? ' <span class="badge">' + esc(n.significance) + '</span>' : '') +
    '</div></div>' +
    '<div class="detail-grid"><div>' +
      '<div class="card">' +
        '<div class="kv">' + kvParts.join('') + '</div>' +
        (n.body_md ? '<div class="body-md">' + esc(n.body_md) + '</div>' : '') + propsHtml +
      '</div>' +
      '<div class="card"><h3>Sources (' + data.sources.length + ')</h3>' + sourcesHtml + '</div>' +
      '<div class="card"><h3>Update history (' + data.history.length + ')</h3>' + renderUpdateRows(data.history) + '</div>' +
    '</div>' +
    '<div>' +
      '<div class="card"><h3>Sessions that touched this node (' + sessions.length + ')</h3>' + sessionsHtml + '</div>' +
      '<div class="card"><h3>Outgoing edges (' + data.edges.out.length + ')</h3><div class="edge-list">' + outEdges + '</div></div>' +
      '<div class="card"><h3>Incoming edges (' + data.edges.in.length + ')</h3><div class="edge-list">' + inEdges + '</div></div>' +
      '<div class="card"><h3>Dependency neighborhood</h3><div class="meta">Depth 2 · typed edges</div><a href="/api/graph/' + encodeURIComponent(n.uid) + '?depth=2" target="_blank">JSON</a></div>' +
    '</div></div>';

  setHTML(app, html);
}

async function renderSearch(params) {
  const qs = new URLSearchParams();
  qs.set('q', params.q || '');
  if (params.type) qs.set('type', params.type);
  if (params.asset) qs.set('asset', params.asset);
  if (params.status) qs.set('status', params.status);
  qs.set('limit', '50');

  setHTML(app, '<div class="card"><h3>Search · ' + esc(params.q || '') + '</h3><div id="searchResults" class="spinner">searching…</div></div>');
  const data = await fetchJson('/api/search?' + qs);
  const target = document.getElementById('searchResults');
  if (!data.items.length) {
    setHTML(target, '<div class="meta">No matches.</div>');
    return;
  }
  // snippet from server is pre-marked HTML; it contains <mark> tags but
  // all other text comes from the FTS column which is plain user text.
  // We still escape everything except those tags.
  setHTML(target, '<ul class="results">' + data.items.map(function(n) {
    const snippet = n.snippet ? sanitizeSnippet(n.snippet) : '';
    return '<li><div>' + badge('type', n.type) + ' ' + badge('status', n.status) +
      (n.certainty ? ' ' + badge('cert', n.certainty.split(/\s+/)[0]) : '') +
      (n.asset ? ' <span class="badge">' + esc(n.asset) + '</span>' : '') + '</div>' +
      '<div class="name"><a href="#/node/' + encodeURIComponent(n.uid) + '">' + esc(n.name) + '</a></div>' +
      '<div class="uid">' + esc(n.uid) + '</div>' +
      (snippet ? '<div class="snippet">…' + snippet + '…</div>' : '') + '</li>';
  }).join('') + '</ul>');
}

async function renderUpdates() {
  const params = paramsFromHash();
  const limit = Number(params.limit) || 50;
  const offset = Number(params.offset) || 0;
  const sort = params.sort || 'id';
  const order = params.order || 'desc';
  const sessionFilter = params.sessionId || '';

  setHTML(app,
    '<div class="page-header"><div><h2>Audit trail</h2>' +
      '<div class="sub">Every mutation across the repository, newest first.' +
        (sessionFilter ? ' Filtered to session <code>' + esc(sessionFilter) + '</code>.' : '') +
      '</div></div></div>' +
    '<div id="updatesWrap" class="card spinner">loading…</div>');

  const qs = new URLSearchParams({ limit, offset, sort, order });
  if (sessionFilter) qs.set('sessionId', sessionFilter);
  const data = await fetchJson('/api/updates?' + qs);

  const sortBar = renderSortBar({ sort, order }, [
    { key: 'id', label: 'Most recent' },
    { key: 'created_at', label: 'Time' },
    { key: 'change_type', label: 'Change type' },
    { key: 'entity_type', label: 'Entity type' },
  ]);
  setHTML(document.getElementById('updatesWrap'),
    sortBar +
    renderUpdateRows(data.items) +
    renderPager({ total: data.total, offset: data.offset, limit: data.limit })
  );
  bindSortBar(document.getElementById('updatesWrap'));
  bindPager(document.getElementById('updatesWrap'));
}

async function renderStats() {
  setHTML(app, '<div class="card spinner">loading…</div>');
  const h = await fetchJson('/api/health');
  const allNodes = await fetchJson('/api/nodes?limit=10000');
  const typeCounts = {}, statusCounts = {}, assetCounts = {};
  for (const n of allNodes.items) {
    typeCounts[n.type] = (typeCounts[n.type] || 0) + 1;
    statusCounts[n.status] = (statusCounts[n.status] || 0) + 1;
    if (n.asset) assetCounts[n.asset] = (assetCounts[n.asset] || 0) + 1;
  }
  const rowsFor = (obj, builder) => Object.entries(obj).sort((a,b) => b[1]-a[1]).map(builder).join('');
  setHTML(app,
    '<div class="card"><h3>Repository stats</h3><table class="stats">' +
      '<tr><th>Total nodes</th><td>' + h.counts.nodes + '</td></tr>' +
      '<tr><th>Total edges</th><td>' + h.counts.edges + '</td></tr>' +
      '<tr><th>Total sources</th><td>' + h.counts.sources + '</td></tr>' +
      '<tr><th>Audit log entries</th><td>' + h.counts.updates + '</td></tr></table></div>' +
    '<div class="card"><h3>By type</h3><table class="stats">' +
      rowsFor(typeCounts, ([k,v]) => '<tr><td>' + badge('type', k) + ' <a href="#/nodes?type=' + esc(k) + '">' + esc(k) + '</a></td><td>' + v + '</td></tr>') +
      '</table></div>' +
    '<div class="card"><h3>By status</h3><table class="stats">' +
      rowsFor(statusCounts, ([k,v]) => '<tr><td>' + badge('status', k) + ' <a href="#/nodes?status=' + esc(k) + '">' + esc(k) + '</a></td><td>' + v + '</td></tr>') +
      '</table></div>' +
    '<div class="card"><h3>By asset</h3><table class="stats">' +
      rowsFor(assetCounts, ([k,v]) => '<tr><td><a href="#/nodes?asset=' + esc(k) + '">' + esc(k) + '</a></td><td>' + v + '</td></tr>') +
      '</table></div>'
  );
}

function renderNodeRows(items, total) {
  if (!items || !items.length) return '<div class="meta">No rows.</div>';
  return '<div class="meta">' + items.length + ' of ' + (total != null ? total : items.length) + ' shown</div>' +
    '<ul class="results">' + items.map(function(n) {
      return '<li><div>' + badge('type', n.type) + ' ' + badge('status', n.status) +
        (n.certainty ? ' ' + badge('cert', n.certainty.split(/\s+/)[0]) : '') +
        (n.asset ? ' <span class="badge">' + esc(n.asset) + '</span>' : '') + '</div>' +
        '<div class="name"><a href="#/node/' + encodeURIComponent(n.uid) + '">' + esc(n.name) + '</a></div>' +
        '<div class="uid">' + esc(n.uid) + '</div>' +
        '<div class="meta">updated ' + esc(n.updated_at) + '</div></li>';
    }).join('') + '</ul>';
}

function renderUpdateRows(rows) {
  if (!rows || !rows.length) return '<div class="meta">No activity.</div>';
  return rows.map(function(r) {
    const diff = r.before && r.after ? diffObject(r.before, r.after) : '';
    const sessionLink = r.session_id
      ? ' · <a href="#/session/' + encodeURIComponent(r.session_id) + '">session ' + esc(short(r.session_id)) + '</a>'
      : '';
    return '<div class="update-row"><span class="ut">' + esc(r.created_at) + '</span> · <span class="uchange">' + esc(r.change_type) + '</span> · <span>' + esc(r.entity_type) + ' #' + r.entity_id + '</span>' +
      sessionLink +
      (r.actor ? ' · by ' + esc(r.actor) : '') +
      (r.reason ? ' · ' + esc(r.reason) : '') +
      (r.project_path ? '<div class="meta">project: ' + esc(r.project_path) + '</div>' : '') +
      (diff ? '<div class="udiff">' + diff + '</div>' : '') + '</div>';
  }).join('');
}

function diffObject(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  const out = [];
  for (const k of keys) {
    const av = (a || {})[k], bv = (b || {})[k];
    if (JSON.stringify(av) === JSON.stringify(bv)) continue;
    if (k === 'props' || k === 'props_json' || k === 'updated_at') continue;
    out.push('<div><strong>' + esc(k) + '</strong>: ' + esc(short(av)) + ' → ' + esc(short(bv)) + '</div>');
  }
  return out.slice(0, 5).join('');
}

function short(v) {
  if (v == null) return '∅';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 80 ? s.slice(0, 77) + '…' : s;
}

function badge(prefix, val) {
  if (!val) return '';
  const safe = String(val).replace(/[^\w]/g, '_');
  return '<span class="badge ' + prefix + '-' + safe + '">' + esc(val) + '</span>';
}

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Snippet from FTS has <mark>...</mark> tags around match.
// Escape everything else, then unescape just those tags.
function sanitizeSnippet(snippet) {
  const escaped = esc(snippet);
  return escaped
    .replace(/&lt;mark&gt;/g, '<mark>')
    .replace(/&lt;\/mark&gt;/g, '</mark>');
}

function setHTML(el, html) { el.innerHTML = html; }

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    const text = await r.text();
    throw new Error('HTTP ' + r.status + ': ' + text);
  }
  return r.json();
}

init().catch(function(err) {
  setHTML(app, '<div class="card">Init error: ' + esc(err.message) + '</div>');
});

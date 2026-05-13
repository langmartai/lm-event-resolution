// Session views — list + detail. Uses helpers from app-controls.js.

async function renderSessions() {
  const params = paramsFromHash();
  const limit = Number(params.limit) || 25;
  const offset = Number(params.offset) || 0;
  const sort = params.sort || 'last_seen';
  const order = params.order || 'desc';

  setHTML(app,
    '<div class="page-header">' +
      '<div><h2>Sessions that have mutated this repository</h2>' +
      '<div class="sub">Only mutations (create / update / delete / link) are tracked. Read-only requests are not recorded.</div></div>' +
      '<div class="sub">Each row links to the full activity for that session.</div>' +
    '</div>' +
    '<div id="sessionWrap" class="card spinner">loading…</div>');

  const qs = new URLSearchParams({ limit, offset, sort, order }).toString();
  const data = await fetchJson('/api/sessions?' + qs);
  if (!data.items || !data.items.length) {
    setHTML(document.getElementById('sessionWrap'),
      '<div class="meta">No sessions yet. Mutations carry the <code>X-Claude-Session-Id</code> header — pass one and you\'ll see entries here.</div>');
    return;
  }

  const sortBar = renderSortBar({ sort, order }, [
    { key: 'last_seen', label: 'Last seen' },
    { key: 'first_seen', label: 'First seen' },
    { key: 'update_count', label: 'Updates' },
    { key: 'nodes_touched', label: 'Nodes touched' },
    { key: 'session_id', label: 'Session id' },
  ]);

  const rows = data.items.map(function(s) {
    return '<li>' +
      '<div class="name"><a href="#/session/' + encodeURIComponent(s.session_id) + '">' + esc(s.session_id) + '</a></div>' +
      '<div class="meta">' +
        '<strong>' + s.update_count + '</strong> updates · ' +
        '<strong>' + s.nodes_touched + '</strong> nodes · ' +
        'first ' + esc(s.first_seen) + ' · last ' + esc(s.last_seen) +
      '</div>' +
      (s.actors ? '<div class="meta">actors: ' + esc(s.actors) + '</div>' : '') +
      (s.project_paths ? '<div class="meta">project: ' + esc(s.project_paths) + '</div>' : '') +
    '</li>';
  }).join('');

  setHTML(document.getElementById('sessionWrap'),
    sortBar +
    '<ul class="results">' + rows + '</ul>' +
    renderPager({ total: data.total, offset: data.offset, limit: data.limit })
  );
  bindSortBar(document.getElementById('sessionWrap'));
  bindPager(document.getElementById('sessionWrap'));
}

async function renderSessionDetail(sessionId) {
  const params = paramsFromHash();
  const limit = Number(params.limit) || 50;
  const offset = Number(params.offset) || 0;
  const sort = params.sort || 'id';
  const order = params.order || 'desc';

  setHTML(app, '<div class="card spinner">loading ' + esc(sessionId) + '…</div>');
  let d;
  try {
    const qs = new URLSearchParams({ limit, offset, sort, order }).toString();
    d = await fetchJson('/api/sessions/' + encodeURIComponent(sessionId) + '?' + qs);
  } catch (e) {
    setHTML(app, '<div class="card">Session not found: ' + esc(sessionId) + '</div>');
    return;
  }

  const s = d.summary || {};
  const pag = d.pagination || { totalUpdates: 0, offset: 0, limit: limit };

  // Breakdown rows
  const ctRows = (d.byChangeType || []).map(function(r) { return { label: r.change_type, n: r.n }; });
  const etRows = (d.byEntityType || []).map(function(r) { return { label: r.entity_type, n: r.n }; });

  // Dashboard tile grid
  const tiles =
    '<div class="tile-grid">' +
      '<div class="tile">' +
        '<div class="tile-label">Total mutations</div>' +
        '<div class="tile-value">' + (s.update_count || 0) + '</div>' +
        '<div class="tile-sub">across ' + (s.nodes_touched || 0) + ' nodes</div>' +
      '</div>' +
      '<div class="tile">' +
        '<div class="tile-label">By change type</div>' +
        renderMiniBars(ctRows) +
      '</div>' +
      '<div class="tile">' +
        '<div class="tile-label">By entity</div>' +
        renderMiniBars(etRows) +
      '</div>' +
      '<div class="tile">' +
        '<div class="tile-label">Active window</div>' +
        '<div class="tile-sub">first ' + esc(s.first_seen || '—') + '</div>' +
        '<div class="tile-sub">last ' + esc(s.last_seen || '—') + '</div>' +
        (s.actors ? '<div class="tile-sub">actors: ' + esc(s.actors) + '</div>' : '') +
        (s.project_paths ? '<div class="tile-sub">project: ' + esc(s.project_paths) + '</div>' : '') +
      '</div>' +
    '</div>';

  // Activity grouped per node (so users see what was done to each node, not a flat log)
  const groupedByEntity = groupUpdatesByEntity(d.updates);
  const nodeIndex = Object.fromEntries((d.nodes || []).map(function(n) { return [String(n.id), n]; }));
  const groups = Object.keys(groupedByEntity).map(function(key) {
    const items = groupedByEntity[key];
    const first = items[0];
    let title, link;
    if (first.entity_type === 'node' && nodeIndex[String(first.entity_id)]) {
      const n = nodeIndex[String(first.entity_id)];
      title = '[' + esc(n.type) + '] ' + esc(n.name);
      link = '#/node/' + encodeURIComponent(n.uid);
    } else {
      title = first.entity_type + ' #' + first.entity_id;
      link = null;
    }
    const pills = items.slice().reverse().map(function(u) {
      return '<span class="eg-pill t-' + esc(u.change_type) + '" title="' + esc(u.created_at) + (u.reason ? ' — ' + esc(u.reason) : '') + '">' + esc(u.change_type) + '</span>';
    }).join('');
    return '<div class="entity-group"><div class="eg-head">' +
      '<div class="eg-name">' + (link ? '<a href="' + link + '">' + title + '</a>' : title) + '</div>' +
      '<div class="eg-meta">' + items.length + ' changes · last ' + esc(items[0].created_at) + '</div>' +
    '</div><div class="eg-timeline">' + pills + '</div></div>';
  }).join('');

  const sortBar = renderSortBar({ sort, order }, [
    { key: 'id', label: 'Most recent' },
    { key: 'created_at', label: 'Time' },
    { key: 'change_type', label: 'Change type' },
    { key: 'entity_type', label: 'Entity type' },
  ]);

  // Nodes-touched panel
  const nodesPanel = (d.nodes && d.nodes.length)
    ? '<ul class="results">' + d.nodes.map(function(n) {
        return '<li><div>' + badge('type', n.type) + ' ' + badge('status', n.status) +
          (n.asset ? ' <span class="badge">' + esc(n.asset) + '</span>' : '') +
          ' <span class="badge">' + n.session_touches + 'x</span></div>' +
          '<div class="name"><a href="#/node/' + encodeURIComponent(n.uid) + '">' + esc(n.name) + '</a></div>' +
          '<div class="uid">' + esc(n.uid) + '</div></li>';
      }).join('') + '</ul>'
    : '<div class="meta">No nodes touched.</div>';

  setHTML(app,
    '<div class="page-header"><div>' +
      '<h2>Session <code>' + esc(sessionId) + '</code></h2>' +
      '<div class="sub"><a href="#/sessions">← all sessions</a></div>' +
    '</div></div>' +
    tiles +
    '<div class="card"><h3>Nodes touched (' + (d.nodes || []).length + ')</h3>' + nodesPanel + '</div>' +
    '<div class="card"><h3>Activity grouped by entity</h3>' +
      '<div class="meta">Each tile is one entity this session changed; pills are the changes the session made to it (oldest → newest).</div>' +
      (groups || '<div class="meta">No activity.</div>') +
    '</div>' +
    '<div class="card"><h3>Update timeline (' + pag.totalUpdates + ' total)</h3>' +
      sortBar +
      renderUpdateRows(d.updates) +
      renderPager({ total: pag.totalUpdates, offset: pag.offset, limit: pag.limit }) +
    '</div>'
  );
  bindSortBar(app);
  bindPager(app);
}

// Group a flat list of updates by entity_type+entity_id, preserving the
// original order of each entity's first appearance.
function groupUpdatesByEntity(rows) {
  const groups = {};
  const order = [];
  for (const r of rows || []) {
    const key = r.entity_type + ':' + r.entity_id;
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push(r);
  }
  const out = {};
  for (const k of order) out[k] = groups[k];
  return out;
}

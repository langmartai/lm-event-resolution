// Session views — appended to the SPA via the loader below.
async function renderSessions() {
  setHTML(app, '<div class="card"><h3>Claude Code sessions that have modified data</h3>' +
    '<div class="meta">Only mutations (create/update/delete) are tracked. Read-only requests are not recorded.</div>' +
    '<div id="sessionList" class="spinner">loading…</div></div>');
  const rows = await fetchJson('/api/sessions?limit=100');
  if (!rows.length) {
    setHTML(document.getElementById('sessionList'),
      '<div class="meta">No sessions yet. To attribute a mutation, pass an <code>X-Claude-Session-Id</code> header on POST/PATCH/DELETE.</div>');
    return;
  }
  setHTML(document.getElementById('sessionList'), '<ul class="results">' + rows.map(function(s) {
    return '<li><div class="name"><a href="#/session/' + encodeURIComponent(s.session_id) + '">' + esc(s.session_id) + '</a></div>' +
      '<div class="meta">' + s.update_count + ' updates · ' + s.nodes_touched + ' nodes touched · last seen ' + esc(s.last_seen) + '</div>' +
      (s.actors ? '<div class="meta">actors: ' + esc(s.actors) + '</div>' : '') +
      (s.project_paths ? '<div class="meta">project: ' + esc(s.project_paths) + '</div>' : '') +
      '</li>';
  }).join('') + '</ul>');
}

async function renderSessionDetail(sessionId) {
  setHTML(app, '<div class="card spinner">loading ' + esc(sessionId) + '…</div>');
  let d;
  try { d = await fetchJson('/api/sessions/' + encodeURIComponent(sessionId)); }
  catch (e) { setHTML(app, '<div class="card">Not found: ' + esc(sessionId) + '</div>'); return; }

  const s = d.summary || {};
  const nodesHtml = d.nodes.length === 0
    ? '<div class="meta">No nodes touched.</div>'
    : '<ul class="results">' + d.nodes.map(function(n) {
        return '<li><div>' + badge('type', n.type) + ' ' + badge('status', n.status) +
          (n.asset ? ' <span class="badge">' + esc(n.asset) + '</span>' : '') + '</div>' +
          '<div class="name"><a href="#/node/' + encodeURIComponent(n.uid) + '">' + esc(n.name) + '</a></div>' +
          '<div class="uid">' + esc(n.uid) + '</div></li>';
      }).join('') + '</ul>';

  setHTML(app,
    '<div class="card"><h3>Session ' + esc(sessionId) + '</h3>' +
      '<div class="kv">' +
        '<div class="k">updates</div><div class="v">' + (s.update_count || 0) + '</div>' +
        '<div class="k">nodes touched</div><div class="v">' + (s.nodes_touched || 0) + '</div>' +
        '<div class="k">first seen</div><div class="v">' + esc(s.first_seen || '') + '</div>' +
        '<div class="k">last seen</div><div class="v">' + esc(s.last_seen || '') + '</div>' +
        (s.actors ? '<div class="k">actors</div><div class="v">' + esc(s.actors) + '</div>' : '') +
        (s.project_paths ? '<div class="k">project paths</div><div class="v">' + esc(s.project_paths) + '</div>' : '') +
      '</div></div>' +
    '<div class="card"><h3>Nodes touched (' + d.nodes.length + ')</h3>' + nodesHtml + '</div>' +
    '<div class="card"><h3>Update timeline</h3>' + renderUpdateRows(d.updates) + '</div>'
  );
}

// Vocabulary + Organizer views.

async function renderVocabulary() {
  const params = paramsFromHash();
  const type = params.type || '';
  const scope = params.scope || '';
  const parent = params.parent || '';

  setHTML(app,
    '<div class="page-header">' +
      '<h2>Vocabulary</h2>' +
      '<div class="sub">Controlled terms (concepts + categories) that observations reference. Auto-registered terms appear in the Organizer queue.</div>' +
    '</div>' +
    '<div class="card">' +
      '<div class="sort-bar" id="vocabFilter">' +
        '<span>Type:</span>' +
        sortLink('type', '', 'all', type === '') +
        sortLink('type', 'concept', 'concepts', type === 'concept') +
        sortLink('type', 'category', 'categories', type === 'category') +
      '</div>' +
      '<div id="vocabList" class="spinner">loading…</div>' +
    '</div>'
  );

  const qs = new URLSearchParams({ limit: '200' });
  if (type) qs.set('type', type);
  if (scope) qs.set('scope', scope);
  if (parent) qs.set('parent', parent);
  const data = await fetchJson('/api/vocabulary?' + qs);

  bindFilterLinks(document.getElementById('vocabFilter'));

  if (!data.items.length) {
    setHTML(document.getElementById('vocabList'), '<div class="meta">No vocabulary entries.</div>');
    return;
  }

  setHTML(document.getElementById('vocabList'),
    '<div class="meta">' + data.count + ' of ' + data.total + ' shown</div>' +
    '<ul class="results">' + data.items.map(function(v) {
      return '<li>' +
        '<div>' + badge('type', v.type) +
          (v.auto_registered ? ' <span class="badge" style="background:#9a3412;color:#fed7aa">auto</span>' : '') +
          (v.scope ? ' <span class="badge">' + esc(v.scope) + '</span>' : '') +
        '</div>' +
        '<div class="name"><a href="#/vocab/' + encodeURIComponent(v.key) + '">' + esc(v.label) + '</a></div>' +
        '<div class="uid">' + esc(v.key) + '</div>' +
        (v.description ? '<div class="meta">' + esc(v.description) + '</div>' : '') +
      '</li>';
    }).join('') + '</ul>'
  );
}

async function renderVocabDetail(key) {
  setHTML(app, '<div class="card spinner">loading ' + esc(key) + '…</div>');
  let d;
  try { d = await fetchJson('/api/vocabulary/' + encodeURIComponent(key)); }
  catch (e) { setHTML(app, '<div class="card">Not found: ' + esc(key) + '</div>'); return; }

  const v = d.vocabulary;
  const obsHtml = !d.observations.length
    ? '<div class="meta">No observations under this concept yet.</div>'
    : '<ul class="results">' + d.observations.map(function(n) {
        return '<li>' + badge('type', n.type) + ' ' + badge('status', n.status) +
          (n.asset ? ' <span class="badge">' + esc(n.asset) + '</span>' : '') +
          ' <div class="name"><a href="#/node/' + encodeURIComponent(n.uid) + '">' + esc(n.name) + '</a></div>' +
          '<div class="uid">' + esc(n.uid) + (n.valid_from ? ' · valid ' + esc(n.valid_from) + (n.valid_to ? ' → ' + esc(n.valid_to) : '') : '') + '</div></li>';
      }).join('') + '</ul>';

  const childrenHtml = !d.children.length
    ? '<div class="meta">No children.</div>'
    : '<ul class="results">' + d.children.map(function(c) {
        return '<li>' + badge('type', c.type) + ' <a href="#/vocab/' + encodeURIComponent(c.key) + '">' + esc(c.label) + '</a></li>';
      }).join('') + '</ul>';

  const aliasesHtml = (v.aliases && v.aliases.length)
    ? '<div class="meta">aliases: ' + v.aliases.map(esc).join(', ') + '</div>'
    : '';

  setHTML(app,
    '<div class="page-header">' +
      '<h2>' + esc(v.label) + '</h2>' +
      '<div class="sub">' + esc(v.key) + '</div>' +
      '<div class="badge-row">' +
        badge('type', v.type) +
        (v.auto_registered ? ' <span class="badge" style="background:#9a3412;color:#fed7aa">auto-registered</span>' : '') +
        (v.reviewed_at ? ' <span class="badge status-active">reviewed</span>' : '') +
        (v.scope ? ' <span class="badge">' + esc(v.scope) + '</span>' : '') +
      '</div>' +
    '</div>' +
    '<div class="detail-grid"><div>' +
      '<div class="card">' +
        (v.description ? '<div class="body-md">' + esc(v.description) + '</div>' : '') +
        aliasesHtml +
        '<div class="kv">' +
          '<div class="k">created</div><div class="v">' + esc(v.created_at) + '</div>' +
          '<div class="k">updated</div><div class="v">' + esc(v.updated_at) + '</div>' +
          (v.reviewed_at ? '<div class="k">reviewed at</div><div class="v">' + esc(v.reviewed_at) + '</div>' : '') +
          (v.merged_into_id ? '<div class="k">merged into</div><div class="v">id ' + v.merged_into_id + '</div>' : '') +
        '</div>' +
      '</div>' +
      '<div class="card"><h3>Observations under this concept (' + d.observations.length + ')</h3>' + obsHtml + '</div>' +
    '</div>' +
    '<div>' +
      '<div class="card"><h3>Children in the TOC</h3>' + childrenHtml + '</div>' +
      '<div class="card"><h3>Status</h3>' +
        '<div class="meta">' + esc(v.status) + '</div>' +
        (v.auto_registered && !v.reviewed_at
          ? '<div class="meta">This entry is auto-registered and pending review. Visit the Organizer to merge / recategorize / mark-reviewed.</div>'
          : '') +
      '</div>' +
    '</div></div>'
  );
}

async function renderOrganizer() {
  setHTML(app,
    '<div class="page-header">' +
      '<h2>Organizer</h2>' +
      '<div class="sub">Auto-registered vocabulary awaiting review, plus heuristic merge suggestions. Most efficient way to work this queue is to invoke <code>ler organize review</code> which spawns an lm-assist agent.</div>' +
    '</div>' +
    '<div class="card-row">' +
      '<div class="card"><h3>Pending review</h3><div id="pendingList" class="spinner">loading…</div></div>' +
      '<div class="card"><h3>Merge suggestions</h3><div id="suggList" class="spinner">loading…</div></div>' +
    '</div>'
  );

  const [pending, suggestions] = await Promise.all([
    fetchJson('/api/organizer/pending?limit=100'),
    fetchJson('/api/organizer/suggestions?limit=50'),
  ]);

  // Pending list
  if (!pending.items.length) {
    setHTML(document.getElementById('pendingList'), '<div class="meta">No pending entries — vocabulary is clean.</div>');
  } else {
    setHTML(document.getElementById('pendingList'),
      '<div class="meta">' + pending.items.length + ' entries</div>' +
      '<ul class="results">' + pending.items.map(function(v) {
        return '<li>' + badge('type', v.type) +
          (v.scope ? ' <span class="badge">' + esc(v.scope) + '</span>' : '') +
          ' <span class="badge">' + v.observation_count + ' obs</span>' +
          '<div class="name"><a href="#/vocab/' + encodeURIComponent(v.key) + '">' + esc(v.label) + '</a></div>' +
          '<div class="uid">' + esc(v.key) + '</div></li>';
      }).join('') + '</ul>'
    );
  }

  // Suggestions list
  if (!suggestions.items.length) {
    setHTML(document.getElementById('suggList'), '<div class="meta">No merge candidates detected.</div>');
  } else {
    setHTML(document.getElementById('suggList'),
      '<div class="meta">' + suggestions.items.length + ' candidate pairs</div>' +
      '<ul class="results">' + suggestions.items.map(function(s) {
        return '<li>' +
          '<div><a href="#/vocab/' + encodeURIComponent(s.a_key) + '">' + esc(s.a_label) + '</a></div>' +
          '<div class="meta">↔</div>' +
          '<div><a href="#/vocab/' + encodeURIComponent(s.b_key) + '">' + esc(s.b_label) + '</a></div>' +
          (s.a_scope ? '<div class="meta">scope: ' + esc(s.a_scope) + '</div>' : '') +
        '</li>';
      }).join('') + '</ul>'
    );
  }
}

// Helpers
function sortLink(param, value, label, active) {
  return '<a class="sort-link' + (active ? ' active' : '') + '" data-param="' + param + '" data-value="' + esc(value) + '">' + esc(label) + '</a>';
}

function bindFilterLinks(container) {
  if (!container) return;
  container.querySelectorAll('a.sort-link').forEach(function(a) {
    a.addEventListener('click', function(e) {
      e.preventDefault();
      const patch = {};
      patch[a.dataset.param] = a.dataset.value;
      patch.offset = 0;
      setHashParams(patch);
    });
  });
}

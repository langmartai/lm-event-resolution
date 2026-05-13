// Shared helpers for pagination, sorting, hash params.

function paramsFromHash() {
  const h = location.hash || '#/';
  const i = h.indexOf('?');
  if (i < 0) return {};
  return Object.fromEntries(new URLSearchParams(h.slice(i + 1)));
}

function pathFromHash() {
  const h = location.hash || '#/';
  const i = h.indexOf('?');
  return i < 0 ? h.slice(1) : h.slice(1, i);
}

function setHashParams(patch) {
  const cur = paramsFromHash();
  const next = { ...cur, ...patch };
  // Remove falsy values so the URL stays clean.
  for (const k of Object.keys(next)) {
    if (next[k] === '' || next[k] == null) delete next[k];
  }
  const qs = new URLSearchParams(next).toString();
  const newHash = '#' + pathFromHash() + (qs ? '?' + qs : '');
  if (location.hash !== newHash) location.hash = newHash;
}

function renderPager({ total, offset, limit }) {
  offset = Number(offset) || 0;
  limit = Number(limit) || 50;
  total = Number(total) || 0;
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + limit, total);

  const prevOffset = Math.max(0, offset - limit);
  const nextOffset = offset + limit;
  const prev = offset > 0
    ? '<a data-offset="' + prevOffset + '" class="pager-prev">← Prev</a>'
    : '<span class="disabled">← Prev</span>';
  const next = nextOffset < total
    ? '<a data-offset="' + nextOffset + '" class="pager-next">Next →</a>'
    : '<span class="disabled">Next →</span>';

  // Limit selector
  const limitOpts = [10, 25, 50, 100, 200].map(function(L) {
    return '<option value="' + L + '"' + (L === limit ? ' selected' : '') + '>' + L + '/page</option>';
  }).join('');

  return '<div class="pager"><div>' + start + '–' + end + ' of ' + total +
    ' · page ' + page + '/' + pages +
    '</div><div class="pager-controls">' +
      prev + '<span class="current">' + page + '</span>' + next +
      ' <select class="pager-limit">' + limitOpts + '</select>' +
    '</div></div>';
}

// Bind pager links in `container` to call setHashParams({ offset, limit }).
function bindPager(container) {
  if (!container) return;
  container.querySelectorAll('a.pager-prev, a.pager-next').forEach(function(a) {
    a.addEventListener('click', function(e) {
      e.preventDefault();
      setHashParams({ offset: a.dataset.offset });
    });
  });
  const sel = container.querySelector('select.pager-limit');
  if (sel) sel.addEventListener('change', function() {
    setHashParams({ limit: sel.value, offset: 0 });
  });
}

// Render a sort bar. `current` is { sort, order }; `options` is [{ key, label }].
function renderSortBar(current, options) {
  const curSort = current.sort || options[0].key;
  const curOrder = (current.order || 'desc').toLowerCase();
  return '<div class="sort-bar"><span>Sort:</span>' + options.map(function(opt) {
    const active = opt.key === curSort;
    const nextOrder = active && curOrder === 'desc' ? 'asc' : 'desc';
    const arrow = active ? (curOrder === 'desc' ? '↓' : '↑') : '';
    return '<a class="sort-link' + (active ? ' active' : '') +
      '" data-sort="' + opt.key + '" data-order="' + nextOrder + '">' +
      esc(opt.label) + ' <span class="sort-arrow">' + arrow + '</span></a>';
  }).join('') + '</div>';
}

function bindSortBar(container) {
  if (!container) return;
  container.querySelectorAll('a.sort-link').forEach(function(a) {
    a.addEventListener('click', function(e) {
      e.preventDefault();
      setHashParams({ sort: a.dataset.sort, order: a.dataset.order, offset: 0 });
    });
  });
}

// Mini horizontal bar chart for breakdown stats.
// rows = [{ label, n }], renders as label + bar + count.
function renderMiniBars(rows, total) {
  if (!rows || !rows.length) return '<div class="meta">No activity.</div>';
  const max = total || Math.max.apply(null, rows.map(function(r) { return r.n; }));
  return '<div class="tile-bars">' + rows.map(function(r) {
    const pct = max > 0 ? Math.max(2, Math.round(r.n / max * 100)) : 0;
    return '<div class="tile-bar-row">' +
      '<span class="label">' + esc(r.label) + '</span>' +
      '<span class="bar"><div style="width:' + pct + '%"></div></span>' +
      '<span class="num">' + r.n + '</span>' +
    '</div>';
  }).join('') + '</div>';
}

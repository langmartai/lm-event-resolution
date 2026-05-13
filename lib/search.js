const { open } = require('./db');

// FTS5 query — accepts standard FTS5 syntax including prefix (foo*),
// phrase ("foo bar"), and boolean (foo AND bar / foo NOT bar).
function search(query, { type, asset, status, limit = 50, db = open() } = {}) {
  if (!query || !query.trim()) return [];
  const ftsQuery = sanitize(query);

  const filters = [];
  const params = { q: ftsQuery, limit };
  if (type)   { filters.push('n.type = @type'); params.type = type; }
  if (asset)  { filters.push('n.asset = @asset'); params.asset = asset; }
  if (status) { filters.push('n.status = @status'); params.status = status; }
  const filterSql = filters.length ? ` AND ${filters.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT n.*,
           bm25(nodes_fts) AS score,
           snippet(nodes_fts, 1, '<mark>', '</mark>', '...', 32) AS snippet
    FROM nodes_fts
    JOIN nodes n ON n.id = nodes_fts.rowid
    WHERE nodes_fts MATCH @q ${filterSql}
    ORDER BY score
    LIMIT @limit
  `).all(params);

  return rows.map(row => ({
    ...row,
    props: row.props_json ? JSON.parse(row.props_json) : {},
  }));
}

// Sanitize user input for FTS5. We allow plain words, quoted phrases, and
// the connectives AND/OR/NOT. Strip characters that would break the parser.
function sanitize(q) {
  const trimmed = q.trim();
  // If the user used FTS operators, respect them.
  if (/["*]|AND|OR|NOT/.test(trimmed)) return trimmed;
  // Otherwise build a tolerant prefix-OR query so partial words match.
  const tokens = trimmed
    .split(/\s+/)
    .map(t => t.replace(/[^\w\d]/g, ''))
    .filter(Boolean);
  if (!tokens.length) return '""';
  return tokens.map(t => `${t}*`).join(' OR ');
}

module.exports = { search };

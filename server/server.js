const path = require('path');
const express = require('express');
const cors = require('cors');
const { db, nodes, edges, sources, updates, search, graph } = require('../lib');

const PORT = Number(process.env.LER_PORT || 4100);

// Ensure DB exists + migrations applied before serving.
db.open();
db.migrate();

const app = express();
app.use(cors({
  exposedHeaders: ['X-Claude-Session-Id', 'X-Claude-Project'],
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Session-tracking middleware. Every mutating request MUST identify the
// Claude Code session (or other caller) that originated the call. Identification
// flows from (in priority order):
//   1. X-Claude-Session-Id / X-Claude-Project / X-Claude-Tool-Use-Id headers
//   2. Body fields { sessionId, projectPath, toolUseId, actor }
//   3. Query params (?sessionId=... etc)
//
// For mutating methods (POST/PATCH/DELETE) the session id is REQUIRED — the
// middleware returns 400 SESSION_REQUIRED if none is supplied. Reads (GET)
// do not require it and are not written to the audit log.
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

app.use((req, res, next) => {
  const h = req.headers;
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  const q = req.query || {};
  req.audit = {
    sessionId: h['x-claude-session-id'] || b.sessionId || q.sessionId || null,
    projectPath: h['x-claude-project'] || h['x-claude-cwd'] || b.projectPath || q.projectPath || null,
    toolUseId: h['x-claude-tool-use-id'] || b.toolUseId || q.toolUseId || null,
    intent: h['x-claude-intent'] || b.intent || q.intent || null,
    actor: h['x-claude-actor'] || b.actor || q.actor ||
      (h['x-claude-session-id'] ? `session:${h['x-claude-session-id']}` : 'api'),
  };

  // Enforce: every mutating request must identify its session AND its intent.
  if (MUTATING_METHODS.has(req.method) && req.path.startsWith('/api/')) {
    if (!req.audit.sessionId) {
      return res.status(400).json({
        error: 'SESSION_REQUIRED',
        message: 'Mutating requests must include an X-Claude-Session-Id header (or sessionId body/query field). Reads do not require this.',
        hint: 'Set X-Claude-Session-Id to your Claude Code session id, lm-assist execution id, or any stable caller identifier.',
      });
    }
    if (!req.audit.intent) {
      return res.status(400).json({
        error: 'INTENT_REQUIRED',
        message: 'Mutating requests must include an X-Claude-Intent header (or intent body/query field) describing WHY this action is happening.',
        hint: 'Example intents: "trade-monitor brent-oil refresh", "resolve RD1 after Iran ceasefire collapse", "nightly fundamental import".',
      });
    }
  }
  next();
});

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// ============================================================
// Health
// ============================================================
app.get('/api/health', (req, res) => {
  const stats = {
    ok: true,
    db: db.open().name,
    counts: {
      nodes: db.open().prepare('SELECT COUNT(*) AS n FROM nodes').get().n,
      edges: db.open().prepare('SELECT COUNT(*) AS n FROM edges').get().n,
      sources: db.open().prepare('SELECT COUNT(*) AS n FROM sources').get().n,
      updates: db.open().prepare('SELECT COUNT(*) AS n FROM updates').get().n,
    },
  };
  res.json(stats);
});

// ============================================================
// Nodes
// ============================================================
app.get('/api/nodes', (req, res) => {
  const { type, asset, status, limit, offset, sort, order } = req.query;
  const rows = nodes.list({
    type, asset, status, sort, order,
    limit: limit ? Number(limit) : 50,
    offset: offset ? Number(offset) : 0,
  });
  const total = nodes.count({ type, asset, status });
  res.json({
    total, count: rows.length,
    offset: offset ? Number(offset) : 0,
    limit: limit ? Number(limit) : 50,
    items: rows,
  });
});

app.post('/api/nodes', (req, res) => {
  try {
    const body = req.body || {};
    const created = nodes.create(body, { ...req.audit, reason: body.reason });
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/nodes/:ref', (req, res) => {
  const n = nodes.getByIdOrUid(req.params.ref);
  if (!n) return res.status(404).json({ error: 'not found' });
  const srcs = sources.listForNode(n.id);
  const outEdges = edges.listOut(n.id);
  const inEdges = edges.listIn(n.id);
  const history = updates.listForEntity('node', n.id);
  const sessionsForNode = updates.listSessionsForNode(n.id);
  res.json({
    node: n, sources: srcs,
    edges: { out: outEdges, in: inEdges },
    history,
    sessions: sessionsForNode,
  });
});

app.get('/api/nodes/:ref/sessions', (req, res) => {
  const n = nodes.getByIdOrUid(req.params.ref);
  if (!n) return res.status(404).json({ error: 'not found' });
  res.json(updates.listSessionsForNode(n.id));
});

app.patch('/api/nodes/:ref', (req, res) => {
  try {
    const updated = nodes.update(req.params.ref, req.body || {}, {
      ...req.audit, reason: req.body && req.body.reason,
    });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/nodes/:ref/status', (req, res) => {
  try {
    const { status, reason } = req.body || {};
    if (!status) return res.status(400).json({ error: 'status is required' });
    const updated = nodes.setStatus(req.params.ref, status, { ...req.audit, reason });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/nodes/:ref', (req, res) => {
  const ok = nodes.remove(req.params.ref, { ...req.audit, reason: req.query.reason });
  res.json({ deleted: ok });
});

// ============================================================
// Edges
// ============================================================
app.get('/api/edges', (req, res) => {
  const { type, limit } = req.query;
  res.json(edges.listAll({ type, limit: limit ? Number(limit) : 500 }));
});

app.post('/api/edges', (req, res) => {
  try {
    const { src, dst, type, weight, props, reason } = req.body || {};
    if (!src || !dst || !type) return res.status(400).json({ error: 'src, dst, type required' });
    const e = edges.link(src, dst, type, { ...req.audit, weight, props, reason });
    res.status(201).json(e);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/edges', (req, res) => {
  const { src, dst, type, reason } = req.body || {};
  const ok = edges.unlink(src, dst, type, { ...req.audit, reason });
  res.json({ unlinked: ok });
});

// ============================================================
// Sources
// ============================================================
app.get('/api/sources', (req, res) => {
  res.json(sources.list({ source_type: req.query.type }));
});

app.post('/api/sources', (req, res) => {
  try {
    const s = sources.upsert(req.body || {}, req.audit);
    res.status(201).json(s);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/sources/:sourceId/attach', (req, res) => {
  try {
    const { node, evidence } = req.body || {};
    if (!node) return res.status(400).json({ error: 'node ref required' });
    const link = sources.attach(node, Number(req.params.sourceId), { ...req.audit, evidence });
    res.status(201).json(link || { attached: false, reason: 'already attached' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================
// Search
// ============================================================
app.get('/api/search', (req, res) => {
  const { q, type, asset, status, limit } = req.query;
  if (!q) return res.json({ query: '', items: [] });
  const items = search.search(q, {
    type, asset, status,
    limit: limit ? Number(limit) : 50,
  });
  res.json({ query: q, count: items.length, items });
});

// ============================================================
// Graph / dependencies
// ============================================================
app.get('/api/graph/:ref', (req, res) => {
  const { depth, types } = req.query;
  const result = graph.fetchNeighborhood(req.params.ref, {
    depth: depth ? Number(depth) : 2,
    types: types ? types.split(',') : undefined,
  });
  res.json(result);
});

app.get('/api/deps/:ref', (req, res) => {
  const tree = graph.dependencyChain(req.params.ref);
  if (!tree) return res.status(404).json({ error: 'not found' });
  res.json(tree);
});

// ============================================================
// Updates audit
// ============================================================
app.get('/api/updates', (req, res) => {
  const { limit, offset, sessionId, actor, sort, order } = req.query;
  res.json(updates.listRecent({
    limit: limit ? Number(limit) : 50,
    offset: offset ? Number(offset) : 0,
    sessionId, actor, sort, order,
  }));
});

app.get('/api/updates/:entityType/:entityId', (req, res) => {
  res.json(updates.listForEntity(req.params.entityType, Number(req.params.entityId)));
});

// ============================================================
// Sessions — Who has been operating on this repository?
// Only mutations (POST/PATCH/DELETE on nodes/edges/sources) write to `updates`,
// so this endpoint returns exactly the Claude Code sessions (or other clients)
// that have ever created or modified data. Read-only GETs are NOT tracked.
// ============================================================
app.get('/api/sessions', (req, res) => {
  const { limit, offset, sort, order } = req.query;
  res.json(updates.listSessions({
    limit: limit ? Number(limit) : 25,
    offset: offset ? Number(offset) : 0,
    sort, order,
  }));
});

// ============================================================
// Dashboard — single-shot aggregate for the dashboard UI
// ============================================================
app.get('/api/dashboard', (req, res) => {
  const D = db.open();
  const rowsOne = (sql, ...args) => D.prepare(sql).all(...args);
  const one = (sql, ...args) => D.prepare(sql).get(...args);
  const fs = require('fs');
  const path = require('path');

  // --- Counts ---
  const counts = {
    nodes:   one('SELECT COUNT(*) AS n FROM nodes').n,
    edges:   one('SELECT COUNT(*) AS n FROM edges').n,
    sources: one('SELECT COUNT(*) AS n FROM sources').n,
    node_sources: one('SELECT COUNT(*) AS n FROM node_sources').n,
    tags:    one('SELECT COUNT(*) AS n FROM tags').n,
    updates: one('SELECT COUNT(*) AS n FROM updates').n,
    sessions: one(`SELECT COUNT(DISTINCT session_id) AS n FROM updates WHERE session_id IS NOT NULL`).n,
    intents:  one(`SELECT COUNT(DISTINCT intent) AS n FROM updates WHERE intent IS NOT NULL`).n,
  };

  // --- DB health: file sizes + page stats ---
  const dbPath = D.name;
  function sizeOf(p) { try { return fs.statSync(p).size; } catch { return 0; } }
  const pageCount = one('PRAGMA page_count').page_count;
  const pageSize  = one('PRAGMA page_size').page_size;
  const freelist  = one('PRAGMA freelist_count').freelist_count;
  const integrity = D.prepare('PRAGMA quick_check').pluck().get();
  const schemaVersions = D.prepare('SELECT version FROM schema_version ORDER BY version').pluck().all();
  const health = {
    db_path: dbPath,
    db_size_bytes: sizeOf(dbPath),
    db_size_wal:   sizeOf(dbPath + '-wal'),
    db_size_shm:   sizeOf(dbPath + '-shm'),
    page_count:    pageCount,
    page_size:     pageSize,
    freelist_count: freelist,
    integrity:     integrity,
    schema_versions: schemaVersions,
    journal_mode:  one('PRAGMA journal_mode').journal_mode,
    foreign_keys:  one('PRAGMA foreign_keys').foreign_keys === 1,
    sqlite_version: D.prepare('SELECT sqlite_version() AS v').get().v,
  };

  // --- Performance: time a few representative reads + writes ---
  function timeIt(label, fn) {
    const t0 = process.hrtime.bigint();
    fn();
    const t1 = process.hrtime.bigint();
    return { label, ms: Number(t1 - t0) / 1e6 };
  }
  const perf = [
    timeIt('SELECT 1', () => one('SELECT 1 AS x')),
    timeIt('count nodes', () => one('SELECT COUNT(*) AS n FROM nodes')),
    timeIt('FTS search "Hormuz"', () => rowsOne(`
      SELECT n.id FROM nodes_fts JOIN nodes n ON n.id = nodes_fts.rowid
      WHERE nodes_fts MATCH 'Hormuz' LIMIT 10
    `)),
    timeIt('list 100 nodes', () => rowsOne('SELECT * FROM nodes ORDER BY updated_at DESC LIMIT 100')),
    timeIt('list sessions', () => rowsOne(`
      SELECT session_id, COUNT(*) AS n FROM updates WHERE session_id IS NOT NULL
      GROUP BY session_id ORDER BY MAX(created_at) DESC LIMIT 25
    `)),
  ];

  const byType    = rowsOne(`SELECT type AS k, COUNT(*) AS n FROM nodes GROUP BY type ORDER BY n DESC`);
  const byStatus  = rowsOne(`SELECT status AS k, COUNT(*) AS n FROM nodes GROUP BY status ORDER BY n DESC`);
  const byCertainty = rowsOne(`
    SELECT COALESCE(certainty, '—') AS k, COUNT(*) AS n
    FROM nodes WHERE certainty IS NOT NULL OR 1=1
    GROUP BY COALESCE(certainty, '—') ORDER BY n DESC
  `);
  const byAsset = rowsOne(`
    SELECT COALESCE(asset, '—') AS k, COUNT(*) AS n FROM nodes
    GROUP BY COALESCE(asset, '—') ORDER BY n DESC LIMIT 20
  `);
  const byDirection = rowsOne(`
    SELECT COALESCE(direction, '—') AS k, COUNT(*) AS n FROM nodes
    GROUP BY COALESCE(direction, '—') ORDER BY n DESC
  `);

  // Top sessions by update count (the busiest sessions).
  const topSessions = rowsOne(`
    SELECT session_id,
           COUNT(*) AS update_count,
           COUNT(DISTINCT entity_id) FILTER (WHERE entity_type='node') AS nodes_touched,
           MAX(created_at) AS last_seen,
           GROUP_CONCAT(DISTINCT intent) AS intents
    FROM updates WHERE session_id IS NOT NULL
    GROUP BY session_id
    ORDER BY update_count DESC LIMIT 10
  `);

  // Most-touched nodes — the nodes with the most audit-log entries.
  const topNodes = rowsOne(`
    SELECT n.id, n.uid, n.type, n.name, n.status, n.asset,
           COUNT(u.id) AS touches,
           COUNT(DISTINCT u.session_id) AS distinct_sessions,
           MAX(u.created_at) AS last_change
    FROM nodes n LEFT JOIN updates u ON u.entity_type = 'node' AND u.entity_id = n.id
    GROUP BY n.id ORDER BY touches DESC, last_change DESC LIMIT 10
  `);

  // ETA-soon nodes — forward-looking entities whose expected resolution date
  // falls in the next 30 days. Drives "what's coming up".
  const etaSoon = rowsOne(`
    SELECT id, uid, type, name, status, asset, eta_date, certainty
    FROM nodes
    WHERE eta_date IS NOT NULL
      AND date(eta_date) BETWEEN date('now') AND date('now', '+30 days')
      AND status NOT IN ('invalidated', 'resolved', 'superseded')
    ORDER BY date(eta_date) ASC LIMIT 15
  `);

  // Stale nodes — entities whose Valid To window has passed and that have
  // not been re-validated. Surfaces work that needs attention.
  const stale = rowsOne(`
    SELECT id, uid, type, name, status, asset, valid_to
    FROM nodes
    WHERE valid_to IS NOT NULL
      AND date(valid_to) < date('now')
      AND status = 'active'
    ORDER BY date(valid_to) ASC LIMIT 10
  `);

  // Intent breakdown — what kinds of things have sessions been doing?
  const intents = rowsOne(`
    SELECT intent, COUNT(*) AS n,
           COUNT(DISTINCT session_id) AS distinct_sessions,
           MAX(created_at) AS last_seen
    FROM updates WHERE intent IS NOT NULL
    GROUP BY intent ORDER BY n DESC LIMIT 15
  `);

  // Recent changes — latest 15 mutations.
  const recent = rowsOne(`
    SELECT * FROM updates ORDER BY id DESC LIMIT 15
  `).map(r => ({
    ...r,
    before: r.before_json ? JSON.parse(r.before_json) : null,
    after: r.after_json ? JSON.parse(r.after_json) : null,
  }));

  // Activity-over-time — last 14 days, mutations per day.
  const activityByDay = rowsOne(`
    SELECT date(created_at) AS day, COUNT(*) AS n
    FROM updates
    WHERE date(created_at) >= date('now', '-14 days')
    GROUP BY date(created_at) ORDER BY day DESC
  `);

  res.json({
    counts, health, perf,
    byType, byStatus, byCertainty, byAsset, byDirection,
    topSessions, topNodes, etaSoon, stale, intents, recent, activityByDay,
  });
});

app.get('/api/sessions/:sessionId', (req, res) => {
  const { limit, offset, sort, order } = req.query;
  res.json(updates.getSessionDetail(req.params.sessionId, {
    limit: limit ? Number(limit) : 50,
    offset: offset ? Number(offset) : 0,
    sort, order,
  }));
});

// ============================================================
// Meta — types, statuses, edge types (for the UI)
// ============================================================
app.get('/api/meta', (req, res) => {
  res.json({
    node_types: [...nodes.VALID_TYPES],
    statuses: [...nodes.VALID_STATUSES],
    edge_types: [...edges.VALID_EDGE_TYPES],
  });
});

// ============================================================
// Distinct assets (for filter dropdowns)
// ============================================================
app.get('/api/assets', (req, res) => {
  const rows = db.open().prepare(`
    SELECT asset, COUNT(*) AS n
    FROM nodes
    WHERE asset IS NOT NULL
    GROUP BY asset
    ORDER BY asset
  `).all();
  res.json(rows);
});

// Fallback: serve index.html for unknown GETs (SPA support)
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const HOST = process.env.LER_HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`lm-event-resolution listening on http://${HOST}:${PORT}`);
  console.log(`Database: ${db.open().name}`);
});

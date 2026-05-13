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
    actor: h['x-claude-actor'] || b.actor || q.actor ||
      (h['x-claude-session-id'] ? `session:${h['x-claude-session-id']}` : 'api'),
  };

  // Enforce: every mutating request must identify its session.
  if (MUTATING_METHODS.has(req.method) && req.path.startsWith('/api/') && !req.audit.sessionId) {
    return res.status(400).json({
      error: 'SESSION_REQUIRED',
      message: 'Mutating requests must include an X-Claude-Session-Id header (or sessionId body/query field). Reads do not require this.',
      hint: 'Set X-Claude-Session-Id to your Claude Code session id, lm-assist execution id, or any stable caller identifier.',
    });
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

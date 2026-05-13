const path = require('path');
const express = require('express');
const cors = require('cors');
const { db, nodes, edges, sources, updates, search, graph } = require('../lib');

const PORT = Number(process.env.LER_PORT || 4100);

// Ensure DB exists + migrations applied before serving.
db.open();
db.migrate();

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

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
  const { type, asset, status, limit, offset } = req.query;
  const rows = nodes.list({
    type, asset, status,
    limit: limit ? Number(limit) : 100,
    offset: offset ? Number(offset) : 0,
  });
  const total = nodes.count({ type, asset, status });
  res.json({ total, count: rows.length, items: rows });
});

app.post('/api/nodes', (req, res) => {
  try {
    const body = req.body || {};
    const created = nodes.create(body, {
      actor: body.actor || 'api',
      reason: body.reason,
    });
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
  res.json({ node: n, sources: srcs, edges: { out: outEdges, in: inEdges }, history });
});

app.patch('/api/nodes/:ref', (req, res) => {
  try {
    const updated = nodes.update(req.params.ref, req.body || {}, {
      actor: (req.body && req.body.actor) || 'api',
      reason: req.body && req.body.reason,
    });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/nodes/:ref/status', (req, res) => {
  try {
    const { status, reason, actor } = req.body || {};
    if (!status) return res.status(400).json({ error: 'status is required' });
    const updated = nodes.setStatus(req.params.ref, status, {
      actor: actor || 'api', reason,
    });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/nodes/:ref', (req, res) => {
  const ok = nodes.remove(req.params.ref, {
    actor: req.query.actor || 'api',
    reason: req.query.reason,
  });
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
    const { src, dst, type, weight, props, actor, reason } = req.body || {};
    if (!src || !dst || !type) return res.status(400).json({ error: 'src, dst, type required' });
    const e = edges.link(src, dst, type, {
      weight, props, actor: actor || 'api', reason,
    });
    res.status(201).json(e);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/edges', (req, res) => {
  const { src, dst, type } = req.body || {};
  const ok = edges.unlink(src, dst, type, {
    actor: (req.body && req.body.actor) || 'api',
    reason: req.body && req.body.reason,
  });
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
    const s = sources.upsert(req.body || {});
    res.status(201).json(s);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/sources/:sourceId/attach', (req, res) => {
  try {
    const { node, evidence } = req.body || {};
    if (!node) return res.status(400).json({ error: 'node ref required' });
    const link = sources.attach(node, Number(req.params.sourceId), { evidence });
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
  res.json(updates.listRecent({ limit: req.query.limit ? Number(req.query.limit) : 100 }));
});

app.get('/api/updates/:entityType/:entityId', (req, res) => {
  res.json(updates.listForEntity(req.params.entityType, Number(req.params.entityId)));
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

app.listen(PORT, () => {
  console.log(`lm-event-resolution listening on http://localhost:${PORT}`);
  console.log(`Database: ${db.open().name}`);
});

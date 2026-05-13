const { open } = require('./db');
const nodes = require('./nodes');
const updates = require('./updates');

const VALID_EDGE_TYPES = new Set([
  'derives_from',  // sub_factor derives from event
  'supports',      // evidence supports a claim
  'contradicts',   // evidence contradicts a claim
  'supersedes',    // new version supersedes old
  'gates',         // A must resolve before B can resolve
  'resolves_to',   // event/driver resolves into outcome
  'monitors',      // monitor watches a driver
  'parent_of',     // hierarchical (driver → sub_driver)
  'projects_to',   // scenario projection
  'causes',        // causal relationship
  'depends_on',    // dependency
  'cross_refs',    // soft cross-reference
]);

function link(srcRef, dstRef, type, opts = {}) {
  const { db = open(), weight, props, actor = 'unknown', reason, sessionId, projectPath, toolUseId, intent, parentSessionId } = opts;
  if (!VALID_EDGE_TYPES.has(type)) {
    throw new Error(`Invalid edge type: ${type}. Must be one of: ${[...VALID_EDGE_TYPES].join(', ')}`);
  }
  const src = nodes.getByIdOrUid(srcRef, { db });
  const dst = nodes.getByIdOrUid(dstRef, { db });
  if (!src) throw new Error(`Source node not found: ${srcRef}`);
  if (!dst) throw new Error(`Destination node not found: ${dstRef}`);
  if (src.id === dst.id) throw new Error('Self-loops not allowed');

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO edges (src_id, dst_id, type, weight, props_json)
    VALUES (?, ?, ?, ?, ?)
  `);

  const txn = db.transaction(() => {
    const result = stmt.run(
      src.id, dst.id, type,
      weight == null ? null : Number(weight),
      props ? JSON.stringify(props) : null
    );
    const edge = getById(result.lastInsertRowid, { db });
    updates.record(db, {
      entityType: 'edge', entityId: edge.id,
      changeType: 'link',
      before: null,
      after: { ...edge, src_uid: src.uid, dst_uid: dst.uid },
      reason, actor, sessionId, projectPath, toolUseId, parentSessionId, intent,
    });
    return edge;
  });

  return txn();
}

function unlink(srcRef, dstRef, type, opts = {}) {
  const { db = open(), actor = 'unknown', reason, sessionId, projectPath, toolUseId, intent, parentSessionId } = opts;
  const src = nodes.getByIdOrUid(srcRef, { db });
  const dst = nodes.getByIdOrUid(dstRef, { db });
  if (!src || !dst) return false;
  const edge = db.prepare(`
    SELECT * FROM edges WHERE src_id = ? AND dst_id = ? AND type = ?
  `).get(src.id, dst.id, type);
  if (!edge) return false;

  const txn = db.transaction(() => {
    db.prepare('DELETE FROM edges WHERE id = ?').run(edge.id);
    updates.record(db, {
      entityType: 'edge', entityId: edge.id,
      changeType: 'unlink',
      before: { ...edge, src_uid: src.uid, dst_uid: dst.uid },
      after: null, reason, actor, sessionId, projectPath, toolUseId, parentSessionId, intent,
    });
    return true;
  });

  return txn();
}

function getById(id, { db = open() } = {}) {
  const row = db.prepare('SELECT * FROM edges WHERE id = ?').get(id);
  return row ? parseRow(row) : null;
}

function listOut(nodeRef, { type, db = open() } = {}) {
  const node = nodes.getByIdOrUid(nodeRef, { db });
  if (!node) return [];
  const sql = type
    ? 'SELECT e.*, n.uid AS dst_uid, n.name AS dst_name, n.type AS dst_node_type FROM edges e JOIN nodes n ON n.id = e.dst_id WHERE e.src_id = ? AND e.type = ?'
    : 'SELECT e.*, n.uid AS dst_uid, n.name AS dst_name, n.type AS dst_node_type FROM edges e JOIN nodes n ON n.id = e.dst_id WHERE e.src_id = ?';
  const rows = type
    ? db.prepare(sql).all(node.id, type)
    : db.prepare(sql).all(node.id);
  return rows.map(parseRow);
}

function listIn(nodeRef, { type, db = open() } = {}) {
  const node = nodes.getByIdOrUid(nodeRef, { db });
  if (!node) return [];
  const sql = type
    ? 'SELECT e.*, n.uid AS src_uid, n.name AS src_name, n.type AS src_node_type FROM edges e JOIN nodes n ON n.id = e.src_id WHERE e.dst_id = ? AND e.type = ?'
    : 'SELECT e.*, n.uid AS src_uid, n.name AS src_name, n.type AS src_node_type FROM edges e JOIN nodes n ON n.id = e.src_id WHERE e.dst_id = ?';
  const rows = type
    ? db.prepare(sql).all(node.id, type)
    : db.prepare(sql).all(node.id);
  return rows.map(parseRow);
}

function listAll({ type, limit = 500, db = open() } = {}) {
  const sql = type
    ? 'SELECT * FROM edges WHERE type = ? ORDER BY id DESC LIMIT ?'
    : 'SELECT * FROM edges ORDER BY id DESC LIMIT ?';
  const rows = type ? db.prepare(sql).all(type, limit) : db.prepare(sql).all(limit);
  return rows.map(parseRow);
}

function parseRow(row) {
  return {
    ...row,
    props: row.props_json ? JSON.parse(row.props_json) : {},
  };
}

module.exports = { link, unlink, getById, listOut, listIn, listAll, VALID_EDGE_TYPES };

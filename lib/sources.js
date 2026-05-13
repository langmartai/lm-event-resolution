const { open } = require('./db');
const nodes = require('./nodes');
const updates = require('./updates');

function upsert({ citation, url, source_type, trust_level, notes }, opts = {}) {
  const { db = open(), actor = 'unknown', reason, sessionId, projectPath, toolUseId } = opts;
  if (!citation) throw new Error('citation is required');
  const existing = db.prepare(`
    SELECT * FROM sources WHERE citation = ? AND COALESCE(url, '') = COALESCE(?, '')
  `).get(citation, url || null);
  if (existing) return existing;

  const stmt = db.prepare(`
    INSERT INTO sources (citation, url, source_type, trust_level, notes)
    VALUES (?, ?, ?, ?, ?)
  `);

  const txn = db.transaction(() => {
    const result = stmt.run(
      citation,
      url || null,
      source_type || null,
      trust_level == null ? null : Number(trust_level),
      notes || null
    );
    const source = getById(result.lastInsertRowid, { db });
    updates.record(db, {
      entityType: 'source', entityId: source.id,
      changeType: 'create', before: null, after: source,
      reason, actor, sessionId, projectPath, toolUseId,
    });
    return source;
  });

  return txn();
}

function attach(nodeRef, sourceId, opts = {}) {
  const { evidence, db = open(), actor = 'unknown', reason, sessionId, projectPath, toolUseId } = opts;
  const node = nodes.getByIdOrUid(nodeRef, { db });
  if (!node) throw new Error(`Node not found: ${nodeRef}`);
  const source = getById(sourceId, { db });
  if (!source) throw new Error(`Source not found: ${sourceId}`);

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO node_sources (node_id, source_id, evidence)
    VALUES (?, ?, ?)
  `);

  const txn = db.transaction(() => {
    const result = stmt.run(node.id, source.id, evidence || null);
    if (result.changes === 0) {
      // already attached with this evidence
      return null;
    }
    const link = db.prepare('SELECT * FROM node_sources WHERE id = ?').get(result.lastInsertRowid);
    updates.record(db, {
      entityType: 'node_source', entityId: link.id,
      changeType: 'link',
      before: null,
      after: { ...link, node_uid: node.uid, source_citation: source.citation },
      reason, actor, sessionId, projectPath, toolUseId,
    });
    return link;
  });

  return txn();
}

function listForNode(nodeRef, { db = open() } = {}) {
  const node = nodes.getByIdOrUid(nodeRef, { db });
  if (!node) return [];
  return db.prepare(`
    SELECT s.*, ns.evidence
    FROM sources s
    JOIN node_sources ns ON ns.source_id = s.id
    WHERE ns.node_id = ?
    ORDER BY s.id
  `).all(node.id);
}

function getById(id, { db = open() } = {}) {
  return db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
}

function list({ source_type, limit = 200, db = open() } = {}) {
  const sql = source_type
    ? 'SELECT * FROM sources WHERE source_type = ? ORDER BY id DESC LIMIT ?'
    : 'SELECT * FROM sources ORDER BY id DESC LIMIT ?';
  return source_type ? db.prepare(sql).all(source_type, limit) : db.prepare(sql).all(limit);
}

module.exports = { upsert, attach, listForNode, getById, list };

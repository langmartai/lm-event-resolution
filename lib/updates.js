const { open } = require('./db');

function record(db, { entityType, entityId, changeType, before, after, reason, actor, sessionId, projectPath, toolUseId }) {
  const stmt = db.prepare(`
    INSERT INTO updates (entity_type, entity_id, change_type, before_json, after_json,
                         reason, actor, session_id, project_path, tool_use_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    entityType,
    entityId,
    changeType,
    before == null ? null : JSON.stringify(before),
    after == null ? null : JSON.stringify(after),
    reason || null,
    actor || null,
    sessionId || null,
    projectPath || null,
    toolUseId || null
  );
}

function listForEntity(entityType, entityId, { db = open() } = {}) {
  return db.prepare(`
    SELECT * FROM updates
    WHERE entity_type = ? AND entity_id = ?
    ORDER BY id DESC
  `).all(entityType, entityId).map(parseRow);
}

function listRecent({ db = open(), limit = 100, sessionId, actor } = {}) {
  const filters = [];
  const params = { limit };
  if (sessionId) { filters.push('session_id = @sessionId'); params.sessionId = sessionId; }
  if (actor) { filters.push('actor = @actor'); params.actor = actor; }
  const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  return db.prepare(`
    SELECT * FROM updates ${whereSql} ORDER BY id DESC LIMIT @limit
  `).all(params).map(parseRow);
}

// Group updates by session for a high-level "who's been doing what" view.
function listSessions({ db = open(), limit = 100 } = {}) {
  return db.prepare(`
    SELECT
      session_id,
      COUNT(*) AS update_count,
      COUNT(DISTINCT entity_id) FILTER (WHERE entity_type = 'node') AS nodes_touched,
      MIN(created_at) AS first_seen,
      MAX(created_at) AS last_seen,
      GROUP_CONCAT(DISTINCT actor) AS actors,
      GROUP_CONCAT(DISTINCT project_path) AS project_paths
    FROM updates
    WHERE session_id IS NOT NULL
    GROUP BY session_id
    ORDER BY last_seen DESC
    LIMIT ?
  `).all(limit);
}

function getSessionDetail(sessionId, { db = open(), limit = 500 } = {}) {
  const updates = db.prepare(`
    SELECT * FROM updates WHERE session_id = ? ORDER BY id DESC LIMIT ?
  `).all(sessionId, limit).map(parseRow);
  const nodes = db.prepare(`
    SELECT DISTINCT n.id, n.uid, n.type, n.name, n.status, n.asset
    FROM updates u JOIN nodes n ON n.id = u.entity_id
    WHERE u.session_id = ? AND u.entity_type = 'node'
    ORDER BY n.id DESC LIMIT ?
  `).all(sessionId, limit);
  const summary = db.prepare(`
    SELECT
      COUNT(*) AS update_count,
      COUNT(DISTINCT entity_id) FILTER (WHERE entity_type = 'node') AS nodes_touched,
      MIN(created_at) AS first_seen,
      MAX(created_at) AS last_seen,
      GROUP_CONCAT(DISTINCT actor) AS actors,
      GROUP_CONCAT(DISTINCT project_path) AS project_paths
    FROM updates WHERE session_id = ?
  `).get(sessionId);
  return { session_id: sessionId, summary, nodes, updates };
}

function parseRow(row) {
  return {
    ...row,
    before: row.before_json ? JSON.parse(row.before_json) : null,
    after: row.after_json ? JSON.parse(row.after_json) : null,
  };
}

module.exports = { record, listForEntity, listRecent, listSessions, getSessionDetail };

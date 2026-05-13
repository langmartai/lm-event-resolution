const { open } = require('./db');

// MissingSessionError is thrown when a mutation is attempted without a session id.
// All mutators in the library funnel through `record()`, so this is the single
// enforcement point for "every change must be attributable to a Claude Code session".
class MissingSessionError extends Error {
  constructor(msg) {
    super(msg || 'sessionId is required for every mutation — pass via opts.sessionId (library), --session-id (CLI), or X-Claude-Session-Id header (HTTP).');
    this.name = 'MissingSessionError';
    this.code = 'SESSION_REQUIRED';
  }
}

// MissingIntentError is thrown when a mutation is attempted without an intent.
// Intent captures WHY the session is taking this action ("trade-monitor refresh",
// "resolve RD1 after Iran ceasefire collapsed", "nightly import"). Same chokepoint
// as sessionId so every audit row has both who AND why.
class MissingIntentError extends Error {
  constructor(msg) {
    super(msg || 'intent is required for every mutation — pass via opts.intent (library), --intent (CLI), or X-Claude-Intent header (HTTP). Describe WHY this action is happening so future readers can trace the audit trail.');
    this.name = 'MissingIntentError';
    this.code = 'INTENT_REQUIRED';
  }
}

function record(db, { entityType, entityId, changeType, before, after, reason, actor, sessionId, projectPath, toolUseId, intent, parentSessionId }) {
  if (!sessionId || String(sessionId).trim() === '') {
    throw new MissingSessionError();
  }
  if (!intent || String(intent).trim() === '') {
    throw new MissingIntentError();
  }
  const stmt = db.prepare(`
    INSERT INTO updates (entity_type, entity_id, change_type, before_json, after_json,
                         reason, actor, session_id, project_path, tool_use_id, intent, parent_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    entityType,
    entityId,
    changeType,
    before == null ? null : JSON.stringify(before),
    after == null ? null : JSON.stringify(after),
    reason || null,
    actor || null,
    sessionId,
    projectPath || null,
    toolUseId || null,
    intent || null,
    parentSessionId || null
  );
}

function listForEntity(entityType, entityId, { db = open() } = {}) {
  return db.prepare(`
    SELECT * FROM updates
    WHERE entity_type = ? AND entity_id = ?
    ORDER BY id DESC
  `).all(entityType, entityId).map(parseRow);
}

function listRecent({ db = open(), limit = 100, offset = 0, sessionId, actor, sort = 'id', order = 'desc' } = {}) {
  const filters = [];
  const params = { limit, offset };
  if (sessionId) { filters.push('session_id = @sessionId'); params.sessionId = sessionId; }
  if (actor) { filters.push('actor = @actor'); params.actor = actor; }
  const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const sortColumn = ['id', 'created_at', 'change_type', 'entity_type'].includes(sort) ? sort : 'id';
  const sortOrder = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM updates ${whereSql}`).get(params).n;
  const items = db.prepare(`
    SELECT * FROM updates ${whereSql}
    ORDER BY ${sortColumn} ${sortOrder}
    LIMIT @limit OFFSET @offset
  `).all(params).map(parseRow);
  return { total, count: items.length, offset, limit, items };
}

// Group updates by session for a high-level "who's been doing what" view.
function listSessions({ db = open(), limit = 100, offset = 0, sort = 'last_seen', order = 'desc' } = {}) {
  const sortColumn = ['last_seen', 'first_seen', 'update_count', 'nodes_touched', 'session_id'].includes(sort)
    ? sort : 'last_seen';
  const sortOrder = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const total = db.prepare(
    `SELECT COUNT(DISTINCT session_id) AS n FROM updates WHERE session_id IS NOT NULL`
  ).get().n;
  const items = db.prepare(`
    SELECT
      session_id,
      COUNT(*) AS update_count,
      COUNT(DISTINCT entity_id) FILTER (WHERE entity_type = 'node') AS nodes_touched,
      MIN(created_at) AS first_seen,
      MAX(created_at) AS last_seen,
      GROUP_CONCAT(DISTINCT actor) AS actors,
      GROUP_CONCAT(DISTINCT project_path) AS project_paths,
      GROUP_CONCAT(DISTINCT intent) AS intents
    FROM updates
    WHERE session_id IS NOT NULL
    GROUP BY session_id
    ORDER BY ${sortColumn} ${sortOrder}
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  return { total, count: items.length, offset, limit, items };
}

function getSessionDetail(sessionId, { db = open(), limit = 100, offset = 0, sort = 'id', order = 'desc' } = {}) {
  const sortColumn = ['id', 'created_at', 'change_type', 'entity_type'].includes(sort) ? sort : 'id';
  const sortOrder = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const totalUpdates = db.prepare(`SELECT COUNT(*) AS n FROM updates WHERE session_id = ?`).get(sessionId).n;
  const updates = db.prepare(`
    SELECT * FROM updates WHERE session_id = ?
    ORDER BY ${sortColumn} ${sortOrder}
    LIMIT ? OFFSET ?
  `).all(sessionId, limit, offset).map(parseRow);
  const nodes = db.prepare(`
    SELECT DISTINCT n.id, n.uid, n.type, n.name, n.status, n.asset,
      (SELECT COUNT(*) FROM updates u2 WHERE u2.session_id = ? AND u2.entity_type = 'node' AND u2.entity_id = n.id) AS session_touches
    FROM updates u JOIN nodes n ON n.id = u.entity_id
    WHERE u.session_id = ? AND u.entity_type = 'node'
    ORDER BY session_touches DESC, n.id DESC LIMIT ?
  `).all(sessionId, sessionId, limit);
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
  // Breakdown counts for the UI dashboards.
  const byChangeType = db.prepare(`
    SELECT change_type, COUNT(*) AS n FROM updates
    WHERE session_id = ? GROUP BY change_type ORDER BY n DESC
  `).all(sessionId);
  const byEntityType = db.prepare(`
    SELECT entity_type, COUNT(*) AS n FROM updates
    WHERE session_id = ? GROUP BY entity_type ORDER BY n DESC
  `).all(sessionId);
  // Intents this session expressed. NULLs are filtered out; rows without intent
  // collapse to `(no intent)` for the UI to surface as a gap.
  const intents = db.prepare(`
    SELECT COALESCE(intent, '(no intent)') AS intent, COUNT(*) AS n,
           MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
    FROM updates WHERE session_id = ? GROUP BY intent ORDER BY n DESC
  `).all(sessionId);
  return {
    session_id: sessionId, summary,
    nodes, updates,
    byChangeType, byEntityType, intents,
    pagination: { totalUpdates, offset, limit, returned: updates.length },
  };
}

// Sessions that have mutated a specific node — used by the node-detail panel
// "which sessions touched this?". Ordered by recency.
function listSessionsForNode(nodeId, { db = open() } = {}) {
  return db.prepare(`
    SELECT
      session_id,
      COUNT(*) AS touches,
      MIN(created_at) AS first_touched,
      MAX(created_at) AS last_touched,
      GROUP_CONCAT(DISTINCT change_type) AS change_types,
      GROUP_CONCAT(DISTINCT actor) AS actors
    FROM updates
    WHERE entity_type = 'node' AND entity_id = ? AND session_id IS NOT NULL
    GROUP BY session_id
    ORDER BY last_touched DESC
  `).all(nodeId);
}

function parseRow(row) {
  return {
    ...row,
    before: row.before_json ? JSON.parse(row.before_json) : null,
    after: row.after_json ? JSON.parse(row.after_json) : null,
  };
}

module.exports = {
  record, listForEntity, listRecent, listSessions, getSessionDetail,
  listSessionsForNode, MissingSessionError, MissingIntentError,
};

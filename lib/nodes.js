const { open } = require('./db');
const updates = require('./updates');

const NODE_COLUMNS = [
  'uid', 'type', 'name', 'asset', 'body_md', 'status', 'certainty',
  'significance', 'direction', 'magnitude', 'temporal', 'props_json',
  'valid_from', 'valid_to', 'occurred_at', 'eta_date',
];

const VALID_TYPES = new Set([
  'event', 'factor', 'sub_factor', 'driver', 'monitor', 'scenario', 'outcome',
]);

const VALID_STATUSES = new Set([
  'active', 'invalidated', 'superseded', 'resolved',
  'projected', 'confirmed', 'registered', 'pending',
  'armed', 'triggered', 'expired',  // monitor statuses
]);

function create(input, opts = {}) {
  const { db = open(), actor = 'unknown', reason, sessionId, projectPath, toolUseId } = opts;
  validateInput(input);
  const row = serializeForInsert(input);

  const stmt = db.prepare(`
    INSERT INTO nodes (uid, type, name, asset, body_md, status, certainty,
      significance, direction, magnitude, temporal, props_json,
      valid_from, valid_to, occurred_at, eta_date)
    VALUES (@uid, @type, @name, @asset, @body_md, @status, @certainty,
      @significance, @direction, @magnitude, @temporal, @props_json,
      @valid_from, @valid_to, @occurred_at, @eta_date)
  `);

  const txn = db.transaction(() => {
    const result = stmt.run(row);
    const id = result.lastInsertRowid;
    const created = getById(id, { db });
    updates.record(db, {
      entityType: 'node', entityId: id,
      changeType: 'create', before: null, after: created,
      reason, actor, sessionId, projectPath, toolUseId,
    });
    return created;
  });

  return txn();
}

function update(idOrUid, patch, opts = {}) {
  const { db = open(), actor = 'unknown', reason, sessionId, projectPath, toolUseId } = opts;
  const before = getByIdOrUid(idOrUid, { db });
  if (!before) throw new Error(`Node not found: ${idOrUid}`);

  const merged = { ...before, ...patch };
  if (patch.props) {
    const existingProps = before.props_json ? JSON.parse(before.props_json) : {};
    merged.props_json = JSON.stringify({ ...existingProps, ...patch.props });
  } else if (patch.props_json) {
    merged.props_json = patch.props_json;
  }
  if (patch.status && !VALID_STATUSES.has(patch.status)) {
    throw new Error(`Invalid status: ${patch.status}`);
  }

  const stmt = db.prepare(`
    UPDATE nodes SET
      type = @type, name = @name, asset = @asset, body_md = @body_md,
      status = @status, certainty = @certainty, significance = @significance,
      direction = @direction, magnitude = @magnitude, temporal = @temporal,
      props_json = @props_json, valid_from = @valid_from, valid_to = @valid_to,
      occurred_at = @occurred_at, eta_date = @eta_date,
      updated_at = datetime('now')
    WHERE id = @id
  `);

  const txn = db.transaction(() => {
    stmt.run({
      id: before.id,
      type: merged.type, name: merged.name, asset: merged.asset || null,
      body_md: merged.body_md || null, status: merged.status,
      certainty: merged.certainty || null, significance: merged.significance || null,
      direction: merged.direction || null, magnitude: merged.magnitude || null,
      temporal: merged.temporal || null, props_json: merged.props_json || null,
      valid_from: merged.valid_from || null, valid_to: merged.valid_to || null,
      occurred_at: merged.occurred_at || null, eta_date: merged.eta_date || null,
    });
    const after = getById(before.id, { db });
    const changeType = (patch.status && patch.status !== before.status) ? 'status_change' : 'update';
    updates.record(db, {
      entityType: 'node', entityId: before.id,
      changeType, before, after, reason, actor, sessionId, projectPath, toolUseId,
    });
    return after;
  });

  return txn();
}

function setStatus(idOrUid, newStatus, opts = {}) {
  if (!VALID_STATUSES.has(newStatus)) throw new Error(`Invalid status: ${newStatus}`);
  return update(idOrUid, { status: newStatus }, opts);
}

function remove(idOrUid, opts = {}) {
  const { db = open(), actor = 'unknown', reason, sessionId, projectPath, toolUseId } = opts;
  const before = getByIdOrUid(idOrUid, { db });
  if (!before) return false;
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM nodes WHERE id = ?').run(before.id);
    updates.record(db, {
      entityType: 'node', entityId: before.id,
      changeType: 'delete', before, after: null, reason, actor, sessionId, projectPath, toolUseId,
    });
    return true;
  });
  return txn();
}

function getById(id, { db = open() } = {}) {
  const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
  return row ? parseRow(row) : null;
}

function getByUid(uid, { db = open() } = {}) {
  const row = db.prepare('SELECT * FROM nodes WHERE uid = ?').get(uid);
  return row ? parseRow(row) : null;
}

function getByIdOrUid(idOrUid, opts = {}) {
  if (typeof idOrUid === 'number') return getById(idOrUid, opts);
  if (typeof idOrUid === 'string' && /^\d+$/.test(idOrUid)) return getById(Number(idOrUid), opts);
  return getByUid(String(idOrUid), opts);
}

function list({ type, asset, status, limit = 100, offset = 0, db = open() } = {}) {
  const where = [];
  const params = {};
  if (type) { where.push('type = @type'); params.type = type; }
  if (asset) { where.push('asset = @asset'); params.asset = asset; }
  if (status) { where.push('status = @status'); params.status = status; }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT * FROM nodes ${whereSql}
    ORDER BY updated_at DESC, id DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset });
  return rows.map(parseRow);
}

function count({ type, asset, status, db = open() } = {}) {
  const where = [];
  const params = {};
  if (type) { where.push('type = @type'); params.type = type; }
  if (asset) { where.push('asset = @asset'); params.asset = asset; }
  if (status) { where.push('status = @status'); params.status = status; }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`SELECT COUNT(*) AS n FROM nodes ${whereSql}`).get(params).n;
}

function parseRow(row) {
  return {
    ...row,
    props: row.props_json ? JSON.parse(row.props_json) : {},
  };
}

function validateInput(input) {
  if (!input.uid) throw new Error('uid is required');
  if (!input.type) throw new Error('type is required');
  if (!VALID_TYPES.has(input.type)) {
    throw new Error(`Invalid type: ${input.type}. Must be one of ${[...VALID_TYPES].join(', ')}`);
  }
  if (!input.name) throw new Error('name is required');
  if (input.status && !VALID_STATUSES.has(input.status)) {
    throw new Error(`Invalid status: ${input.status}`);
  }
}

function serializeForInsert(input) {
  let props_json = input.props_json || null;
  if (input.props && !props_json) props_json = JSON.stringify(input.props);
  return {
    uid: input.uid,
    type: input.type,
    name: input.name,
    asset: input.asset || null,
    body_md: input.body_md || null,
    status: input.status || 'active',
    certainty: input.certainty || null,
    significance: input.significance || null,
    direction: input.direction || null,
    magnitude: input.magnitude || null,
    temporal: input.temporal || null,
    props_json,
    valid_from: input.valid_from || null,
    valid_to: input.valid_to || null,
    occurred_at: input.occurred_at || null,
    eta_date: input.eta_date || null,
  };
}

module.exports = {
  create, update, setStatus, remove,
  getById, getByUid, getByIdOrUid,
  list, count,
  VALID_TYPES, VALID_STATUSES,
};

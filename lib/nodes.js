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
  const { db = open(), actor = 'unknown', reason, sessionId, projectPath, toolUseId, intent, parentSessionId } = opts;
  validateInput(input);
  const row = serializeForInsert(input);
  row.search_text = buildSearchText(row);

  // Resolve concept + category against the vocabulary. Three modes:
  //   1. caller provides concept_id / category_id directly  → use as-is
  //   2. caller provides concept_key / category_key         → look up by key
  //   3. caller provides concept: {label, ...} blob         → auto-register
  // Missing concept is allowed for back-compat with pre-migration callers,
  // but `auto_register_default` flag (true by default) will inline-register
  // a concept derived from input.name when nothing is supplied. Set to false
  // to enforce strict vocabulary mode.
  const vocabAudit = { sessionId, intent, actor, projectPath, toolUseId, parentSessionId };
  const resolved = resolveVocabRefs(input, vocabAudit, db);
  row.concept_id  = resolved.concept_id;
  row.category_id = resolved.category_id;

  const stmt = db.prepare(`
    INSERT INTO nodes (uid, type, name, asset, body_md, status, certainty,
      significance, direction, magnitude, temporal, props_json,
      valid_from, valid_to, occurred_at, eta_date, search_text,
      concept_id, category_id)
    VALUES (@uid, @type, @name, @asset, @body_md, @status, @certainty,
      @significance, @direction, @magnitude, @temporal, @props_json,
      @valid_from, @valid_to, @occurred_at, @eta_date, @search_text,
      @concept_id, @category_id)
  `);

  const txn = db.transaction(() => {
    const result = stmt.run(row);
    const id = result.lastInsertRowid;
    const created = getById(id, { db });
    updates.record(db, {
      entityType: 'node', entityId: id,
      changeType: 'create', before: null, after: created,
      reason, actor, sessionId, projectPath, toolUseId, parentSessionId, intent,
    });
    return created;
  });

  return txn();
}

function update(idOrUid, patch, opts = {}) {
  const { db = open(), actor = 'unknown', reason, sessionId, projectPath, toolUseId, intent, parentSessionId } = opts;
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

  // Resolve concept_id / category_id from patch; fall back to existing values.
  const vocabAudit = { sessionId, intent, actor, projectPath, toolUseId, parentSessionId };
  const resolved = resolveVocabRefs(patch, vocabAudit, db);
  const concept_id  = resolved.concept_id  ?? before.concept_id  ?? null;
  const category_id = resolved.category_id ?? before.category_id ?? null;

  const stmt = db.prepare(`
    UPDATE nodes SET
      type = @type, name = @name, asset = @asset, body_md = @body_md,
      status = @status, certainty = @certainty, significance = @significance,
      direction = @direction, magnitude = @magnitude, temporal = @temporal,
      props_json = @props_json, valid_from = @valid_from, valid_to = @valid_to,
      occurred_at = @occurred_at, eta_date = @eta_date,
      search_text = @search_text,
      concept_id = @concept_id, category_id = @category_id,
      updated_at = datetime('now')
    WHERE id = @id
  `);

  const txn = db.transaction(() => {
    const row = {
      id: before.id,
      type: merged.type, name: merged.name, asset: merged.asset || null,
      body_md: merged.body_md || null, status: merged.status,
      certainty: merged.certainty || null, significance: merged.significance || null,
      direction: merged.direction || null, magnitude: merged.magnitude || null,
      temporal: merged.temporal || null, props_json: merged.props_json || null,
      valid_from: merged.valid_from || null, valid_to: merged.valid_to || null,
      occurred_at: merged.occurred_at || null, eta_date: merged.eta_date || null,
      concept_id, category_id,
    };
    row.search_text = buildSearchText(row);
    stmt.run(row);
    const after = getById(before.id, { db });
    const changeType = (patch.status && patch.status !== before.status) ? 'status_change' : 'update';
    updates.record(db, {
      entityType: 'node', entityId: before.id,
      changeType, before, after, reason, actor, sessionId, projectPath, toolUseId, parentSessionId, intent,
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
  const { db = open(), actor = 'unknown', reason, sessionId, projectPath, toolUseId, intent, parentSessionId } = opts;
  const before = getByIdOrUid(idOrUid, { db });
  if (!before) return false;
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM nodes WHERE id = ?').run(before.id);
    updates.record(db, {
      entityType: 'node', entityId: before.id,
      changeType: 'delete', before, after: null, reason, actor, sessionId, projectPath, toolUseId, parentSessionId,
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

function list({ type, asset, status, limit = 100, offset = 0, sort = 'updated_at', order = 'desc', db = open() } = {}) {
  const where = [];
  const params = {};
  if (type) { where.push('type = @type'); params.type = type; }
  if (asset) { where.push('asset = @asset'); params.asset = asset; }
  if (status) { where.push('status = @status'); params.status = status; }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // Allow-list of sortable columns. Anything else falls back to updated_at.
  const SORTABLE = new Set([
    'id', 'uid', 'type', 'name', 'asset', 'status', 'certainty',
    'created_at', 'updated_at', 'valid_from', 'valid_to', 'eta_date',
  ]);
  const sortColumn = SORTABLE.has(sort) ? sort : 'updated_at';
  const sortOrder = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const rows = db.prepare(`
    SELECT * FROM nodes ${whereSql}
    ORDER BY ${sortColumn} ${sortOrder}, id ${sortOrder}
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

// Build a flattened "search_text" blob from the node row. Indexed by FTS5
// so users can search by certainty (L4), evidence quotes, causal_history,
// resolution_window, status — anything stored in props_json or as a
// classification column. Plain whitespace-joined tokens; FTS handles the
// rest.
function buildSearchText(row) {
  const parts = [];
  function add(v) {
    if (v == null) return;
    if (typeof v === 'string') { if (v.trim()) parts.push(v); return; }
    if (typeof v === 'number' || typeof v === 'boolean') { parts.push(String(v)); return; }
    if (Array.isArray(v)) { v.forEach(add); return; }
    if (typeof v === 'object') { Object.values(v).forEach(add); return; }
  }
  add(row.status);
  add(row.certainty);
  add(row.significance);
  add(row.direction);
  add(row.magnitude);
  add(row.temporal);
  if (row.props_json) {
    try { add(JSON.parse(row.props_json)); } catch (e) { /* skip malformed */ }
  } else if (row.props) {
    add(row.props);
  }
  // De-dup repeated tokens to keep the index lean.
  return parts.join(' ').replace(/\s+/g, ' ').trim() || null;
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

// Resolve the optional concept + category refs on an observation. Auto-registers
// missing vocab inline (auto_registered=true) so the organizer can review later.
// Three modes per input:
//   - input.concept_id / category_id  → use as-is, no lookup
//   - input.concept_key / category_key → look up; throw if not found AND no auto-register block
//   - input.concept = {label, ...}    → register inline
//   - nothing provided                 → auto-derive a concept from input.name
function resolveVocabRefs(input, audit, db) {
  // Lazy require avoids a circular import (vocabulary.js → updates.js).
  const vocabulary = require('./vocabulary');
  let concept_id = input.concept_id || null;
  let category_id = input.category_id || null;

  // Resolve concept
  if (!concept_id) {
    if (input.concept_key) {
      const found = vocabulary.getByKey(input.concept_key, { db });
      if (!found) throw new Error(`concept_key not in vocabulary: ${input.concept_key}`);
      concept_id = found.id;
    } else if (input.concept && typeof input.concept === 'object') {
      const c = vocabulary.register({
        type: 'concept',
        label: input.concept.label || input.name,
        description: input.concept.description,
        scope: input.concept.scope || input.asset || null,
        aliases: input.concept.aliases,
        auto_registered: input.concept.auto_registered !== false,
      }, { db, ...audit });
      concept_id = c.id;
    }
  }

  // Resolve category. Accepts either `category_key` (strict) or `category`
  // (string label OR object {label, parent_key, ...}). Inline-registers if missing.
  if (!category_id) {
    if (input.category_key) {
      const found = vocabulary.getByKey(input.category_key, { db });
      if (!found) throw new Error(`category_key not in vocabulary: ${input.category_key}`);
      category_id = found.id;
    } else if (input.category) {
      const catSpec = typeof input.category === 'string'
        ? { label: input.category }
        : input.category;
      const c = vocabulary.register({
        type: 'category',
        label: catSpec.label,
        description: catSpec.description,
        scope: catSpec.scope || input.asset || null,
        parent_id: catSpec.parent_id || null,
        auto_registered: catSpec.auto_registered !== false,
      }, { db, ...audit });
      category_id = c.id;
    }
  }

  return { concept_id, category_id };
}

module.exports = {
  create, update, setStatus, remove,
  getById, getByUid, getByIdOrUid,
  list, count,
  VALID_TYPES, VALID_STATUSES,
};

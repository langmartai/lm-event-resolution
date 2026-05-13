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
  // Stash resolver hints to attach to the return value below.
  const vocabHints = { auto_created: resolved.autoCreated, similar_canonical: resolved.similar };

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
    // Attach the resolver's hints so the API can echo them to the caller
    // without leaking into the persisted row.
    Object.defineProperty(created, 'vocab', { value: vocabHints, enumerable: false });
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

// Resolve the optional concept + category refs on an observation. Permissive
// model: unknown concept/category references are auto-registered (auto_registered=true)
// rather than rejected. The background align agent reconciles duplicates later.
//
// Modes:
//   - input.concept_id / category_id   → use as-is (no resolution)
//   - input.concept_key / category_key → resolve through merged_into_id chain; auto-create if missing
//   - input.concept = {label, ...}     → register inline
//   - nothing provided                  → no link, caller is OK with NULL concept_id
//
// Returns: { concept_id, category_id, autoCreated: [{type, key, requested}], similar: [{key, label, score}] }
// The `similar` array hints at high-similarity existing entries so attentive
// sources can re-write to use the canonical key — purely informational.
function resolveVocabRefs(input, audit, db) {
  const vocabulary = require('./vocabulary');
  let concept_id = input.concept_id || null;
  let category_id = input.category_id || null;
  const autoCreated = [];
  const similar = [];

  // Resolve concept
  if (!concept_id) {
    if (input.concept_key) {
      const resolved = vocabulary.resolve(input.concept_key, { db });
      if (resolved) {
        concept_id = resolved.id;
        if (resolved.key !== input.concept_key) {
          // Source asked for a key that redirected — hint at canonical.
          similar.push({ key: resolved.key, label: resolved.label, requested_key: input.concept_key, redirected: true });
        }
      } else {
        // Unknown key — auto-create rather than reject. Derive label from the
        // key's slug portion or fall back to input.name.
        const label = input.concept && input.concept.label
          ? input.concept.label
          : labelFromKey(input.concept_key) || input.name || 'unnamed';
        const created = vocabulary.register({
          type: 'concept', label,
          scope: input.asset || null,
          auto_registered: true,
          key: input.concept_key,  // use the source's key verbatim
        }, { db, ...audit });
        concept_id = created.id;
        autoCreated.push({ type: 'concept', key: created.key, requested: input.concept_key });
        // Suggest possible canonicals for the align agent / source attention
        similar.push(...vocabulary.related(label, { type: 'concept', scope: input.asset || null, limit: 3, db })
          .filter(s => s.key !== created.key).map(s => ({ key: s.key, label: s.label, score: s.score })));
      }
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
      autoCreated.push({ type: 'concept', key: c.key });
      similar.push(...vocabulary.related(c.label, { type: 'concept', scope: input.asset || null, limit: 3, db })
        .filter(s => s.key !== c.key).map(s => ({ key: s.key, label: s.label, score: s.score })));
    }
  }

  // Resolve category — same permissive flow.
  if (!category_id) {
    if (input.category_key) {
      const resolved = vocabulary.resolve(input.category_key, { db });
      if (resolved) {
        category_id = resolved.id;
      } else {
        const label = input.category && (typeof input.category === 'object' ? input.category.label : input.category)
          || labelFromKey(input.category_key) || 'uncategorized';
        const created = vocabulary.register({
          type: 'category', label,
          scope: input.asset || null,
          auto_registered: true,
          key: input.category_key,
        }, { db, ...audit });
        category_id = created.id;
        autoCreated.push({ type: 'category', key: created.key, requested: input.category_key });
      }
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
      autoCreated.push({ type: 'category', key: c.key });
    }
  }

  return { concept_id, category_id, autoCreated, similar };
}

// Best-effort label from a slug-shaped key. "concept:brent-oil:hormuz-blockade"
// → "Hormuz blockade". Used when a source provides a key without an explicit
// label and we need to invent something readable.
function labelFromKey(key) {
  if (!key) return null;
  const tail = String(key).split(':').pop() || '';
  return tail
    .replace(/-+/g, ' ')
    .replace(/^./, c => c.toUpperCase())
    .trim() || null;
}

module.exports = {
  create, update, setStatus, remove,
  getById, getByUid, getByIdOrUid,
  list, count,
  VALID_TYPES, VALID_STATUSES,
};

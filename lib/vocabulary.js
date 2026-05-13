const { open } = require('./db');
const updates = require('./updates');

const VALID_TYPES = new Set(['concept', 'category', 'actor', 'location', 'metric']);
const VALID_STATUSES = new Set(['active', 'merged', 'deprecated']);

function slug(s) {
  return String(s || '').toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

// Build a stable key from (type, scope, label). Auto-derived if the caller
// doesn't supply one. Pure function — same inputs always produce the same key.
function buildKey({ type, scope, label, key }) {
  if (key) return key;
  if (!type || !label) throw new Error('cannot build vocabulary key without type and label');
  const parts = [type];
  if (scope) parts.push(slug(scope));
  parts.push(slug(label));
  return parts.join(':');
}

// Register a new vocabulary entry. Idempotent on (key) — if the entry exists,
// returns it without modification. Use update() or merge() to mutate.
function register(input, opts = {}) {
  const { db = open(), ...audit } = opts;
  validate(input);
  const key = buildKey(input);
  const existing = getByKey(key, { db });
  if (existing) return existing;

  const row = serialize(input, key);
  const stmt = db.prepare(`
    INSERT INTO vocabulary (key, label, description, type, scope, parent_id,
                            aliases_json, auto_registered, status)
    VALUES (@key, @label, @description, @type, @scope, @parent_id,
            @aliases_json, @auto_registered, 'active')
  `);

  const txn = db.transaction(() => {
    const result = stmt.run(row);
    const created = getById(result.lastInsertRowid, { db });
    updates.record(db, {
      entityType: 'vocabulary', entityId: created.id,
      changeType: 'create', before: null, after: created,
      reason: input.reason, ...audit,
    });
    return created;
  });
  return txn();
}

function update(idOrKey, patch, opts = {}) {
  const { db = open(), ...audit } = opts;
  const before = getByIdOrKey(idOrKey, { db });
  if (!before) throw new Error(`vocabulary not found: ${idOrKey}`);
  const merged = { ...before, ...patch };
  if (patch.aliases) merged.aliases_json = JSON.stringify(patch.aliases);
  const stmt = db.prepare(`
    UPDATE vocabulary
      SET label = @label, description = @description, type = @type, scope = @scope,
          parent_id = @parent_id, aliases_json = @aliases_json,
          status = @status, merged_into_id = @merged_into_id,
          auto_registered = @auto_registered,
          reviewed_at = @reviewed_at, reviewed_by_session = @reviewed_by_session,
          updated_at = datetime('now')
    WHERE id = @id
  `);

  const txn = db.transaction(() => {
    stmt.run({
      id: before.id,
      label: merged.label, description: merged.description || null,
      type: merged.type, scope: merged.scope || null,
      parent_id: merged.parent_id || null,
      aliases_json: merged.aliases_json || null,
      status: merged.status, merged_into_id: merged.merged_into_id || null,
      auto_registered: merged.auto_registered ? 1 : 0,
      reviewed_at: merged.reviewed_at || null,
      reviewed_by_session: merged.reviewed_by_session || null,
    });
    const after = getById(before.id, { db });
    updates.record(db, {
      entityType: 'vocabulary', entityId: before.id,
      changeType: patch.status && patch.status !== before.status ? 'status_change' : 'update',
      before, after, reason: patch.reason, ...audit,
    });
    return after;
  });
  return txn();
}

// Merge `loserKey` into `winnerKey`. Loser's status flips to 'merged',
// merged_into_id points to winner. All node observations referencing loser
// get re-pointed to winner.
function merge(winnerKey, loserKey, opts = {}) {
  const { db = open(), ...audit } = opts;
  const winner = getByKey(winnerKey, { db });
  const loser = getByKey(loserKey, { db });
  if (!winner) throw new Error(`winner not found: ${winnerKey}`);
  if (!loser) throw new Error(`loser not found: ${loserKey}`);
  if (winner.id === loser.id) throw new Error('cannot merge a vocabulary entry into itself');

  const txn = db.transaction(() => {
    // Move concept references
    db.prepare(`UPDATE nodes SET concept_id = ? WHERE concept_id = ?`)
      .run(winner.id, loser.id);
    db.prepare(`UPDATE nodes SET category_id = ? WHERE category_id = ?`)
      .run(winner.id, loser.id);
    // Move parent references (other vocab entries that had loser as parent)
    db.prepare(`UPDATE vocabulary SET parent_id = ? WHERE parent_id = ?`)
      .run(winner.id, loser.id);

    // Mark loser as merged
    const updated = update(loser.id, {
      status: 'merged', merged_into_id: winner.id,
      reason: opts.reason || `merged into ${winner.key}`,
    }, { db, ...audit });
    return { winner: getById(winner.id, { db }), loser: updated };
  });
  return txn();
}

function recategorize(key, newParentKey, opts = {}) {
  const { db = open(), ...audit } = opts;
  const entry = getByKey(key, { db });
  if (!entry) throw new Error(`vocabulary not found: ${key}`);
  let parent_id = null;
  if (newParentKey) {
    const parent = getByKey(newParentKey, { db });
    if (!parent) throw new Error(`parent not found: ${newParentKey}`);
    parent_id = parent.id;
  }
  return update(entry.id, { parent_id, reason: opts.reason || `recategorized under ${newParentKey || 'root'}` },
    { db, ...audit });
}

function markReviewed(key, opts = {}) {
  const { db = open(), ...audit } = opts;
  return update(key, {
    reviewed_at: new Date().toISOString(),
    reviewed_by_session: audit.sessionId,
    reason: opts.reason || 'human reviewed',
  }, { db, ...audit });
}

function deprecate(key, opts = {}) {
  const { db = open(), ...audit } = opts;
  return update(key, { status: 'deprecated', reason: opts.reason || 'deprecated' }, { db, ...audit });
}

// Detach a node from its current concept into its OWN new concept. Recovery
// path when the align agent mis-merged two entries that should have stayed
// separate. The node keeps its observations and history; a fresh concept is
// registered just for it.
function split(nodeUid, opts = {}) {
  const { db = open(), newLabel, newKey, ...audit } = opts;
  const node = db.prepare(`SELECT id, uid, type, name, asset, concept_id, category_id FROM nodes WHERE uid = ?`).get(nodeUid);
  if (!node) throw new Error(`node not found: ${nodeUid}`);
  if (!node.concept_id) throw new Error(`node ${nodeUid} has no concept to split from`);
  const oldConcept = getById(node.concept_id, { db });

  // Register a new concept dedicated to this node.
  const label = newLabel || node.name || 'split concept';
  const fresh = register({
    type: 'concept',
    label,
    scope: node.asset || (oldConcept ? oldConcept.scope : null),
    description: `Split from ${oldConcept ? oldConcept.key : 'unknown'} by manual recovery.`,
    auto_registered: false,  // human-initiated, doesn't need review
    key: newKey,
  }, { db, ...audit });

  // Re-point this single node to the new concept.
  const nodesLib = require('./nodes');
  nodesLib.update(node.id, { concept_id: fresh.id }, { db, reason: `split from ${oldConcept ? oldConcept.key : 'unknown'}`, ...audit });
  return { node: nodeUid, old_concept: oldConcept && oldConcept.key, new_concept: fresh.key };
}

function addAlias(key, alias, opts = {}) {
  const { db = open(), ...audit } = opts;
  const entry = getByKey(key, { db });
  if (!entry) throw new Error(`vocabulary not found: ${key}`);
  const aliases = entry.aliases_json ? JSON.parse(entry.aliases_json) : [];
  if (aliases.includes(alias)) return entry;
  aliases.push(alias);
  return update(entry.id, { aliases_json: JSON.stringify(aliases), aliases, reason: `add alias: ${alias}` },
    { db, ...audit });
}

// ============================================================
// Reads
// ============================================================
function getById(id, { db = open() } = {}) {
  const row = db.prepare(`SELECT * FROM vocabulary WHERE id = ?`).get(id);
  return row ? parse(row) : null;
}
function getByKey(key, { db = open() } = {}) {
  const row = db.prepare(`SELECT * FROM vocabulary WHERE key = ?`).get(key);
  return row ? parse(row) : null;
}
function getByIdOrKey(idOrKey, opts = {}) {
  if (typeof idOrKey === 'number') return getById(idOrKey, opts);
  if (typeof idOrKey === 'string' && /^\d+$/.test(idOrKey)) return getById(Number(idOrKey), opts);
  return getByKey(String(idOrKey), opts);
}

// Resolve a key (or id) to its canonical entry by following merged_into_id.
// Returns null if the entry doesn't exist. Returns the entry as-is if it isn't
// merged. Loops are detected and broken (a self-referencing chain returns the
// last node visited, with a `circular: true` flag).
function resolve(keyOrId, { db = open() } = {}) {
  let entry = getByIdOrKey(keyOrId, { db });
  if (!entry) return null;
  const seen = new Set([entry.id]);
  let hops = 0;
  while (entry.status === 'merged' && entry.merged_into_id) {
    if (seen.has(entry.merged_into_id) || hops > 10) {
      return { ...entry, circular: true };
    }
    const next = getById(entry.merged_into_id, { db });
    if (!next) break;
    seen.add(next.id);
    entry = next;
    hops++;
  }
  return entry;
}

function list({ type, scope, parentKey, status = 'active', limit = 200, offset = 0, db = open() } = {}) {
  const where = [];
  const params = { limit, offset };
  if (type)   { where.push('type = @type');   params.type = type; }
  if (scope)  { where.push('scope = @scope'); params.scope = scope; }
  if (status) { where.push('status = @status'); params.status = status; }
  if (parentKey) {
    const p = getByKey(parentKey, { db });
    if (p) { where.push('parent_id = @parent_id'); params.parent_id = p.id; }
  }
  const sql = `
    SELECT * FROM vocabulary ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY label LIMIT @limit OFFSET @offset
  `;
  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM vocabulary ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`
  ).get(params).n;
  const items = db.prepare(sql).all(params).map(parse);
  return { total, count: items.length, offset, limit, items };
}

// FTS-backed similarity search. Used by sources before writing — they call
// /api/vocabulary/related?text=... and get the existing matches.
function related(text, { type, scope, limit = 10, db = open() } = {}) {
  if (!text || !text.trim()) return [];
  const tokens = String(text).split(/\s+/)
    .map(t => t.replace(/[^\w\d]/g, ''))
    .filter(t => t.length > 1);
  if (!tokens.length) return [];
  const q = tokens.map(t => `${t}*`).join(' OR ');

  const filters = ['v.status = \'active\''];
  const params = { q, limit };
  if (type)  { filters.push('v.type = @type');  params.type = type; }
  if (scope) { filters.push('(v.scope = @scope OR v.scope IS NULL)'); params.scope = scope; }

  return db.prepare(`
    SELECT v.*, bm25(vocabulary_fts) AS score,
           snippet(vocabulary_fts, 0, '<mark>', '</mark>', '...', 16) AS snippet
    FROM vocabulary_fts JOIN vocabulary v ON v.id = vocabulary_fts.rowid
    WHERE vocabulary_fts MATCH @q AND ${filters.join(' AND ')}
    ORDER BY score LIMIT @limit
  `).all(params).map(parse);
}

function children(parentKey, { db = open() } = {}) {
  const parent = getByKey(parentKey, { db });
  if (!parent) return [];
  return db.prepare(`SELECT * FROM vocabulary WHERE parent_id = ? AND status = 'active' ORDER BY type, label`)
    .all(parent.id).map(parse);
}

function tree({ root, db = open() } = {}) {
  // Build a nested tree starting from `root` (or all top-level entries).
  const rootEntry = root ? getByKey(root, { db }) : null;
  const rootId = rootEntry ? rootEntry.id : null;
  const all = db.prepare(`SELECT * FROM vocabulary WHERE status = 'active'`).all().map(parse);
  const byParent = new Map();
  for (const v of all) {
    const key = v.parent_id == null ? 'null' : String(v.parent_id);
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(v);
  }
  function build(id) {
    const kids = byParent.get(id == null ? 'null' : String(id)) || [];
    return kids.map(k => ({ ...k, children: build(k.id) }));
  }
  return rootId ? build(rootId) : build(null);
}

// Pending review queue — auto_registered entries that haven't been touched
// by a human. Drives the Organizer tab.
function pendingReview({ type, limit = 100, db = open() } = {}) {
  const filters = ['auto_registered = 1', 'reviewed_at IS NULL', 'status = \'active\''];
  const params = { limit };
  if (type) { filters.push('type = @type'); params.type = type; }
  return db.prepare(`
    SELECT v.*, (SELECT COUNT(*) FROM nodes n WHERE n.concept_id = v.id) AS observation_count
    FROM vocabulary v WHERE ${filters.join(' AND ')}
    ORDER BY v.created_at DESC LIMIT @limit
  `).all(params).map(parse);
}

// Cheap heuristic merge suggestions for the organizer agent — pairs of active
// concepts in the same scope+type whose labels share a token. The agent does
// the smart decision, this just narrows the search space.
function mergeSuggestions({ type = 'concept', limit = 50, db = open() } = {}) {
  // Self-join on normalised first token of label, same scope+type.
  return db.prepare(`
    SELECT a.key AS a_key, a.label AS a_label, a.scope AS a_scope,
           b.key AS b_key, b.label AS b_label,
           a.id AS a_id, b.id AS b_id
    FROM vocabulary a
    JOIN vocabulary b
      ON a.scope IS b.scope
     AND a.type = b.type
     AND a.id < b.id
     AND a.status = 'active' AND b.status = 'active'
     AND LENGTH(a.label) > 4 AND LENGTH(b.label) > 4
     AND (
       LOWER(SUBSTR(a.label, 1, 12)) = LOWER(SUBSTR(b.label, 1, 12))
       OR INSTR(LOWER(b.label), LOWER(a.label)) > 0
       OR INSTR(LOWER(a.label), LOWER(b.label)) > 0
     )
    WHERE a.type = ? LIMIT ?
  `).all(type, limit);
}

// ============================================================
function parse(row) {
  return {
    ...row,
    aliases: row.aliases_json ? JSON.parse(row.aliases_json) : [],
    auto_registered: !!row.auto_registered,
  };
}

function validate(input) {
  if (!input.label) throw new Error('label is required');
  if (!input.type) throw new Error('type is required');
  if (!VALID_TYPES.has(input.type)) {
    throw new Error(`invalid vocabulary type: ${input.type}. Must be one of: ${[...VALID_TYPES].join(', ')}`);
  }
}

function serialize(input, key) {
  return {
    key,
    label: input.label,
    description: input.description || null,
    type: input.type,
    scope: input.scope || null,
    parent_id: input.parent_id || null,
    aliases_json: input.aliases ? JSON.stringify(input.aliases) : null,
    auto_registered: input.auto_registered ? 1 : 0,
  };
}

module.exports = {
  register, update, merge, recategorize, markReviewed, deprecate, addAlias, split,
  getById, getByKey, getByIdOrKey, resolve,
  list, related, children, tree, pendingReview, mergeSuggestions,
  buildKey, slug,
  VALID_TYPES, VALID_STATUSES,
};

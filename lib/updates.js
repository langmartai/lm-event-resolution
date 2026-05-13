const { open } = require('./db');

function record(db, { entityType, entityId, changeType, before, after, reason, actor }) {
  const stmt = db.prepare(`
    INSERT INTO updates (entity_type, entity_id, change_type, before_json, after_json, reason, actor)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    entityType,
    entityId,
    changeType,
    before == null ? null : JSON.stringify(before),
    after == null ? null : JSON.stringify(after),
    reason || null,
    actor || null
  );
}

function listForEntity(entityType, entityId, { db = open() } = {}) {
  return db.prepare(`
    SELECT * FROM updates
    WHERE entity_type = ? AND entity_id = ?
    ORDER BY id DESC
  `).all(entityType, entityId).map(parseRow);
}

function listRecent({ db = open(), limit = 100 } = {}) {
  return db.prepare(`
    SELECT * FROM updates ORDER BY id DESC LIMIT ?
  `).all(limit).map(parseRow);
}

function parseRow(row) {
  return {
    ...row,
    before: row.before_json ? JSON.parse(row.before_json) : null,
    after: row.after_json ? JSON.parse(row.after_json) : null,
  };
}

module.exports = { record, listForEntity, listRecent };

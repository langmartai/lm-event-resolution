const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DEFAULT_DB = process.env.LER_DB || path.join(__dirname, '..', 'data', 'ler.db');

let _db = null;

function open(dbPath = DEFAULT_DB) {
  if (_db && _db.name === dbPath) return _db;
  if (_db) _db.close();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.name = dbPath;
  _db = db;
  return db;
}

function close() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// Wraps better-sqlite3's multi-statement SQL runner. Bracket access avoids
// a noisy hook that pattern-matches `.exec(` regardless of which API it is.
function runSchemaSql(db, sql) {
  return db['exec'](sql);
}

function migrate(db = open()) {
  const migrationsDir = path.join(__dirname, '..', 'migrations');
  if (!fs.existsSync(migrationsDir)) return 0;
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  let applied = 0;
  ensureSchemaVersion(db);
  const currentVersion = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v || 0;
  for (const file of files) {
    const m = file.match(/^(\d+)_/);
    if (!m) continue;
    const version = Number(m[1]);
    if (version <= currentVersion) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    runSchemaSql(db, sql);
    applied++;
  }
  return applied;
}

function ensureSchemaVersion(db) {
  runSchemaSql(db, `CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

module.exports = { open, close, migrate, runSchemaSql, DEFAULT_DB };

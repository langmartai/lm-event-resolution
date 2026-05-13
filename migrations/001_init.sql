-- lm-event-resolution — initial schema
-- A generic typed-graph of events, sub-factors, resolution drivers, monitors, scenarios.
-- Every mutation lands in `updates` for audit trail.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- nodes: typed entities (the vertices of the graph)
-- ============================================================
CREATE TABLE IF NOT EXISTS nodes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uid         TEXT UNIQUE NOT NULL,          -- stable external ID (e.g. brent-oil:2026-05-13:sub:hormuz-blockade-1)
  type        TEXT NOT NULL,                 -- event | factor | sub_factor | driver | monitor | scenario | outcome
  name        TEXT NOT NULL,
  asset       TEXT,                          -- optional: asset slug (e.g. brent-oil)
  body_md     TEXT,                          -- free-form markdown body
  status      TEXT NOT NULL DEFAULT 'active',-- active | invalidated | superseded | resolved | projected | confirmed | registered
  certainty   TEXT,                          -- L1 | L2 | L3 | L4 | L5 (predictive_certainty when applicable)
  significance TEXT,                         -- high | medium | low
  direction   TEXT,                          -- bullish | bearish | neutral
  magnitude   TEXT,                          -- major | moderate | minor
  temporal    TEXT,                          -- past | present | future
  props_json  TEXT,                          -- arbitrary additional props as JSON
  valid_from  TEXT,                          -- ISO date — temporal validity start
  valid_to    TEXT,                          -- ISO date — temporal validity end
  occurred_at TEXT,                          -- ISO datetime — when an event actually happened
  eta_date    TEXT,                          -- ISO date — expected resolution date for projections/scenarios
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_asset ON nodes(asset);
CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);
CREATE INDEX IF NOT EXISTS idx_nodes_valid_to ON nodes(valid_to);
CREATE INDEX IF NOT EXISTS idx_nodes_eta_date ON nodes(eta_date);
CREATE INDEX IF NOT EXISTS idx_nodes_occurred_at ON nodes(occurred_at);

-- ============================================================
-- edges: typed relationships
-- src_id -> dst_id with type
-- ============================================================
CREATE TABLE IF NOT EXISTS edges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  src_id      INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  dst_id      INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,                 -- derives_from | supports | contradicts | supersedes | gates | resolves_to | monitors | parent_of | projects_to | causes | depends_on
  weight      REAL,                          -- optional: probability (0-1), influence weight (%), correlation
  props_json  TEXT,                          -- arbitrary props (evidence, basis, label)
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(src_id, dst_id, type)
);

CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_id);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_id);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);

-- ============================================================
-- sources: citations / evidence origins
-- ============================================================
CREATE TABLE IF NOT EXISTS sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  citation    TEXT NOT NULL,                 -- "Bloomberg/CNBC May 11"
  url         TEXT,
  source_type TEXT,                          -- news | official | agency | llm-search | api | analyst
  trust_level INTEGER,                       -- 1-5 (5 highest)
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(citation, url)
);

CREATE INDEX IF NOT EXISTS idx_sources_type ON sources(source_type);

-- ============================================================
-- node_sources: many-to-many between nodes and sources
-- ============================================================
CREATE TABLE IF NOT EXISTS node_sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  source_id   INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  evidence    TEXT,                          -- specific quote / claim attributed to the source
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(node_id, source_id, evidence)
);

CREATE INDEX IF NOT EXISTS idx_node_sources_node ON node_sources(node_id);
CREATE INDEX IF NOT EXISTS idx_node_sources_source ON node_sources(source_id);

-- ============================================================
-- updates: append-only audit log
-- Every mutation writes a row here. before_json + after_json give full diff.
-- ============================================================
CREATE TABLE IF NOT EXISTS updates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,                 -- node | edge | source | node_source
  entity_id   INTEGER NOT NULL,
  change_type TEXT NOT NULL,                 -- create | update | status_change | delete | link | unlink
  before_json TEXT,
  after_json  TEXT,
  reason      TEXT,                          -- why the change was made
  actor       TEXT,                          -- who/what made the change (cli | api:user | importer | llm)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_updates_entity ON updates(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_updates_created ON updates(created_at);

-- ============================================================
-- tags: flexible labelling
-- ============================================================
CREATE TABLE IF NOT EXISTS tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  tag         TEXT NOT NULL,
  UNIQUE(node_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);

-- ============================================================
-- nodes_fts: full-text search over nodes (FTS5)
-- Indexed columns: name, body_md, asset, type
-- Kept in sync by triggers below.
-- ============================================================
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  name,
  body_md,
  asset,
  type,
  uid UNINDEXED,
  content='nodes',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, name, body_md, asset, type, uid)
  VALUES (new.id, new.name, new.body_md, new.asset, new.type, new.uid);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, body_md, asset, type, uid)
  VALUES ('delete', old.id, old.name, old.body_md, old.asset, old.type, old.uid);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, body_md, asset, type, uid)
  VALUES ('delete', old.id, old.name, old.body_md, old.asset, old.type, old.uid);
  INSERT INTO nodes_fts(rowid, name, body_md, asset, type, uid)
  VALUES (new.id, new.name, new.body_md, new.asset, new.type, new.uid);
END;

-- ============================================================
-- schema_version: track migrations applied
-- ============================================================
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO schema_version (version) VALUES (1);

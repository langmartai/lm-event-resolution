-- Controlled vocabulary + TOC + observation FKs.
-- See docs/agents/bootstrap.md for how the migration of existing rows runs.
--
-- Design summary:
--   * vocabulary is one table holding both CONCEPTS (the things observations refer to)
--     and CATEGORIES (the TOC scopes that group concepts). type column distinguishes.
--   * parent_id forms the TOC hierarchy. A category's parent is a broader category.
--     A concept's parent is the category it lives in.
--   * status='merged' + merged_into_id implements consolidation without losing audit.
--   * nodes gain optional concept_id + category_id FKs. They're nullable so existing
--     rows still work; the bootstrap agent populates them.
--   * updates gains parent_session_id for child-of-CLI agent lineage.

CREATE TABLE IF NOT EXISTS vocabulary (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  key             TEXT UNIQUE NOT NULL,
  label           TEXT NOT NULL,
  description     TEXT,
  type            TEXT NOT NULL,                -- concept | category | actor | location | metric
  scope           TEXT,                          -- asset slug, or NULL for global
  parent_id       INTEGER REFERENCES vocabulary(id),
  status          TEXT NOT NULL DEFAULT 'active', -- active | merged | deprecated
  merged_into_id  INTEGER REFERENCES vocabulary(id),
  aliases_json    TEXT,                          -- JSON array of alternate names
  auto_registered INTEGER NOT NULL DEFAULT 0,
  reviewed_at     TEXT,
  reviewed_by_session TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_vocab_key ON vocabulary(key);
CREATE INDEX IF NOT EXISTS idx_vocab_parent ON vocabulary(parent_id);
CREATE INDEX IF NOT EXISTS idx_vocab_type ON vocabulary(type);
CREATE INDEX IF NOT EXISTS idx_vocab_scope ON vocabulary(scope);
CREATE INDEX IF NOT EXISTS idx_vocab_status ON vocabulary(status);
CREATE INDEX IF NOT EXISTS idx_vocab_auto ON vocabulary(auto_registered, reviewed_at);

-- FTS over labels + aliases + description so the "related" endpoint can return
-- good suggestions before a source writes. Standalone (not external-content)
-- so the column names don't have to match the base table and snippet() works
-- without an INSTEAD OF projection.
CREATE VIRTUAL TABLE IF NOT EXISTS vocabulary_fts USING fts5(
  label,
  description,
  aliases,
  key UNINDEXED,
  type UNINDEXED,
  scope UNINDEXED,
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS vocabulary_ai AFTER INSERT ON vocabulary BEGIN
  INSERT INTO vocabulary_fts(rowid, label, description, aliases, key, type, scope)
  VALUES (new.id, new.label, COALESCE(new.description, ''), COALESCE(new.aliases_json, ''),
          new.key, new.type, COALESCE(new.scope, ''));
END;
CREATE TRIGGER IF NOT EXISTS vocabulary_ad AFTER DELETE ON vocabulary BEGIN
  DELETE FROM vocabulary_fts WHERE rowid = old.id;
END;
CREATE TRIGGER IF NOT EXISTS vocabulary_au AFTER UPDATE ON vocabulary BEGIN
  DELETE FROM vocabulary_fts WHERE rowid = old.id;
  INSERT INTO vocabulary_fts(rowid, label, description, aliases, key, type, scope)
  VALUES (new.id, new.label, COALESCE(new.description, ''), COALESCE(new.aliases_json, ''),
          new.key, new.type, COALESCE(new.scope, ''));
END;

-- Observations now optionally point to a concept + category.
ALTER TABLE nodes ADD COLUMN concept_id  INTEGER REFERENCES vocabulary(id);
ALTER TABLE nodes ADD COLUMN category_id INTEGER REFERENCES vocabulary(id);
CREATE INDEX IF NOT EXISTS idx_nodes_concept ON nodes(concept_id);
CREATE INDEX IF NOT EXISTS idx_nodes_category ON nodes(category_id);

-- Session lineage on audit log — when a CLI command spawns an agent, the
-- agent's mutations carry parent_session_id pointing back to the triggering session.
ALTER TABLE updates ADD COLUMN parent_session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_updates_parent_session ON updates(parent_session_id);

INSERT OR IGNORE INTO schema_version (version) VALUES (5);

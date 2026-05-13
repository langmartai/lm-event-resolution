-- Expand full-text search coverage beyond name + body.
-- search_text is a flattened column on `nodes` populated by lib/nodes.js
-- on every write. It contains:
--   - props_json values (factor name, evidence, causal_history, projection_basis,
--     credibility_type, quantified_impact, resolution_window, signal_meaning, ...)
--   - certainty, status, direction, magnitude, significance, temporal
--   - asset (also indexed separately for filtering)
-- Source citations + node_source.evidence are not denormalised — they get
-- searched via separate channels (sources are joined on demand).

ALTER TABLE nodes ADD COLUMN search_text TEXT;

-- Recreate the FTS5 virtual table to index the new column. Drop triggers
-- first so they don't reference the old shape, then drop+recreate the
-- table, then recreate triggers that keep both columns in sync.
DROP TRIGGER IF EXISTS nodes_ai;
DROP TRIGGER IF EXISTS nodes_ad;
DROP TRIGGER IF EXISTS nodes_au;
DROP TABLE IF EXISTS nodes_fts;

CREATE VIRTUAL TABLE nodes_fts USING fts5(
  name,
  body_md,
  search_text,
  asset,
  type,
  status,
  certainty,
  uid UNINDEXED,
  content='nodes',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- Backfill from existing rows. (search_text is null at this point — the
-- lib will fill it on next write; for now the FTS still has name+body_md
-- which is sufficient.)
INSERT INTO nodes_fts(rowid, name, body_md, search_text, asset, type, status, certainty, uid)
SELECT id, name, body_md, search_text, asset, type, status, certainty, uid FROM nodes;

CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, name, body_md, search_text, asset, type, status, certainty, uid)
  VALUES (new.id, new.name, new.body_md, new.search_text, new.asset, new.type, new.status, new.certainty, new.uid);
END;

CREATE TRIGGER nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, body_md, search_text, asset, type, status, certainty, uid)
  VALUES ('delete', old.id, old.name, old.body_md, old.search_text, old.asset, old.type, old.status, old.certainty, old.uid);
END;

CREATE TRIGGER nodes_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, body_md, search_text, asset, type, status, certainty, uid)
  VALUES ('delete', old.id, old.name, old.body_md, old.search_text, old.asset, old.type, old.status, old.certainty, old.uid);
  INSERT INTO nodes_fts(rowid, name, body_md, search_text, asset, type, status, certainty, uid)
  VALUES (new.id, new.name, new.body_md, new.search_text, new.asset, new.type, new.status, new.certainty, new.uid);
END;

INSERT OR IGNORE INTO schema_version (version) VALUES (3);

-- Track the INTENT of every mutation — why the session is doing this action.
-- session_id answers "who" (the originating Claude Code session) and is
-- mandatory; intent answers "why" (the higher-level purpose) and is optional
-- but strongly encouraged. Examples:
--   intent='trade-monitor brent-oil refresh'
--   intent='nightly fundamental analysis import'
--   intent='resolve RD1 — Iran ceasefire collapsed'
--   intent='manual cleanup of stale monitors'

ALTER TABLE updates ADD COLUMN intent TEXT;

CREATE INDEX IF NOT EXISTS idx_updates_intent ON updates(intent);

INSERT OR IGNORE INTO schema_version (version) VALUES (4);

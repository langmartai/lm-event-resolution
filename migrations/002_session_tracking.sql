-- Track which Claude Code session (or other identifiable caller) made each change.
-- Sessions are identified by string IDs (e.g. lm-assist exec IDs `exec-...`,
-- Claude Code session IDs, or anything the caller provides in the
-- X-Claude-Session-Id header). project_path identifies the cwd of the agent,
-- tool_use_id can be passed to correlate with a specific tool invocation.

ALTER TABLE updates ADD COLUMN session_id    TEXT;
ALTER TABLE updates ADD COLUMN project_path  TEXT;
ALTER TABLE updates ADD COLUMN tool_use_id   TEXT;

CREATE INDEX IF NOT EXISTS idx_updates_session_id ON updates(session_id);
CREATE INDEX IF NOT EXISTS idx_updates_project ON updates(project_path);

INSERT OR IGNORE INTO schema_version (version) VALUES (2);

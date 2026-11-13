//! Durable metadata beside the rebuildable page index. These tables deliberately
//! have no foreign keys to pages: rebuilding, moving or deleting pages must not
//! erase usage history. Deleting the index database itself does erase history.

pub(crate) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS mcp_sessions (
    session_id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    client_version TEXT NOT NULL,
    agent_label TEXT,
    first_seen TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_first_seen ON mcp_sessions(first_seen);
CREATE TABLE IF NOT EXISTS mcp_tools (
    name TEXT PRIMARY KEY,
    read_only INTEGER NOT NULL CHECK (read_only IN (0, 1))
);
CREATE TABLE IF NOT EXISTS mcp_calls (
    call_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES mcp_sessions(session_id),
    tool TEXT NOT NULL,
    client_name TEXT NOT NULL,
    client_version TEXT NOT NULL,
    agent_label TEXT,
    started_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
    outcome TEXT NOT NULL CHECK (outcome IN ('success', 'tool_error', 'protocol_error', 'cancelled')),
    error_code INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mcp_calls_started ON mcp_calls(started_at, call_id);
CREATE INDEX IF NOT EXISTS idx_mcp_calls_tool_started ON mcp_calls(tool, started_at);
CREATE TABLE IF NOT EXISTS mcp_call_pages (
    call_id TEXT NOT NULL REFERENCES mcp_calls(call_id) ON DELETE CASCADE,
    identity TEXT NOT NULL,
    page_id TEXT,
    path TEXT,
    source TEXT NOT NULL CHECK (source IN ('target', 'result')),
    PRIMARY KEY (call_id, identity, source)
);
CREATE INDEX IF NOT EXISTS idx_mcp_call_pages_identity ON mcp_call_pages(identity, call_id);
"#;

-- SQLite 스키마 — soul-server 로컬 모드용
-- PostgreSQL schema.sql의 SQLite 대응 버전

-- sessions 테이블
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    folder_id TEXT,
    display_name TEXT,
    node_id TEXT,
    session_type TEXT,
    status TEXT,
    prompt TEXT,
    client_id TEXT,
    claude_session_id TEXT,
    agent_id TEXT,
    last_message TEXT,                   -- JSONB → TEXT (json.dumps)
    metadata TEXT,                       -- JSONB → TEXT (json.dumps)
    was_running_at_shutdown INTEGER DEFAULT 0,  -- BOOLEAN → INTEGER (0/1)
    last_event_id INTEGER,
    last_read_event_id INTEGER,
    created_at TEXT,                     -- TIMESTAMPTZ → TEXT (ISO 8601)
    updated_at TEXT
);

-- events 테이블
CREATE TABLE IF NOT EXISTS events (
    session_id TEXT NOT NULL,
    id INTEGER NOT NULL,
    event_type TEXT,
    payload TEXT,                        -- JSONB → TEXT (json.dumps)
    searchable_text TEXT,
    created_at TEXT,                     -- TIMESTAMPTZ → TEXT (ISO 8601)
    PRIMARY KEY (session_id, id)
);

-- folders 테이블
CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    name TEXT,
    sort_order INTEGER DEFAULT 0
);


-- events_fts: 독립 FTS5 가상 테이블
-- session_id + event_id를 함께 저장하여 검색 후 events 테이블 역참조에 사용
-- content table 방식 미사용 — rowid 매핑 복잡성 회피
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
    searchable_text,
    session_id UNINDEXED,
    event_id UNINDEXED
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_events_session_id_id ON events (session_id, id);
CREATE INDEX IF NOT EXISTS idx_sessions_node_id ON sessions (node_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions (updated_at DESC);

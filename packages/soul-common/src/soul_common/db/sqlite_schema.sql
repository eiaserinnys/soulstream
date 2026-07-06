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
    updated_at TEXT,
    caller_session_id TEXT               -- 에이전트 세션 발신자 ID (완료 보고용)
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
    sort_order INTEGER DEFAULT 0,
    parent_folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS markdown_documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS file_assets (
    id TEXT PRIMARY KEY,
    storage_key TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    width INTEGER,
    height INTEGER,
    duration_seconds REAL,
    checksum_sha256 TEXT,
    upload_status TEXT NOT NULL DEFAULT 'pending' CHECK (upload_status IN ('pending', 'committed')),
    multipart_upload_id TEXT,
    garbage_collected_at TEXT,
    created_at TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS board_items (
    id TEXT PRIMARY KEY,
    folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    container_kind TEXT NOT NULL DEFAULT 'folder' CHECK (container_kind IN ('folder', 'runbook')),
    container_id TEXT NOT NULL DEFAULT '',
    membership_kind TEXT NOT NULL DEFAULT 'primary' CHECK (membership_kind IN ('primary', 'reference')),
    source_runbook_item_id TEXT,
    item_type TEXT NOT NULL CHECK (item_type IN ('session', 'markdown', 'subfolder', 'asset', 'frame', 'runbook', 'custom_view')),
    item_id TEXT NOT NULL,
    x REAL NOT NULL DEFAULT 0,
    y REAL NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT,
    updated_at TEXT,
    UNIQUE (folder_id, item_id)
);

CREATE TABLE IF NOT EXISTS board_custom_views (
    id TEXT PRIMARY KEY,
    board_item_id TEXT NOT NULL UNIQUE REFERENCES board_items(id) ON DELETE CASCADE,
    title TEXT,
    html TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1,
    archived INTEGER NOT NULL DEFAULT 0,
    created_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    created_event_id INTEGER,
    updated_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    updated_event_id INTEGER,
    created_at TEXT,
    updated_at TEXT,
    FOREIGN KEY (created_session_id, created_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL,
    FOREIGN KEY (updated_session_id, updated_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_board_items_folder ON board_items (folder_id, y, x);
CREATE INDEX IF NOT EXISTS idx_board_items_container ON board_items (container_kind, container_id, y, x);
CREATE INDEX IF NOT EXISTS idx_board_items_ref ON board_items (item_type, item_id);

CREATE TRIGGER IF NOT EXISTS board_delete_folder_refs
AFTER DELETE ON folders
BEGIN
    DELETE FROM board_items WHERE item_type = 'subfolder' AND item_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS board_delete_session_refs
AFTER DELETE ON sessions
BEGIN
    DELETE FROM board_items WHERE item_type = 'session' AND item_id = OLD.session_id;
END;

CREATE TRIGGER IF NOT EXISTS board_delete_markdown_refs
AFTER DELETE ON markdown_documents
BEGIN
    DELETE FROM board_items WHERE item_type = 'markdown' AND item_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS board_delete_asset_refs
AFTER DELETE ON file_assets
BEGIN
    DELETE FROM board_items WHERE item_type = 'asset' AND item_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS board_delete_custom_view_refs
AFTER DELETE ON board_custom_views
BEGIN
    DELETE FROM board_items WHERE item_type = 'custom_view' AND item_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS folders_prevent_cycle_insert
BEFORE INSERT ON folders
WHEN NEW.parent_folder_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'folder parent cycle')
    WHERE NEW.parent_folder_id = NEW.id;

    WITH RECURSIVE ancestors(id, parent_folder_id) AS (
        SELECT id, parent_folder_id FROM folders WHERE id = NEW.parent_folder_id
        UNION ALL
        SELECT f.id, f.parent_folder_id
        FROM folders f
        JOIN ancestors a ON f.id = a.parent_folder_id
    )
    SELECT RAISE(ABORT, 'folder parent cycle')
    WHERE EXISTS (SELECT 1 FROM ancestors WHERE id = NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS folders_prevent_cycle_update
BEFORE UPDATE OF parent_folder_id ON folders
WHEN NEW.parent_folder_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'folder parent cycle')
    WHERE NEW.parent_folder_id = NEW.id;

    WITH RECURSIVE ancestors(id, parent_folder_id) AS (
        SELECT id, parent_folder_id FROM folders WHERE id = NEW.parent_folder_id
        UNION ALL
        SELECT f.id, f.parent_folder_id
        FROM folders f
        JOIN ancestors a ON f.id = a.parent_folder_id
    )
    SELECT RAISE(ABORT, 'folder parent cycle')
    WHERE EXISTS (SELECT 1 FROM ancestors WHERE id = NEW.id);
END;

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
CREATE INDEX IF NOT EXISTS idx_folders_parent_folder_id ON folders (parent_folder_id);

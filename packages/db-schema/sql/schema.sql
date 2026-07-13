-- schema.sql — DDL 정본 파일
-- 모든 테이블, 인덱스, 트리거, 함수를 멱등하게 정의한다.
-- CREATE OR REPLACE / IF NOT EXISTS로 반복 실행 가능.

-- ============================================================
-- 1. 테이블
-- ============================================================

CREATE TABLE IF NOT EXISTS folders (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    parent_folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 기존 테이블에 settings 컬럼 추가 (멱등)
ALTER TABLE folders ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}';
-- 기존 테이블에 created_at 컬럼 추가 (멱등)
ALTER TABLE folders ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
-- 기존 테이블에 parent_folder_id 컬럼 추가 (멱등)
ALTER TABLE folders ADD COLUMN IF NOT EXISTS parent_folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_folders_parent_folder_id ON folders(parent_folder_id);

CREATE OR REPLACE FUNCTION folders_prevent_cycle()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    has_cycle BOOLEAN;
BEGIN
    IF NEW.parent_folder_id IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.parent_folder_id = NEW.id THEN
        RAISE EXCEPTION 'folder parent cycle';
    END IF;

    WITH RECURSIVE ancestors(id, parent_folder_id) AS (
        SELECT f.id, f.parent_folder_id
        FROM folders f
        WHERE f.id = NEW.parent_folder_id
        UNION ALL
        SELECT f.id, f.parent_folder_id
        FROM folders f
        JOIN ancestors a ON f.id = a.parent_folder_id
    )
    SELECT EXISTS(SELECT 1 FROM ancestors WHERE id = NEW.id) INTO has_cycle;

    IF has_cycle THEN
        RAISE EXCEPTION 'folder parent cycle';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS folders_prevent_cycle_trigger ON folders;
CREATE TRIGGER folders_prevent_cycle_trigger
BEFORE INSERT OR UPDATE OF parent_folder_id ON folders
FOR EACH ROW EXECUTE FUNCTION folders_prevent_cycle();

CREATE OR REPLACE FUNCTION board_delete_folder_refs()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM board_items WHERE item_type = 'subfolder' AND item_id = OLD.id;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS board_delete_folder_refs_trigger ON folders;
CREATE TRIGGER board_delete_folder_refs_trigger
AFTER DELETE ON folders
FOR EACH ROW EXECUTE FUNCTION board_delete_folder_refs();

CREATE TABLE IF NOT EXISTS sessions (
    session_id              TEXT PRIMARY KEY,
    folder_id               TEXT REFERENCES folders(id),
    display_name            TEXT,
    node_id                 TEXT,
    session_type            TEXT,
    status                  TEXT,
    prompt                  TEXT,
    client_id               TEXT,
    claude_session_id       TEXT,
    last_message            JSONB,
    metadata                JSONB,
    was_running_at_shutdown BOOLEAN DEFAULT FALSE,
    last_event_id           INTEGER,
    last_read_event_id      INTEGER,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW(),
    agent_id                VARCHAR,
    caller_session_id       TEXT,
    notify_completion       BOOLEAN NOT NULL DEFAULT TRUE,
    termination_reason      TEXT,
    termination_detail      TEXT,
    review_required         BOOLEAN NOT NULL DEFAULT FALSE,
    review_state            TEXT NOT NULL DEFAULT 'not_required',
    predecessor_session_id  TEXT REFERENCES sessions(session_id) ON DELETE SET NULL
);

-- 기존 테이블에 caller_session_id 컬럼 추가 (멱등)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS caller_session_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS notify_completion BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS predecessor_session_id TEXT;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_predecessor_session_id_fkey;
ALTER TABLE sessions ADD CONSTRAINT sessions_predecessor_session_id_fkey
    FOREIGN KEY (predecessor_session_id) REFERENCES sessions(session_id) ON DELETE SET NULL;

-- away_summary 컬럼 추가 (멱등)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS away_summary TEXT;

-- Supervisor termination reason 컬럼 추가 (멱등)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS termination_reason TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS termination_detail TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS review_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS review_state TEXT NOT NULL DEFAULT 'not_required';
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_review_state_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_review_state_check
    CHECK (review_state IN ('not_required', 'needs_review', 'acknowledged'));

CREATE OR REPLACE FUNCTION board_delete_session_refs()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM board_items WHERE item_type = 'session' AND item_id = OLD.session_id;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS board_delete_session_refs_trigger ON sessions;
CREATE TRIGGER board_delete_session_refs_trigger
AFTER DELETE ON sessions
FOR EACH ROW EXECUTE FUNCTION board_delete_session_refs();

CREATE TABLE IF NOT EXISTS markdown_documents (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    version     INTEGER NOT NULL DEFAULT 1,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE markdown_documents
    ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS file_assets (
    id                   TEXT PRIMARY KEY,
    storage_key          TEXT NOT NULL UNIQUE,
    original_name        TEXT NOT NULL,
    mime_type            TEXT NOT NULL,
    byte_size            BIGINT NOT NULL CHECK (byte_size >= 0),
    width                INTEGER,
    height               INTEGER,
    duration_seconds     DOUBLE PRECISION,
    checksum_sha256      TEXT,
    upload_status        TEXT NOT NULL DEFAULT 'pending' CHECK (upload_status IN ('pending', 'committed')),
    multipart_upload_id  TEXT,
    garbage_collected_at TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS board_items (
    id                     TEXT PRIMARY KEY,
    folder_id              TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    container_kind         TEXT NOT NULL DEFAULT 'folder',
    container_id           TEXT NOT NULL,
    membership_kind        TEXT NOT NULL DEFAULT 'primary',
    source_runbook_item_id TEXT,
    item_type              TEXT NOT NULL CHECK (item_type IN ('session', 'markdown', 'subfolder', 'asset', 'frame', 'runbook', 'custom_view')),
    item_id                TEXT NOT NULL,
    x                      DOUBLE PRECISION NOT NULL DEFAULT 0,
    y                      DOUBLE PRECISION NOT NULL DEFAULT 0,
    metadata               JSONB NOT NULL DEFAULT '{}',
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT board_items_container_kind_check
        CHECK (container_kind IN ('folder','runbook')),
    CONSTRAINT board_items_membership_kind_check
        CHECK (membership_kind IN ('primary','reference')),
    CONSTRAINT uq_board_items_container_item
        UNIQUE (container_kind, container_id, item_id)
);

ALTER TABLE board_items ADD COLUMN IF NOT EXISTS container_kind TEXT NOT NULL DEFAULT 'folder';
ALTER TABLE board_items ADD COLUMN IF NOT EXISTS container_id TEXT;
ALTER TABLE board_items ADD COLUMN IF NOT EXISTS membership_kind TEXT NOT NULL DEFAULT 'primary';
ALTER TABLE board_items ADD COLUMN IF NOT EXISTS source_runbook_item_id TEXT;
ALTER TABLE board_items ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
ALTER TABLE board_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
UPDATE board_items SET container_kind = 'folder' WHERE container_kind IS NULL;
UPDATE board_items SET container_id = folder_id WHERE container_id IS NULL;
UPDATE board_items SET membership_kind = 'primary' WHERE membership_kind IS NULL;
ALTER TABLE board_items ALTER COLUMN container_kind SET NOT NULL;
ALTER TABLE board_items ALTER COLUMN container_id SET NOT NULL;
ALTER TABLE board_items ALTER COLUMN membership_kind SET NOT NULL;
ALTER TABLE board_items DROP CONSTRAINT IF EXISTS board_items_item_type_check;
ALTER TABLE board_items ADD CONSTRAINT board_items_item_type_check
    CHECK (item_type IN ('session', 'markdown', 'subfolder', 'asset', 'frame', 'runbook', 'custom_view'));
ALTER TABLE board_items DROP CONSTRAINT IF EXISTS board_items_container_kind_check;
ALTER TABLE board_items ADD CONSTRAINT board_items_container_kind_check
    CHECK (container_kind IN ('folder','runbook'));
ALTER TABLE board_items DROP CONSTRAINT IF EXISTS board_items_membership_kind_check;
ALTER TABLE board_items ADD CONSTRAINT board_items_membership_kind_check
    CHECK (membership_kind IN ('primary','reference'));
ALTER TABLE board_items DROP CONSTRAINT IF EXISTS board_items_folder_id_item_id_key;
ALTER TABLE board_items DROP CONSTRAINT IF EXISTS uq_board_items_container_item;
ALTER TABLE board_items ADD CONSTRAINT uq_board_items_container_item
    UNIQUE (container_kind, container_id, item_id);

CREATE OR REPLACE FUNCTION board_items_fill_container_defaults()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.container_id IS NULL THEN
        NEW.container_kind := 'folder';
        NEW.container_id := NEW.folder_id;
    END IF;
    IF NEW.container_kind IS NULL THEN
        NEW.container_kind := 'folder';
    END IF;
    IF NEW.membership_kind IS NULL THEN
        NEW.membership_kind := 'primary';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_board_items_fill_container_defaults ON board_items;
CREATE TRIGGER trg_board_items_fill_container_defaults
    BEFORE INSERT ON board_items
    FOR EACH ROW EXECUTE FUNCTION board_items_fill_container_defaults();

CREATE TABLE IF NOT EXISTS board_yjs_documents (
    name        TEXT PRIMARY KEY,
    snapshot    BYTEA NOT NULL,
    synced_at   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE board_yjs_documents ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS board_yjs_updates (
    id             BIGSERIAL PRIMARY KEY,
    document_name  TEXT NOT NULL REFERENCES board_yjs_documents(name) ON DELETE CASCADE,
    update         BYTEA NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS board_yjs_catalog_cache (
    folder_id           TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    container_kind      TEXT NOT NULL DEFAULT 'folder',
    container_id        TEXT NOT NULL,
    board_items         JSONB NOT NULL DEFAULT '[]'::jsonb,
    markdown_documents  JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT board_yjs_catalog_cache_container_kind_check
        CHECK (container_kind IN ('folder','runbook')),
    CONSTRAINT board_yjs_catalog_cache_pkey
        PRIMARY KEY (container_kind, container_id)
);
ALTER TABLE board_yjs_catalog_cache ADD COLUMN IF NOT EXISTS container_kind TEXT;
ALTER TABLE board_yjs_catalog_cache ADD COLUMN IF NOT EXISTS container_id TEXT;
UPDATE board_yjs_catalog_cache SET container_kind = 'folder' WHERE container_kind IS NULL;
UPDATE board_yjs_catalog_cache SET container_id = folder_id WHERE container_id IS NULL;
ALTER TABLE board_yjs_catalog_cache ALTER COLUMN folder_id SET NOT NULL;
ALTER TABLE board_yjs_catalog_cache ALTER COLUMN container_kind SET NOT NULL;
ALTER TABLE board_yjs_catalog_cache ALTER COLUMN container_id SET NOT NULL;
ALTER TABLE board_yjs_catalog_cache DROP CONSTRAINT IF EXISTS board_yjs_catalog_cache_container_kind_check;
ALTER TABLE board_yjs_catalog_cache ADD CONSTRAINT board_yjs_catalog_cache_container_kind_check
    CHECK (container_kind IN ('folder','runbook'));
ALTER TABLE board_yjs_catalog_cache DROP CONSTRAINT IF EXISTS board_yjs_catalog_cache_pkey;
ALTER TABLE board_yjs_catalog_cache ADD CONSTRAINT board_yjs_catalog_cache_pkey
    PRIMARY KEY (container_kind, container_id);

CREATE OR REPLACE FUNCTION board_delete_markdown_refs()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM board_items WHERE item_type = 'markdown' AND item_id = OLD.id;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS board_delete_markdown_refs_trigger ON markdown_documents;
CREATE TRIGGER board_delete_markdown_refs_trigger
AFTER DELETE ON markdown_documents
FOR EACH ROW EXECUTE FUNCTION board_delete_markdown_refs();

CREATE OR REPLACE FUNCTION board_delete_asset_refs()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM board_items WHERE item_type = 'asset' AND item_id = OLD.id;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS board_delete_asset_refs_trigger ON file_assets;
CREATE TRIGGER board_delete_asset_refs_trigger
AFTER DELETE ON file_assets
FOR EACH ROW EXECUTE FUNCTION board_delete_asset_refs();

CREATE TABLE IF NOT EXISTS events (
    session_id      TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    id              INTEGER NOT NULL,
    event_type      TEXT NOT NULL,
    payload         JSONB,
    searchable_text TEXT,
    search_vector   TSVECTOR,
    dedupe_key      TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (session_id, id)
);

CREATE TABLE IF NOT EXISTS board_custom_views (
    id                 TEXT PRIMARY KEY,
    board_item_id      TEXT NOT NULL UNIQUE REFERENCES board_items(id) ON DELETE CASCADE,
    title              TEXT,
    html               TEXT NOT NULL DEFAULT '',
    revision           INTEGER NOT NULL DEFAULT 1,
    archived           BOOLEAN NOT NULL DEFAULT FALSE,
    created_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    created_event_id   INTEGER,
    updated_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    updated_event_id   INTEGER,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (created_session_id, created_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL,
    FOREIGN KEY (updated_session_id, updated_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL
);

ALTER TABLE board_custom_views ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE board_custom_views ADD COLUMN IF NOT EXISTS html TEXT NOT NULL DEFAULT '';
ALTER TABLE board_custom_views ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE board_custom_views ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE board_custom_views ADD COLUMN IF NOT EXISTS created_session_id TEXT;
ALTER TABLE board_custom_views ADD COLUMN IF NOT EXISTS created_event_id INTEGER;
ALTER TABLE board_custom_views ADD COLUMN IF NOT EXISTS updated_session_id TEXT;
ALTER TABLE board_custom_views ADD COLUMN IF NOT EXISTS updated_event_id INTEGER;
ALTER TABLE board_custom_views ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE board_custom_views ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE board_custom_views DROP CONSTRAINT IF EXISTS board_custom_views_created_session_id_fkey;
ALTER TABLE board_custom_views ADD CONSTRAINT board_custom_views_created_session_id_fkey
    FOREIGN KEY (created_session_id) REFERENCES sessions(session_id) ON DELETE SET NULL;
ALTER TABLE board_custom_views DROP CONSTRAINT IF EXISTS board_custom_views_updated_session_id_fkey;
ALTER TABLE board_custom_views ADD CONSTRAINT board_custom_views_updated_session_id_fkey
    FOREIGN KEY (updated_session_id) REFERENCES sessions(session_id) ON DELETE SET NULL;
ALTER TABLE board_custom_views DROP CONSTRAINT IF EXISTS board_custom_views_created_session_id_created_event_id_fkey;
ALTER TABLE board_custom_views ADD CONSTRAINT board_custom_views_created_session_id_created_event_id_fkey
    FOREIGN KEY (created_session_id, created_event_id)
    REFERENCES events(session_id, id) ON DELETE SET NULL;
ALTER TABLE board_custom_views DROP CONSTRAINT IF EXISTS board_custom_views_updated_session_id_updated_event_id_fkey;
ALTER TABLE board_custom_views ADD CONSTRAINT board_custom_views_updated_session_id_updated_event_id_fkey
    FOREIGN KEY (updated_session_id, updated_event_id)
    REFERENCES events(session_id, id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_board_custom_views_board_item
    ON board_custom_views(board_item_id);

CREATE OR REPLACE FUNCTION board_delete_custom_view_refs()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM board_items WHERE item_type = 'custom_view' AND item_id = OLD.id;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS board_delete_custom_view_refs_trigger ON board_custom_views;
CREATE TRIGGER board_delete_custom_view_refs_trigger
AFTER DELETE ON board_custom_views
FOR EACH ROW EXECUTE FUNCTION board_delete_custom_view_refs();

CREATE TABLE IF NOT EXISTS soulstream_schedules (
    schedule_id     TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('wakeup', 'cron')),
    status          TEXT NOT NULL CHECK (
        status IN (
            'active',
            'dispatching',
            'firing',
            'completed',
            'cancelled',
            'failed',
            'orphaned'
        )
    ),
    prompt          TEXT NOT NULL,
    source_tool     TEXT NOT NULL,
    tool_use_id     TEXT,
    cron_expression TEXT,
    run_once_at     TIMESTAMPTZ,
    timezone        TEXT NOT NULL DEFAULT 'UTC',
    recurring       BOOLEAN NOT NULL DEFAULT FALSE,
    next_run_at     TIMESTAMPTZ,
    last_fired_at   TIMESTAMPTZ,
    fired_count     INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    claim_token     TEXT,
    claimed_until   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS soulstream_node_heartbeats (
    node_id      TEXT PRIMARY KEY,
    last_seen_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS supervisor_events (
    "offset"          BIGSERIAL PRIMARY KEY,
    source_node       TEXT NOT NULL,
    source_session_id TEXT NOT NULL,
    source_event_id   INTEGER NOT NULL CHECK (source_event_id > 0),
    event_type        TEXT NOT NULL,
    payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL,
    inserted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT supervisor_events_source_key UNIQUE (source_node, source_session_id, source_event_id)
);

CREATE TABLE IF NOT EXISTS supervisor_source_cursors (
    source_node           TEXT NOT NULL,
    source_session_id     TEXT NOT NULL,
    contiguous_upto       INTEGER NOT NULL DEFAULT 0 CHECK (contiguous_upto >= 0),
    highest_seen_event_id INTEGER NOT NULL DEFAULT 0 CHECK (highest_seen_event_id >= 0),
    gap_start             INTEGER,
    gap_end               INTEGER,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (source_node, source_session_id),
    CHECK (highest_seen_event_id >= contiguous_upto),
    CHECK (
        (gap_start IS NULL AND gap_end IS NULL)
        OR (gap_start IS NOT NULL AND gap_end IS NOT NULL AND gap_start <= gap_end)
    )
);

CREATE TABLE IF NOT EXISTS supervisor_consumers (
    supervisor_id TEXT PRIMARY KEY,
    cursor_offset BIGINT NOT NULL DEFAULT 0 CHECK (cursor_offset >= 0),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS supervisor_registry (
    role                TEXT PRIMARY KEY,
    active_session_id   TEXT,
    epoch               BIGINT NOT NULL DEFAULT 0 CHECK (epoch >= 0),
    cursor_offset       BIGINT NOT NULL DEFAULT 0 CHECK (cursor_offset >= 0),
    handover_state      TEXT NOT NULL DEFAULT 'idle',
    cumulative_tokens   BIGINT NOT NULL DEFAULT 0 CHECK (cumulative_tokens >= 0),
    compaction_count    INTEGER NOT NULL DEFAULT 0 CHECK (compaction_count >= 0),
    last_seen_at        TIMESTAMPTZ,
    wake_dispatch_state TEXT NOT NULL DEFAULT 'active',
    wake_last_signature TEXT,
    wake_repeat_count   INTEGER NOT NULL DEFAULT 0 CHECK (wake_repeat_count >= 0),
    wake_blocked_reason TEXT,
    wake_blocked_at     TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (handover_state IN ('idle', 'idle_pending', 'hard_pending', 'handover_running')),
    CHECK (wake_dispatch_state IN ('active', 'retrying', 'blocked'))
);

ALTER TABLE IF EXISTS supervisor_registry
    ADD COLUMN IF NOT EXISTS wake_dispatch_state TEXT NOT NULL DEFAULT 'active';
ALTER TABLE IF EXISTS supervisor_registry
    ADD COLUMN IF NOT EXISTS wake_last_signature TEXT;
ALTER TABLE IF EXISTS supervisor_registry
    ADD COLUMN IF NOT EXISTS wake_repeat_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS supervisor_registry
    ADD COLUMN IF NOT EXISTS wake_blocked_reason TEXT;
ALTER TABLE IF EXISTS supervisor_registry
    ADD COLUMN IF NOT EXISTS wake_blocked_at TIMESTAMPTZ;

DO $$
BEGIN
    ALTER TABLE supervisor_registry
        ADD CONSTRAINT supervisor_registry_wake_dispatch_state_check
        CHECK (wake_dispatch_state IN ('active', 'retrying', 'blocked'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE supervisor_registry
        ADD CONSTRAINT supervisor_registry_wake_repeat_count_check
        CHECK (wake_repeat_count >= 0);
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS event_search_terms (
    session_id TEXT NOT NULL,
    event_id   INTEGER NOT NULL,
    term       TEXT NOT NULL,
    term_freq  INTEGER NOT NULL,
    doc_len    INTEGER NOT NULL,
    PRIMARY KEY (session_id, event_id, term),
    FOREIGN KEY (session_id, event_id)
        REFERENCES events(session_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS event_search_corpus_stats (
    id            BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    total_docs    BIGINT NOT NULL DEFAULT 0 CHECK (total_docs >= 0),
    total_doc_len BIGINT NOT NULL DEFAULT 0 CHECK (total_doc_len >= 0),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_items (
    id                    TEXT PRIMARY KEY,
    parent_id             TEXT REFERENCES task_items(id) ON DELETE SET NULL,
    position_key          DOUBLE PRECISION NOT NULL DEFAULT 0,
    title                 TEXT NOT NULL,
    description           TEXT NOT NULL DEFAULT '',
    acceptance_criteria   TEXT NOT NULL DEFAULT '',
    verification_owner    TEXT NOT NULL DEFAULT 'agent',
    status                TEXT NOT NULL DEFAULT 'open',
    linked_session_id     TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    linked_node_id        TEXT,
    active_for_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    created_from_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    created_from_event_id INTEGER,
    navigation_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    navigation_node_id    TEXT,
    navigation_event_id   INTEGER,
    archived              BOOLEAN NOT NULL DEFAULT FALSE,
    pinned                BOOLEAN NOT NULL DEFAULT FALSE,
    version               INTEGER NOT NULL DEFAULT 1,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (status IN (
        'open',
        'in_progress',
        'agent_done',
        'verified_done',
        'reopened',
        'blocked',
        'cancelled'
    )),
    CHECK (verification_owner IN ('agent', 'user', 'both'))
);

ALTER TABLE task_items ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS task_operations (
    id                 TEXT PRIMARY KEY,
    task_id            TEXT REFERENCES task_items(id) ON DELETE SET NULL,
    operation_type     TEXT NOT NULL,
    actor_kind         TEXT NOT NULL DEFAULT 'agent',
    actor_session_id   TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    actor_event_id     INTEGER,
    actor_user_id      TEXT,
    idempotency_key    TEXT,
    payload_json       JSONB NOT NULL DEFAULT '{}',
    reason             TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS claude_transcript_entries (
    id          BIGSERIAL PRIMARY KEY,
    project_key TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    subpath     TEXT NOT NULL DEFAULT '',
    entry_uuid  TEXT,
    entry       JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 뷰포트 가상화 지원: parent_event_id 컬럼 승격 (payload → 정본 컬럼)
ALTER TABLE events ADD COLUMN IF NOT EXISTS parent_event_id INTEGER;
ALTER TABLE events ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

-- FK 제약은 IF NOT EXISTS를 지원하지 않으므로 pg_constraint 확인 후 추가 (멱등)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'events_parent_fk'
    ) THEN
        ALTER TABLE events
            ADD CONSTRAINT events_parent_fk
            FOREIGN KEY (session_id, parent_event_id)
            REFERENCES events(session_id, id) ON DELETE CASCADE;
    END IF;
END$$;

-- 뷰포트 가상화 지원: subtree_height — DFS로 계산된 자기 포함 서브트리 크기
ALTER TABLE events ADD COLUMN IF NOT EXISTS subtree_height INTEGER NOT NULL DEFAULT 1;

-- ============================================================
-- 2. 인덱스
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_events_session_id_id ON events (session_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_session_dedupe_key
    ON events (session_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_search_vector ON events USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_event_search_terms_term ON event_search_terms (term);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_soulstream_schedules_session
    ON soulstream_schedules (session_id, status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_soulstream_schedules_due
    ON soulstream_schedules (next_run_at)
    WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_soulstream_node_heartbeats_seen
    ON soulstream_node_heartbeats (last_seen_at);
CREATE INDEX IF NOT EXISTS idx_supervisor_events_source
    ON supervisor_events (source_node, source_session_id, source_event_id);
CREATE INDEX IF NOT EXISTS idx_supervisor_events_inserted_at
    ON supervisor_events (inserted_at DESC);
CREATE INDEX IF NOT EXISTS idx_supervisor_registry_last_seen
    ON supervisor_registry (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_board_items_folder ON board_items (folder_id, y, x);
CREATE INDEX IF NOT EXISTS idx_board_items_container ON board_items (container_kind, container_id, y, x);
CREATE INDEX IF NOT EXISTS idx_board_items_ref ON board_items (item_type, item_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_board_items_primary_membership
    ON board_items (item_type, item_id)
    WHERE membership_kind = 'primary';
CREATE INDEX IF NOT EXISTS idx_board_yjs_catalog_cache_folder
    ON board_yjs_catalog_cache (folder_id);
CREATE INDEX IF NOT EXISTS idx_board_yjs_updates_document ON board_yjs_updates (document_name, id);

CREATE INDEX IF NOT EXISTS idx_task_items_parent ON task_items (parent_id, position_key);
CREATE INDEX IF NOT EXISTS idx_task_items_status ON task_items (status) WHERE archived = FALSE;
CREATE INDEX IF NOT EXISTS idx_task_items_active_session ON task_items (active_for_session_id) WHERE active_for_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_items_linked_session ON task_items (linked_session_id) WHERE linked_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_items_sibling_sort ON task_items (parent_id, pinned DESC, updated_at DESC) WHERE archived = FALSE;
CREATE INDEX IF NOT EXISTS idx_task_operations_task ON task_operations (task_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_operations_idempotency
    ON task_operations (idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claude_transcript_load
    ON claude_transcript_entries (project_key, session_id, subpath, id);
CREATE INDEX IF NOT EXISTS idx_claude_transcript_sessions
    ON claude_transcript_entries (project_key, session_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_claude_transcript_entry_uuid
    ON claude_transcript_entries (project_key, session_id, subpath, entry_uuid)
    WHERE entry_uuid IS NOT NULL;

CREATE OR REPLACE FUNCTION task_tree_notify_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_payload JSONB;
BEGIN
    IF TG_TABLE_NAME = 'task_items' THEN
        v_payload := jsonb_build_object(
            'table', TG_TABLE_NAME,
            'action', TG_OP,
            'task_id', NEW.id,
            'updated_at', NEW.updated_at
        );
    ELSE
        v_payload := jsonb_build_object(
            'table', TG_TABLE_NAME,
            'action', TG_OP,
            'task_id', NEW.task_id,
            'operation_id', NEW.id,
            'operation_type', NEW.operation_type,
            'actor_event_id', NEW.actor_event_id
        );
    END IF;
    PERFORM pg_notify('task_tree_changed', v_payload::text);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_task_items_notify ON task_items;
CREATE TRIGGER trg_task_items_notify
AFTER INSERT OR UPDATE ON task_items
FOR EACH ROW EXECUTE FUNCTION task_tree_notify_change();

DROP TRIGGER IF EXISTS trg_task_operations_notify ON task_operations;
CREATE TRIGGER trg_task_operations_notify
AFTER INSERT OR UPDATE ON task_operations
FOR EACH ROW EXECUTE FUNCTION task_tree_notify_change();

-- 뷰포트 가상화 지원: parent_event_id 기반 자식 조회 인덱스
CREATE INDEX IF NOT EXISTS idx_events_parent ON events (session_id, parent_event_id);

-- /messages 페이지네이션용 복합 인덱스 (created_at DESC + id DESC 커서 지원)
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events (session_id, created_at DESC, id DESC);

-- ============================================================
-- 3. 트리거 (search_vector 자동 갱신)
-- ============================================================

CREATE OR REPLACE FUNCTION event_search_tokenize(p_text TEXT)
RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$
    SELECT COALESCE(array_agg(term), ARRAY[]::TEXT[])
    FROM regexp_split_to_table(
        lower(coalesce(p_text, '')),
        '[^[:alnum:]_가-힣]+'
    ) AS token(term)
    WHERE term <> '';
$$;

CREATE OR REPLACE FUNCTION update_search_vector() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.searchable_text IS NOT NULL AND NEW.searchable_text != '' THEN
        NEW.search_vector := to_tsvector('simple', NEW.searchable_text);
    ELSE
        NEW.search_vector := NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_search_vector ON events;
CREATE TRIGGER trg_events_search_vector
    BEFORE INSERT OR UPDATE OF searchable_text ON events
    FOR EACH ROW EXECUTE FUNCTION update_search_vector();

CREATE OR REPLACE FUNCTION event_search_adjust_corpus_stats(
    p_doc_delta     INTEGER,
    p_doc_len_delta INTEGER
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO event_search_corpus_stats (id, total_docs, total_doc_len, updated_at)
    VALUES (TRUE, 0, 0, NOW())
    ON CONFLICT (id) DO NOTHING;

    UPDATE event_search_corpus_stats
    SET total_docs = GREATEST(total_docs + p_doc_delta, 0),
        total_doc_len = GREATEST(total_doc_len + p_doc_len_delta, 0),
        updated_at = NOW()
    WHERE id = TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION refresh_event_search_terms() RETURNS TRIGGER AS $$
DECLARE
    v_tokens TEXT[];
    v_doc_len INTEGER;
    v_old_doc_len INTEGER;
BEGIN
    SELECT MAX(doc_len) INTO v_old_doc_len
    FROM event_search_terms
    WHERE session_id = NEW.session_id
      AND event_id = NEW.id;

    IF v_old_doc_len IS NOT NULL THEN
        PERFORM event_search_adjust_corpus_stats(-1, -v_old_doc_len);
    END IF;

    DELETE FROM event_search_terms
    WHERE session_id = NEW.session_id
      AND event_id = NEW.id;

    v_tokens := event_search_tokenize(NEW.searchable_text);
    v_doc_len := cardinality(v_tokens);

    IF v_doc_len > 0 THEN
        INSERT INTO event_search_terms (
            session_id, event_id, term, term_freq, doc_len
        )
        SELECT NEW.session_id, NEW.id, term, COUNT(*)::INTEGER, v_doc_len
        FROM unnest(v_tokens) AS token(term)
        GROUP BY term;

        PERFORM event_search_adjust_corpus_stats(1, v_doc_len);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION decrement_event_search_corpus_stats() RETURNS TRIGGER AS $$
DECLARE
    v_old_doc_len INTEGER;
BEGIN
    SELECT MAX(doc_len) INTO v_old_doc_len
    FROM event_search_terms
    WHERE session_id = OLD.session_id
      AND event_id = OLD.id;

    IF v_old_doc_len IS NOT NULL THEN
        PERFORM event_search_adjust_corpus_stats(-1, -v_old_doc_len);
    END IF;

    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_event_search_terms ON events;
CREATE TRIGGER trg_event_search_terms
    AFTER INSERT OR UPDATE OF searchable_text ON events
    FOR EACH ROW EXECUTE FUNCTION refresh_event_search_terms();

DROP TRIGGER IF EXISTS trg_event_search_corpus_stats_delete ON events;
CREATE TRIGGER trg_event_search_corpus_stats_delete
    BEFORE DELETE ON events
    FOR EACH ROW EXECUTE FUNCTION decrement_event_search_corpus_stats();

INSERT INTO event_search_corpus_stats (id, total_docs, total_doc_len, updated_at)
SELECT
    TRUE,
    COUNT(*)::BIGINT,
    COALESCE(SUM(doc_len), 0)::BIGINT,
    NOW()
FROM (
    SELECT DISTINCT session_id, event_id, doc_len
    FROM event_search_terms
) docs
ON CONFLICT (id) DO UPDATE
SET total_docs = EXCLUDED.total_docs,
    total_doc_len = EXCLUDED.total_doc_len,
    updated_at = NOW();

-- ============================================================
-- 4. 프로시저/함수
-- ============================================================

-- 세션 도메인 --------------------------------------------------

-- 1. session_upsert
CREATE OR REPLACE FUNCTION session_upsert(
    p_session_id  TEXT,
    p_columns     TEXT[],
    p_values      TEXT[],
    p_created_at  TIMESTAMPTZ,
    p_updated_at  TIMESTAMPTZ
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    allowed TEXT[] := ARRAY[
        'folder_id', 'display_name', 'session_type', 'status',
        'prompt', 'client_id', 'claude_session_id', 'last_message',
        'metadata', 'was_running_at_shutdown',
        'last_event_id', 'last_read_event_id',
        'created_at', 'updated_at', 'node_id', 'agent_id',
        'termination_reason', 'termination_detail'
    ];
    col_list  TEXT;
    val_list  TEXT;
    set_list  TEXT;
    i         INTEGER;
    col       TEXT;
    jsonb_cols TEXT[] := ARRAY['last_message', 'metadata'];
    bool_cols  TEXT[] := ARRAY['was_running_at_shutdown'];
    int_cols   TEXT[] := ARRAY['last_event_id', 'last_read_event_id'];
    ts_cols    TEXT[] := ARRAY['created_at', 'updated_at'];
BEGIN
    -- 화이트리스트 검증
    FOR i IN 1..array_length(p_columns, 1) LOOP
        IF NOT (p_columns[i] = ANY(allowed)) THEN
            RAISE EXCEPTION 'Invalid session column: %', p_columns[i];
        END IF;
    END LOOP;

    -- INSERT 컬럼/값 생성: session_id + created_at + updated_at + 동적 컬럼
    col_list := 'session_id, created_at, updated_at';
    val_list := quote_literal(p_session_id) || ', ' ||
                quote_literal(p_created_at::text) || '::timestamptz, ' ||
                quote_literal(p_updated_at::text) || '::timestamptz';

    FOR i IN 1..array_length(p_columns, 1) LOOP
        col := p_columns[i];
        col_list := col_list || ', ' || col;

        IF p_values[i] IS NULL THEN
            val_list := val_list || ', NULL';
        ELSIF col = ANY(jsonb_cols) THEN
            val_list := val_list || ', ' || quote_literal(p_values[i]) || '::jsonb';
        ELSIF col = ANY(bool_cols) THEN
            val_list := val_list || ', ' || p_values[i] || '::boolean';
        ELSIF col = ANY(int_cols) THEN
            val_list := val_list || ', ' || p_values[i] || '::integer';
        ELSIF col = ANY(ts_cols) THEN
            val_list := val_list || ', ' || quote_literal(p_values[i]) || '::timestamptz';
        ELSE
            val_list := val_list || ', ' || quote_literal(p_values[i]);
        END IF;
    END LOOP;

    -- UPDATE SET 생성: session_id, created_at 제외; 불변 필드는 COALESCE로 보호
    set_list := 'updated_at = EXCLUDED.updated_at';
    FOR i IN 1..array_length(p_columns, 1) LOOP
        col := p_columns[i];
        IF col NOT IN ('created_at') THEN
            IF col = ANY(ARRAY['node_id', 'agent_id', 'claude_session_id']) THEN
                -- 불변 필드: 기존 값이 있으면 유지, 없을 때만 새 값 사용
                set_list := set_list || ', ' || col
                    || ' = COALESCE(sessions.' || col || ', EXCLUDED.' || col || ')';
            ELSE
                set_list := set_list || ', ' || col || ' = EXCLUDED.' || col;
            END IF;
        END IF;
    END LOOP;

    EXECUTE format(
        'INSERT INTO sessions (%s) VALUES (%s) ON CONFLICT (session_id) DO UPDATE SET %s',
        col_list, val_list, set_list
    );
END;
$$;

-- session_register (4-ID 최초 등록 — 순수 INSERT, ON CONFLICT 없음)
-- NOTE: 인자 시그니처 변경 시 기존 overload를 DROP하지 않으면 운영 DB에 구시그니처가 남는다.
DROP FUNCTION IF EXISTS session_register(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT);
DROP FUNCTION IF EXISTS session_register(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BOOLEAN);
CREATE OR REPLACE FUNCTION session_register(
    p_session_id        TEXT,
    p_node_id           TEXT,
    p_agent_id          TEXT,
    p_claude_session_id TEXT,
    p_session_type      TEXT,
    p_prompt            TEXT,
    p_client_id         TEXT,
    p_status            TEXT,
    p_created_at        TIMESTAMPTZ,
    p_updated_at        TIMESTAMPTZ,
    p_caller_session_id TEXT DEFAULT NULL,
    p_notify_completion BOOLEAN DEFAULT TRUE
) RETURNS void LANGUAGE sql AS $$
    INSERT INTO sessions (
        session_id, node_id, agent_id, claude_session_id,
        session_type, prompt, client_id, status,
        created_at, updated_at, caller_session_id, notify_completion
    ) VALUES (
        p_session_id, p_node_id, p_agent_id, p_claude_session_id,
        p_session_type, p_prompt, p_client_id, p_status,
        p_created_at, p_updated_at, p_caller_session_id, COALESCE(p_notify_completion, TRUE)
    );
$$;

-- Additive review-aware registration. Keep session_register's signature intact for old workers.
DROP FUNCTION IF EXISTS session_register_with_review(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BOOLEAN, BOOLEAN, TEXT);
CREATE OR REPLACE FUNCTION session_register_with_review(
    p_session_id        TEXT,
    p_node_id           TEXT,
    p_agent_id          TEXT,
    p_claude_session_id TEXT,
    p_session_type      TEXT,
    p_prompt            TEXT,
    p_client_id         TEXT,
    p_status            TEXT,
    p_created_at        TIMESTAMPTZ,
    p_updated_at        TIMESTAMPTZ,
    p_caller_session_id TEXT,
    p_notify_completion BOOLEAN,
    p_review_required   BOOLEAN,
    p_review_state      TEXT
) RETURNS void LANGUAGE sql AS $$
    INSERT INTO sessions (
        session_id, node_id, agent_id, claude_session_id,
        session_type, prompt, client_id, status,
        created_at, updated_at, caller_session_id, notify_completion,
        review_required, review_state
    ) VALUES (
        p_session_id, p_node_id, p_agent_id, p_claude_session_id,
        p_session_type, p_prompt, p_client_id, p_status,
        p_created_at, p_updated_at, p_caller_session_id,
        COALESCE(p_notify_completion, TRUE),
        COALESCE(p_review_required, FALSE),
        COALESCE(p_review_state, 'not_required')
    );
$$;

-- Additive predecessor-aware registration. Keep both older registration signatures intact.
DROP FUNCTION IF EXISTS session_register_with_predecessor(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BOOLEAN, BOOLEAN, TEXT, TEXT);
CREATE OR REPLACE FUNCTION session_register_with_predecessor(
    p_session_id            TEXT,
    p_node_id               TEXT,
    p_agent_id              TEXT,
    p_claude_session_id     TEXT,
    p_session_type          TEXT,
    p_prompt                TEXT,
    p_client_id             TEXT,
    p_status                TEXT,
    p_created_at            TIMESTAMPTZ,
    p_updated_at            TIMESTAMPTZ,
    p_caller_session_id     TEXT,
    p_notify_completion     BOOLEAN,
    p_review_required       BOOLEAN,
    p_review_state          TEXT,
    p_predecessor_session_id TEXT
) RETURNS void LANGUAGE sql AS $$
    INSERT INTO sessions (
        session_id, node_id, agent_id, claude_session_id,
        session_type, prompt, client_id, status,
        created_at, updated_at, caller_session_id, notify_completion,
        review_required, review_state, predecessor_session_id
    ) VALUES (
        p_session_id, p_node_id, p_agent_id, p_claude_session_id,
        p_session_type, p_prompt, p_client_id, p_status,
        p_created_at, p_updated_at, p_caller_session_id,
        COALESCE(p_notify_completion, TRUE),
        COALESCE(p_review_required, FALSE),
        COALESCE(p_review_state, 'not_required'),
        p_predecessor_session_id
    );
$$;

CREATE OR REPLACE FUNCTION session_acknowledge_review(
    p_session_id TEXT,
    p_updated_at TIMESTAMPTZ
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
    v_review_required BOOLEAN;
    v_review_state TEXT;
BEGIN
    SELECT review_required, review_state
      INTO v_review_required, v_review_state
      FROM sessions
     WHERE session_id = p_session_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN 'not_found';
    ELSIF NOT v_review_required THEN
        RETURN 'not_required';
    ELSIF v_review_state = 'acknowledged' THEN
        RETURN 'already_acknowledged';
    ELSIF v_review_state <> 'needs_review' THEN
        RETURN 'not_pending';
    END IF;

    UPDATE sessions
       SET review_state = 'acknowledged',
           updated_at = p_updated_at
     WHERE session_id = p_session_id;
    RETURN 'acknowledged';
END;
$$;

-- session_set_claude_id (claude_session_id 불변 설정)
-- NULL → SET (최초 설정)
-- 같은 값 → no-op (idempotent, 컴팩션/재시작 재진입 허용)
-- 다른 값 → RAISE EXCEPTION (버그 탐지)
CREATE OR REPLACE FUNCTION session_set_claude_id(
    p_session_id        TEXT,
    p_claude_session_id TEXT
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    v_existing TEXT;
BEGIN
    SELECT claude_session_id INTO v_existing
    FROM sessions
    WHERE session_id = p_session_id;

    IF v_existing IS NULL THEN
        UPDATE sessions
        SET claude_session_id = p_claude_session_id,
            updated_at = NOW()
        WHERE session_id = p_session_id;
    ELSIF v_existing = p_claude_session_id THEN
        NULL;
    ELSE
        RAISE EXCEPTION 'claude_session_id immutability violation: session_id=%, existing=%, new=%',
            p_session_id, v_existing, p_claude_session_id;
    END IF;
END;
$$;

-- session_update (불변 필드 제외 동적 UPDATE)
CREATE OR REPLACE FUNCTION session_update(
    p_session_id TEXT,
    p_columns    TEXT[],
    p_values     TEXT[],
    p_updated_at TIMESTAMPTZ
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    allowed TEXT[] := ARRAY[
        'folder_id', 'display_name', 'status',
        'prompt', 'client_id', 'last_message',
        'metadata', 'was_running_at_shutdown',
        'last_event_id', 'last_read_event_id',
        'termination_reason', 'termination_detail', 'review_state'
    ];
    set_list  TEXT;
    i         INTEGER;
    col       TEXT;
    jsonb_cols TEXT[] := ARRAY['last_message', 'metadata'];
    bool_cols  TEXT[] := ARRAY['was_running_at_shutdown'];
    int_cols   TEXT[] := ARRAY['last_event_id', 'last_read_event_id'];
BEGIN
    -- 화이트리스트 검증 (불변 필드는 화이트리스트에 없음)
    FOR i IN 1..array_length(p_columns, 1) LOOP
        IF NOT (p_columns[i] = ANY(allowed)) THEN
            RAISE EXCEPTION 'Invalid or immutable session column: %', p_columns[i];
        END IF;
    END LOOP;

    -- UPDATE SET 생성
    set_list := 'updated_at = ' || quote_literal(p_updated_at::text) || '::timestamptz';
    FOR i IN 1..array_length(p_columns, 1) LOOP
        col := p_columns[i];
        IF p_values[i] IS NULL THEN
            set_list := set_list || ', ' || col || ' = NULL';
        ELSIF col = ANY(jsonb_cols) THEN
            set_list := set_list || ', ' || col || ' = ' || quote_literal(p_values[i]) || '::jsonb';
        ELSIF col = ANY(bool_cols) THEN
            set_list := set_list || ', ' || col || ' = ' || p_values[i] || '::boolean';
        ELSIF col = ANY(int_cols) THEN
            set_list := set_list || ', ' || col || ' = ' || p_values[i] || '::integer';
        ELSE
            set_list := set_list || ', ' || col || ' = ' || quote_literal(p_values[i]);
        END IF;
    END LOOP;

    EXECUTE format(
        'UPDATE sessions SET %s WHERE session_id = %s',
        set_list, quote_literal(p_session_id)
    );
END;
$$;

-- 2. session_get
CREATE OR REPLACE FUNCTION session_get(
    p_session_id TEXT
) RETURNS SETOF sessions LANGUAGE sql STABLE AS $$
    SELECT * FROM sessions WHERE session_id = p_session_id;
$$;

-- 3. session_get_all
CREATE OR REPLACE FUNCTION session_get_all(
    p_filters JSONB DEFAULT NULL,
    p_limit   INTEGER DEFAULT NULL,
    p_offset  INTEGER DEFAULT NULL
) RETURNS SETOF sessions LANGUAGE plpgsql STABLE AS $$
DECLARE
    q TEXT := 'SELECT s.* FROM sessions s LEFT JOIN folders f ON s.folder_id = f.id WHERE TRUE';
BEGIN
    IF p_filters IS NOT NULL AND p_filters ? 'session_type' THEN
        q := q || ' AND session_type = ' || quote_literal(p_filters->>'session_type');
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'folder_id' THEN
        q := q || ' AND s.folder_id = ' || quote_literal(p_filters->>'folder_id');
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'node_id' THEN
        q := q || ' AND node_id = ' || quote_literal(p_filters->>'node_id');
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'status' THEN
        IF jsonb_typeof(p_filters->'status') = 'array' THEN
            q := q || ' AND status IN (' ||
                (SELECT string_agg(quote_literal(elem), ', ')
                 FROM jsonb_array_elements_text(p_filters->'status') AS elem) || ')';
        ELSE
            q := q || ' AND status = ' || quote_literal(p_filters->>'status');
        END IF;
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'feed_only' AND (p_filters->>'feed_only')::boolean THEN
        q := q || ' AND (s.folder_id IS NULL OR COALESCE(f.settings->>''excludeFromFeed'', ''false'') != ''true'')';
        q := q || ' AND COALESCE(session_type, ''claude'') != ''llm''';
    END IF;

    q := q || ' ORDER BY s.updated_at DESC, s.session_id DESC';

    IF p_limit IS NOT NULL THEN
        q := q || ' LIMIT ' || p_limit;
    END IF;
    IF p_offset IS NOT NULL AND p_offset > 0 THEN
        q := q || ' OFFSET ' || p_offset;
    END IF;

    RETURN QUERY EXECUTE q;
END;
$$;

-- 4. session_count
CREATE OR REPLACE FUNCTION session_count(
    p_filters JSONB DEFAULT NULL
) RETURNS BIGINT LANGUAGE plpgsql STABLE AS $$
DECLARE
    q TEXT := 'SELECT COUNT(*) FROM sessions s LEFT JOIN folders f ON s.folder_id = f.id WHERE TRUE';
    result BIGINT;
BEGIN
    IF p_filters IS NOT NULL AND p_filters ? 'session_type' THEN
        q := q || ' AND session_type = ' || quote_literal(p_filters->>'session_type');
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'folder_id' THEN
        q := q || ' AND s.folder_id = ' || quote_literal(p_filters->>'folder_id');
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'node_id' THEN
        q := q || ' AND node_id = ' || quote_literal(p_filters->>'node_id');
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'status' THEN
        IF jsonb_typeof(p_filters->'status') = 'array' THEN
            q := q || ' AND status IN (' ||
                (SELECT string_agg(quote_literal(elem), ', ')
                 FROM jsonb_array_elements_text(p_filters->'status') AS elem) || ')';
        ELSE
            q := q || ' AND status = ' || quote_literal(p_filters->>'status');
        END IF;
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'feed_only' AND (p_filters->>'feed_only')::boolean THEN
        q := q || ' AND (s.folder_id IS NULL OR COALESCE(f.settings->>''excludeFromFeed'', ''false'') != ''true'')';
        q := q || ' AND COALESCE(session_type, ''claude'') != ''llm''';
    END IF;

    EXECUTE q INTO result;
    RETURN result;
END;
$$;

-- 5. session_delete
CREATE OR REPLACE FUNCTION session_delete(
    p_session_id TEXT
) RETURNS void LANGUAGE sql AS $$
    DELETE FROM claude_transcript_entries
    WHERE session_id = p_session_id
       OR session_id = (
            SELECT claude_session_id
            FROM sessions
            WHERE sessions.session_id = p_session_id
       );

    DELETE FROM sessions WHERE session_id = p_session_id;
$$;

-- 6. session_append_metadata
CREATE OR REPLACE FUNCTION session_append_metadata(
    p_session_id      TEXT,
    p_metadata_json   TEXT,
    p_event_type      TEXT,
    p_event_payload   TEXT,
    p_searchable_text TEXT,
    p_now             TIMESTAMPTZ
) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
    v_event_id INTEGER;
BEGIN
    -- 행 잠금
    PERFORM session_id FROM sessions WHERE session_id = p_session_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Session not found: %', p_session_id;
    END IF;

    -- metadata JSONB 배열 append
    UPDATE sessions
    SET metadata = COALESCE(metadata, '[]'::jsonb) || p_metadata_json::jsonb,
        updated_at = p_now
    WHERE session_id = p_session_id;

    -- 이벤트 삽입
    INSERT INTO events (id, session_id, event_type, payload, searchable_text, created_at)
    VALUES (
        (SELECT COALESCE(MAX(id), 0) + 1 FROM events WHERE session_id = p_session_id),
        p_session_id, p_event_type, p_event_payload::jsonb, p_searchable_text, p_now
    ) RETURNING id INTO v_event_id;

    -- last_event_id 갱신
    UPDATE sessions SET last_event_id = v_event_id WHERE session_id = p_session_id;

    RETURN v_event_id;
END;
$$;

-- 7. session_update_last_message
CREATE OR REPLACE FUNCTION session_update_last_message(
    p_session_id   TEXT,
    p_last_message TEXT,
    p_updated_at   TIMESTAMPTZ
) RETURNS void LANGUAGE sql AS $$
    UPDATE sessions
    SET last_message = p_last_message::jsonb, updated_at = p_updated_at
    WHERE session_id = p_session_id;
$$;

-- 8. session_update_read_position
CREATE OR REPLACE FUNCTION session_update_read_position(
    p_session_id         TEXT,
    p_last_read_event_id INTEGER
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
    result TEXT;
BEGIN
    UPDATE sessions SET last_read_event_id = p_last_read_event_id
    WHERE session_id = p_session_id;
    GET DIAGNOSTICS result = ROW_COUNT;
    RETURN 'UPDATE ' || result;
END;
$$;

-- 9. session_get_read_position
CREATE OR REPLACE FUNCTION session_get_read_position(
    p_session_id TEXT
) RETURNS TABLE(last_event_id INTEGER, last_read_event_id INTEGER)
LANGUAGE sql STABLE AS $$
    SELECT last_event_id, last_read_event_id
    FROM sessions WHERE session_id = p_session_id;
$$;

-- 10. session_rename
CREATE OR REPLACE FUNCTION session_rename(
    p_session_id   TEXT,
    p_display_name TEXT
) RETURNS void LANGUAGE sql AS $$
    UPDATE sessions SET display_name = p_display_name WHERE session_id = p_session_id;
$$;

-- 11. session_assign_folder
CREATE OR REPLACE FUNCTION session_assign_folder(
    p_session_id TEXT,
    p_folder_id  TEXT
) RETURNS void LANGUAGE sql AS $$
    UPDATE sessions SET folder_id = p_folder_id WHERE session_id = p_session_id;
$$;

-- Graceful Shutdown -----------------------------------------------

-- 12. shutdown_mark_running
CREATE OR REPLACE FUNCTION shutdown_mark_running(
    p_session_ids TEXT[] DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF p_session_ids IS NULL THEN
        UPDATE sessions SET was_running_at_shutdown = TRUE WHERE status = 'running';
    ELSIF array_length(p_session_ids, 1) IS NULL THEN
        -- 빈 배열: no-op
        RETURN;
    ELSE
        UPDATE sessions SET was_running_at_shutdown = TRUE
        WHERE session_id = ANY(p_session_ids);
    END IF;
END;
$$;

-- 13. shutdown_get_sessions
CREATE OR REPLACE FUNCTION shutdown_get_sessions(p_node_id TEXT DEFAULT NULL)
RETURNS SETOF sessions LANGUAGE sql STABLE AS $$
    SELECT * FROM sessions
    WHERE was_running_at_shutdown = TRUE
    AND (p_node_id IS NULL OR node_id = p_node_id);
$$;

-- 14. shutdown_clear_flags
CREATE OR REPLACE FUNCTION shutdown_clear_flags(p_node_id TEXT DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
    UPDATE sessions SET was_running_at_shutdown = FALSE
    WHERE was_running_at_shutdown = TRUE
    AND (p_node_id IS NULL OR node_id = p_node_id);
$$;

-- 15. shutdown_repair_read_positions
CREATE OR REPLACE FUNCTION shutdown_repair_read_positions()
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
    v_count INTEGER;
BEGIN
    UPDATE sessions
    SET last_read_event_id = last_event_id
    WHERE status != 'running'
      AND last_read_event_id < last_event_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- 이벤트 도메인 ---------------------------------------------------

-- 16. event_append
DROP FUNCTION IF EXISTS event_append(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION event_append(
    p_session_id      TEXT,
    p_event_type      TEXT,
    p_payload         TEXT,
    p_searchable_text TEXT,
    p_created_at      TIMESTAMPTZ,
    p_dedupe_key      TEXT DEFAULT NULL
) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
    v_event_id INTEGER;
    v_payload  JSONB := p_payload::jsonb;
    v_parent   INTEGER;
BEGIN
    -- payload에서 parent_event_id 추출. 다음 케이스는 모두 NULL로 떨어진다:
    --   1) 키 자체가 없는 경우
    --   2) 비정수 문자열 (tool_use_id 'toolu_...', UUID 등 — 의미가 다른 레거시 키)
    --   3) INTEGER 범위(1..2147483647) 밖의 값 (timestamp 등 잘못 들어간 값)
    -- 길이 가드 ^\d{1,10}$로 BIGINT 캐스트 자체의 overflow 차단, BIGINT 범위 비교로 INT 한계 검증.
    -- events.id가 INTEGER SERIAL이므로 진짜 ancestor의 ID는 항상 1..INT_MAX 범위에 있음.
    v_parent := CASE
        WHEN v_payload->>'parent_event_id' ~ '^\d{1,10}$'
             AND (v_payload->>'parent_event_id')::BIGINT BETWEEN 1 AND 2147483647
        THEN (v_payload->>'parent_event_id')::INTEGER
        ELSE NULL
    END;
    IF v_parent IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM events e
        WHERE e.session_id = p_session_id
          AND e.id = v_parent
    ) THEN
        v_parent := NULL;
    END IF;

    -- 행 잠금으로 동시 append 직렬화
    PERFORM session_id FROM sessions WHERE session_id = p_session_id FOR UPDATE;

    IF p_dedupe_key IS NOT NULL THEN
        SELECT e.id INTO v_event_id
        FROM events e
        WHERE e.session_id = p_session_id
          AND e.dedupe_key = p_dedupe_key
        LIMIT 1;

        IF v_event_id IS NOT NULL THEN
            UPDATE sessions
            SET last_event_id = GREATEST(COALESCE(last_event_id, 0), v_event_id)
            WHERE session_id = p_session_id;
            RETURN v_event_id;
        END IF;
    END IF;

    INSERT INTO events (id, session_id, event_type, payload, searchable_text,
                        created_at, parent_event_id, dedupe_key)
    VALUES (
        (SELECT COALESCE(MAX(id), 0) + 1 FROM events WHERE session_id = p_session_id),
        p_session_id, p_event_type, v_payload, p_searchable_text,
        p_created_at, v_parent, p_dedupe_key
    ) RETURNING id INTO v_event_id;

    UPDATE sessions SET last_event_id = v_event_id WHERE session_id = p_session_id;

    RETURN v_event_id;
END;
$$;

-- 17. event_read
CREATE OR REPLACE FUNCTION event_read(
    p_session_id   TEXT,
    p_after_id     INTEGER DEFAULT 0,
    p_limit        INTEGER DEFAULT NULL,
    p_event_types  TEXT[] DEFAULT NULL
) RETURNS TABLE(
    id              INTEGER,
    session_id      TEXT,
    event_type      TEXT,
    payload         JSONB,
    searchable_text TEXT,
    created_at      TIMESTAMPTZ
) LANGUAGE sql STABLE AS $$
    SELECT e.id, e.session_id, e.event_type, e.payload, e.searchable_text, e.created_at
    FROM events e
    WHERE e.session_id = p_session_id
      AND e.id > p_after_id
      AND (p_event_types IS NULL OR e.event_type = ANY(p_event_types))
    ORDER BY e.id
    LIMIT p_limit;
$$;

-- 18. event_read_one
DROP FUNCTION IF EXISTS event_read_one(TEXT, INTEGER);

CREATE OR REPLACE FUNCTION event_read_one(
    p_session_id TEXT,
    p_event_id   INTEGER
) RETURNS TABLE(
    id              INTEGER,
    session_id      TEXT,
    event_type      TEXT,
    parent_event_id INTEGER,
    payload         JSONB,
    searchable_text TEXT,
    created_at      TIMESTAMPTZ
) LANGUAGE sql STABLE AS $$
    SELECT id, session_id, event_type, parent_event_id, payload, searchable_text, created_at
    FROM events
    WHERE session_id = p_session_id AND id = p_event_id;
$$;

-- 19. event_stream_raw
CREATE OR REPLACE FUNCTION event_stream_raw(
    p_session_id TEXT,
    p_after_id   INTEGER DEFAULT 0
) RETURNS TABLE(
    id           INTEGER,
    event_type   TEXT,
    payload_text TEXT
) LANGUAGE sql STABLE AS $$
    SELECT id, event_type, payload::text AS payload_text
    FROM events
    WHERE session_id = p_session_id AND id > p_after_id
    ORDER BY id;
$$;

-- 20. event_count
CREATE OR REPLACE FUNCTION event_count(
    p_session_id TEXT
) RETURNS BIGINT LANGUAGE sql STABLE AS $$
    SELECT COUNT(*) FROM events WHERE session_id = p_session_id;
$$;

-- 20s. Supervisor durable queue -------------------------------------

CREATE OR REPLACE FUNCTION supervisor_source_cursor_recompute(
    p_source_node       TEXT,
    p_source_session_id TEXT
) RETURNS TABLE(
    source_node           TEXT,
    source_session_id     TEXT,
    contiguous_upto       INTEGER,
    highest_seen_event_id INTEGER,
    gap_start             INTEGER,
    gap_end               INTEGER,
    updated_at            TIMESTAMPTZ
) LANGUAGE plpgsql AS $$
DECLARE
    v_start      INTEGER;
    v_contiguous INTEGER;
    v_highest    INTEGER;
    v_next_seen  INTEGER;
    v_gap_start  INTEGER;
    v_gap_end    INTEGER;
BEGIN
    INSERT INTO supervisor_source_cursors (source_node, source_session_id)
    VALUES (p_source_node, p_source_session_id)
    ON CONFLICT ON CONSTRAINT supervisor_source_cursors_pkey DO NOTHING;

    SELECT c.contiguous_upto
    INTO v_start
    FROM supervisor_source_cursors c
    WHERE c.source_node = p_source_node
      AND c.source_session_id = p_source_session_id
    FOR UPDATE;

    WITH ordered AS (
        SELECT
            e.source_event_id,
            ROW_NUMBER() OVER (ORDER BY e.source_event_id)::INTEGER AS rn
        FROM supervisor_events e
        WHERE e.source_node = p_source_node
          AND e.source_session_id = p_source_session_id
          AND e.source_event_id > v_start
    ),
    contiguous AS (
        SELECT source_event_id
        FROM ordered
        WHERE source_event_id = v_start + rn
    )
    SELECT COALESCE(MAX(source_event_id), v_start)
    INTO v_contiguous
    FROM contiguous;

    SELECT COALESCE(MAX(e.source_event_id), 0)
    INTO v_highest
    FROM supervisor_events e
    WHERE e.source_node = p_source_node
      AND e.source_session_id = p_source_session_id;

    IF v_highest > v_contiguous THEN
        SELECT MIN(e.source_event_id)
        INTO v_next_seen
        FROM supervisor_events e
        WHERE e.source_node = p_source_node
          AND e.source_session_id = p_source_session_id
          AND e.source_event_id > v_contiguous;
        v_gap_start := v_contiguous + 1;
        v_gap_end := v_next_seen - 1;
    ELSE
        v_gap_start := NULL;
        v_gap_end := NULL;
    END IF;

    UPDATE supervisor_source_cursors c
    SET contiguous_upto = v_contiguous,
        highest_seen_event_id = v_highest,
        gap_start = v_gap_start,
        gap_end = v_gap_end,
        updated_at = NOW()
    WHERE c.source_node = p_source_node
      AND c.source_session_id = p_source_session_id;

    RETURN QUERY
    SELECT
        c.source_node,
        c.source_session_id,
        c.contiguous_upto,
        c.highest_seen_event_id,
        c.gap_start,
        c.gap_end,
        c.updated_at
    FROM supervisor_source_cursors c
    WHERE c.source_node = p_source_node
      AND c.source_session_id = p_source_session_id;
END;
$$;

CREATE OR REPLACE FUNCTION supervisor_event_append(
    p_source_node       TEXT,
    p_source_session_id TEXT,
    p_source_event_id   INTEGER,
    p_event_type        TEXT,
    p_payload           TEXT,
    p_created_at        TIMESTAMPTZ
) RETURNS TABLE(
    "offset"              BIGINT,
    inserted              BOOLEAN,
    contiguous_upto       INTEGER,
    highest_seen_event_id INTEGER,
    gap_start             INTEGER,
    gap_end               INTEGER
) LANGUAGE plpgsql AS $$
DECLARE
    v_offset   BIGINT;
    v_inserted BOOLEAN;
    v_payload  JSONB := COALESCE(NULLIF(p_payload, ''), '{}')::jsonb;
    v_cursor   RECORD;
BEGIN
    IF p_source_event_id <= 0 THEN
        RAISE EXCEPTION 'source_event_id must be positive: %', p_source_event_id;
    END IF;

    INSERT INTO supervisor_source_cursors (source_node, source_session_id)
    VALUES (p_source_node, p_source_session_id)
    ON CONFLICT ON CONSTRAINT supervisor_source_cursors_pkey DO NOTHING;

    PERFORM 1
    FROM supervisor_source_cursors c
    WHERE c.source_node = p_source_node
      AND c.source_session_id = p_source_session_id
    FOR UPDATE;

    INSERT INTO supervisor_events (
        source_node,
        source_session_id,
        source_event_id,
        event_type,
        payload,
        created_at
    )
    VALUES (
        p_source_node,
        p_source_session_id,
        p_source_event_id,
        p_event_type,
        v_payload,
        p_created_at
    )
    ON CONFLICT ON CONSTRAINT supervisor_events_source_key DO NOTHING
    RETURNING supervisor_events."offset" INTO v_offset;

    IF v_offset IS NULL THEN
        v_inserted := FALSE;
        SELECT e."offset"
        INTO v_offset
        FROM supervisor_events e
        WHERE e.source_node = p_source_node
          AND e.source_session_id = p_source_session_id
          AND e.source_event_id = p_source_event_id;
    ELSE
        v_inserted := TRUE;
    END IF;

    SELECT *
    INTO v_cursor
    FROM supervisor_source_cursor_recompute(p_source_node, p_source_session_id);

    RETURN QUERY SELECT
        v_offset,
        v_inserted,
        v_cursor.contiguous_upto,
        v_cursor.highest_seen_event_id,
        v_cursor.gap_start,
        v_cursor.gap_end;
END;
$$;

CREATE OR REPLACE FUNCTION supervisor_event_read_after(
    p_after_offset BIGINT DEFAULT 0,
    p_limit        INTEGER DEFAULT 100
) RETURNS TABLE(
    "offset"          BIGINT,
    source_node       TEXT,
    source_session_id TEXT,
    source_event_id   INTEGER,
    event_type        TEXT,
    payload           JSONB,
    created_at        TIMESTAMPTZ,
    inserted_at       TIMESTAMPTZ
) LANGUAGE sql STABLE AS $$
    SELECT
        e."offset",
        e.source_node,
        e.source_session_id,
        e.source_event_id,
        e.event_type,
        e.payload,
        e.created_at,
        e.inserted_at
    FROM supervisor_events e
    WHERE e."offset" > p_after_offset
    ORDER BY e."offset"
    LIMIT p_limit;
$$;

CREATE OR REPLACE FUNCTION supervisor_source_cursor_get(
    p_source_node       TEXT,
    p_source_session_id TEXT
) RETURNS TABLE(
    source_node           TEXT,
    source_session_id     TEXT,
    contiguous_upto       INTEGER,
    highest_seen_event_id INTEGER,
    gap_start             INTEGER,
    gap_end               INTEGER,
    updated_at            TIMESTAMPTZ
) LANGUAGE sql STABLE AS $$
    SELECT
        c.source_node,
        c.source_session_id,
        c.contiguous_upto,
        c.highest_seen_event_id,
        c.gap_start,
        c.gap_end,
        c.updated_at
    FROM supervisor_source_cursors c
    WHERE c.source_node = p_source_node
      AND c.source_session_id = p_source_session_id;
$$;

CREATE OR REPLACE FUNCTION supervisor_source_cursor_set(
    p_source_node           TEXT,
    p_source_session_id     TEXT,
    p_contiguous_upto       INTEGER,
    p_highest_seen_event_id INTEGER,
    p_gap_start             INTEGER DEFAULT NULL,
    p_gap_end               INTEGER DEFAULT NULL
) RETURNS TABLE(
    source_node           TEXT,
    source_session_id     TEXT,
    contiguous_upto       INTEGER,
    highest_seen_event_id INTEGER,
    gap_start             INTEGER,
    gap_end               INTEGER,
    updated_at            TIMESTAMPTZ
) LANGUAGE plpgsql AS $$
BEGIN
    IF p_contiguous_upto < 0 OR p_highest_seen_event_id < 0 THEN
        RAISE EXCEPTION 'cursor values must be non-negative';
    END IF;
    IF p_highest_seen_event_id < p_contiguous_upto THEN
        RAISE EXCEPTION 'highest_seen_event_id must be >= contiguous_upto';
    END IF;

    INSERT INTO supervisor_source_cursors (
        source_node,
        source_session_id,
        contiguous_upto,
        highest_seen_event_id,
        gap_start,
        gap_end,
        updated_at
    )
    VALUES (
        p_source_node,
        p_source_session_id,
        p_contiguous_upto,
        p_highest_seen_event_id,
        p_gap_start,
        p_gap_end,
        NOW()
    )
    ON CONFLICT ON CONSTRAINT supervisor_source_cursors_pkey DO UPDATE
    SET contiguous_upto = EXCLUDED.contiguous_upto,
        highest_seen_event_id = EXCLUDED.highest_seen_event_id,
        gap_start = EXCLUDED.gap_start,
        gap_end = EXCLUDED.gap_end,
        updated_at = NOW();

    RETURN QUERY
    SELECT *
    FROM supervisor_source_cursor_get(p_source_node, p_source_session_id);
END;
$$;

CREATE OR REPLACE FUNCTION supervisor_consumer_cursor_get(
    p_supervisor_id TEXT
) RETURNS BIGINT LANGUAGE sql STABLE AS $$
    SELECT COALESCE((
        SELECT c.cursor_offset
        FROM supervisor_consumers c
        WHERE c.supervisor_id = p_supervisor_id
    ), 0)::BIGINT;
$$;

CREATE OR REPLACE FUNCTION supervisor_consumer_cursor_set(
    p_supervisor_id TEXT,
    p_cursor_offset BIGINT
) RETURNS BIGINT LANGUAGE plpgsql AS $$
BEGIN
    IF p_cursor_offset < 0 THEN
        RAISE EXCEPTION 'cursor_offset must be non-negative: %', p_cursor_offset;
    END IF;

    INSERT INTO supervisor_consumers (supervisor_id, cursor_offset, updated_at)
    VALUES (p_supervisor_id, p_cursor_offset, NOW())
    ON CONFLICT ON CONSTRAINT supervisor_consumers_pkey DO UPDATE
    SET cursor_offset = EXCLUDED.cursor_offset,
        updated_at = NOW();

    RETURN p_cursor_offset;
END;
$$;

DROP FUNCTION IF EXISTS supervisor_registry_upsert(
    TEXT,
    TEXT,
    BIGINT,
    BIGINT,
    TEXT,
    BIGINT,
    INTEGER,
    TIMESTAMPTZ
);
DROP FUNCTION IF EXISTS supervisor_registry_touch(TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS supervisor_registry_record_usage_delta(TEXT, BIGINT, INTEGER, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS supervisor_registry_set_wake_dispatch_state(
    TEXT,
    TEXT,
    TEXT,
    INTEGER,
    TEXT,
    TIMESTAMPTZ
);
DROP FUNCTION IF EXISTS supervisor_registry_get(TEXT);
DROP FUNCTION IF EXISTS supervisor_registry_list();

CREATE OR REPLACE FUNCTION supervisor_registry_upsert(
    p_role               TEXT,
    p_active_session_id  TEXT,
    p_epoch              BIGINT,
    p_cursor_offset      BIGINT,
    p_handover_state     TEXT,
    p_cumulative_tokens  BIGINT,
    p_compaction_count   INTEGER,
    p_last_seen_at       TIMESTAMPTZ
) RETURNS TABLE(
    role               TEXT,
    active_session_id  TEXT,
    epoch              BIGINT,
    cursor_offset      BIGINT,
    handover_state     TEXT,
    cumulative_tokens  BIGINT,
    compaction_count   INTEGER,
    last_seen_at       TIMESTAMPTZ,
    wake_dispatch_state TEXT,
    wake_last_signature TEXT,
    wake_repeat_count   INTEGER,
    wake_blocked_reason TEXT,
    wake_blocked_at     TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ
) LANGUAGE plpgsql AS $$
BEGIN
    IF p_epoch < 0 OR p_cursor_offset < 0 OR p_cumulative_tokens < 0 OR p_compaction_count < 0 THEN
        RAISE EXCEPTION 'epoch, cursor_offset, cumulative_tokens, and compaction_count must be non-negative';
    END IF;

    INSERT INTO supervisor_registry (
        role,
        active_session_id,
        epoch,
        cursor_offset,
        handover_state,
        cumulative_tokens,
        compaction_count,
        last_seen_at,
        updated_at
    )
    VALUES (
        p_role,
        p_active_session_id,
        p_epoch,
        p_cursor_offset,
        p_handover_state,
        p_cumulative_tokens,
        p_compaction_count,
        p_last_seen_at,
        NOW()
    )
    ON CONFLICT ON CONSTRAINT supervisor_registry_pkey DO UPDATE
    SET active_session_id = EXCLUDED.active_session_id,
        epoch = EXCLUDED.epoch,
        cursor_offset = EXCLUDED.cursor_offset,
        handover_state = EXCLUDED.handover_state,
        cumulative_tokens = EXCLUDED.cumulative_tokens,
        compaction_count = EXCLUDED.compaction_count,
        last_seen_at = EXCLUDED.last_seen_at,
        updated_at = NOW();

    RETURN QUERY
    SELECT *
    FROM supervisor_registry_get(p_role);
END;
$$;

CREATE OR REPLACE FUNCTION supervisor_registry_get(
    p_role TEXT
) RETURNS TABLE(
    role               TEXT,
    active_session_id  TEXT,
    epoch              BIGINT,
    cursor_offset      BIGINT,
    handover_state     TEXT,
    cumulative_tokens  BIGINT,
    compaction_count   INTEGER,
    last_seen_at       TIMESTAMPTZ,
    wake_dispatch_state TEXT,
    wake_last_signature TEXT,
    wake_repeat_count   INTEGER,
    wake_blocked_reason TEXT,
    wake_blocked_at     TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ
) LANGUAGE sql STABLE AS $$
    SELECT
        r.role,
        r.active_session_id,
        r.epoch,
        r.cursor_offset,
        r.handover_state,
        r.cumulative_tokens,
        r.compaction_count,
        r.last_seen_at,
        r.wake_dispatch_state,
        r.wake_last_signature,
        r.wake_repeat_count,
        r.wake_blocked_reason,
        r.wake_blocked_at,
        r.created_at,
        r.updated_at
    FROM supervisor_registry r
    WHERE r.role = p_role;
$$;

CREATE OR REPLACE FUNCTION supervisor_registry_list()
RETURNS TABLE(
    role               TEXT,
    active_session_id  TEXT,
    epoch              BIGINT,
    cursor_offset      BIGINT,
    handover_state     TEXT,
    cumulative_tokens  BIGINT,
    compaction_count   INTEGER,
    last_seen_at       TIMESTAMPTZ,
    wake_dispatch_state TEXT,
    wake_last_signature TEXT,
    wake_repeat_count   INTEGER,
    wake_blocked_reason TEXT,
    wake_blocked_at     TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ
) LANGUAGE sql STABLE AS $$
    SELECT
        r.role,
        r.active_session_id,
        r.epoch,
        r.cursor_offset,
        r.handover_state,
        r.cumulative_tokens,
        r.compaction_count,
        r.last_seen_at,
        r.wake_dispatch_state,
        r.wake_last_signature,
        r.wake_repeat_count,
        r.wake_blocked_reason,
        r.wake_blocked_at,
        r.created_at,
        r.updated_at
    FROM supervisor_registry r
    ORDER BY r.role;
$$;

CREATE OR REPLACE FUNCTION supervisor_registry_touch(
    p_role         TEXT,
    p_last_seen_at TIMESTAMPTZ
) RETURNS TABLE(
    role               TEXT,
    active_session_id  TEXT,
    epoch              BIGINT,
    cursor_offset      BIGINT,
    handover_state     TEXT,
    cumulative_tokens  BIGINT,
    compaction_count   INTEGER,
    last_seen_at       TIMESTAMPTZ,
    wake_dispatch_state TEXT,
    wake_last_signature TEXT,
    wake_repeat_count   INTEGER,
    wake_blocked_reason TEXT,
    wake_blocked_at     TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ
) LANGUAGE plpgsql AS $$
BEGIN
    UPDATE supervisor_registry r
    SET last_seen_at = p_last_seen_at,
        updated_at = NOW()
    WHERE r.role = p_role;

    RETURN QUERY
    SELECT *
    FROM supervisor_registry_get(p_role);
END;
$$;

CREATE OR REPLACE FUNCTION supervisor_registry_set_wake_dispatch_state(
    p_role                TEXT,
    p_wake_dispatch_state TEXT,
    p_wake_last_signature TEXT DEFAULT NULL,
    p_wake_repeat_count   INTEGER DEFAULT 0,
    p_wake_blocked_reason TEXT DEFAULT NULL,
    p_wake_blocked_at     TIMESTAMPTZ DEFAULT NULL
) RETURNS TABLE(
    role               TEXT,
    active_session_id  TEXT,
    epoch              BIGINT,
    cursor_offset      BIGINT,
    handover_state     TEXT,
    cumulative_tokens  BIGINT,
    compaction_count   INTEGER,
    last_seen_at       TIMESTAMPTZ,
    wake_dispatch_state TEXT,
    wake_last_signature TEXT,
    wake_repeat_count   INTEGER,
    wake_blocked_reason TEXT,
    wake_blocked_at     TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ
) LANGUAGE plpgsql AS $$
BEGIN
    IF p_wake_dispatch_state NOT IN ('active', 'retrying', 'blocked') THEN
        RAISE EXCEPTION 'invalid supervisor wake dispatch state: %', p_wake_dispatch_state;
    END IF;
    IF p_wake_repeat_count < 0 THEN
        RAISE EXCEPTION 'wake_repeat_count must be non-negative';
    END IF;

    UPDATE supervisor_registry r
    SET wake_dispatch_state = p_wake_dispatch_state,
        wake_last_signature = p_wake_last_signature,
        wake_repeat_count = p_wake_repeat_count,
        wake_blocked_reason = CASE
            WHEN p_wake_dispatch_state = 'blocked' THEN p_wake_blocked_reason
            ELSE NULL
        END,
        wake_blocked_at = CASE
            WHEN p_wake_dispatch_state = 'blocked' THEN COALESCE(p_wake_blocked_at, NOW())
            ELSE NULL
        END,
        updated_at = NOW()
    WHERE r.role = p_role;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'supervisor registry not found: %', p_role;
    END IF;

    RETURN QUERY
    SELECT *
    FROM supervisor_registry_get(p_role);
END;
$$;

CREATE OR REPLACE FUNCTION supervisor_registry_record_usage_delta(
    p_role             TEXT,
    p_token_delta      BIGINT,
    p_compaction_delta INTEGER DEFAULT 0,
    p_last_seen_at     TIMESTAMPTZ DEFAULT NULL
) RETURNS TABLE(
    role               TEXT,
    active_session_id  TEXT,
    epoch              BIGINT,
    cursor_offset      BIGINT,
    handover_state     TEXT,
    cumulative_tokens  BIGINT,
    compaction_count   INTEGER,
    last_seen_at       TIMESTAMPTZ,
    wake_dispatch_state TEXT,
    wake_last_signature TEXT,
    wake_repeat_count   INTEGER,
    wake_blocked_reason TEXT,
    wake_blocked_at     TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ
) LANGUAGE plpgsql AS $$
BEGIN
    IF p_token_delta < 0 OR p_compaction_delta < 0 THEN
        RAISE EXCEPTION 'usage deltas must be non-negative';
    END IF;

    UPDATE supervisor_registry r
    SET cumulative_tokens = r.cumulative_tokens + p_token_delta,
        compaction_count = r.compaction_count + p_compaction_delta,
        last_seen_at = COALESCE(p_last_seen_at, r.last_seen_at),
        updated_at = NOW()
    WHERE r.role = p_role;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'supervisor registry not found: %', p_role;
    END IF;

    RETURN QUERY
    SELECT *
    FROM supervisor_registry_get(p_role);
END;
$$;

CREATE OR REPLACE FUNCTION supervisor_registry_delete(
    p_role TEXT
) RETURNS BOOLEAN LANGUAGE sql AS $$
    WITH deleted AS (
        DELETE FROM supervisor_registry
        WHERE role = p_role
        RETURNING 1
    )
    SELECT EXISTS(SELECT 1 FROM deleted);
$$;

-- 20b. events_viewport — 가상 Y축 범위 [y_min, y_max]와 겹치는 이벤트 조회
--
-- 전제 조건 (§9 참조):
--   - session_id에 parent_event_id IS NULL인 이벤트는 정확히 1개(단일 루트)여야 한다.
--   - subtree_height는 미리 백필되어 있어야 한다(backfill_subtree_height.py).
--   - 여러 루트가 있으면 y_start가 루트별로 독립적으로 시작하여 구간이 겹치거나 어긋난다.
--     Python 측 read_viewport()가 이 경우 경고 로그를 남긴다.
--
-- y_start/y_end는 1-based 가상 Y축 좌표이며, 자식들의 y_start는
-- (부모 y_start + 1) + 형제 중 id가 더 작은 자식들의 subtree_height 합으로 계산한다.
-- depth는 루트=0부터 계단식 증가.
CREATE OR REPLACE FUNCTION events_viewport(
    p_session_id TEXT,
    p_y_min BIGINT,
    p_y_max BIGINT
) RETURNS TABLE (
    id              INTEGER,
    parent_event_id INTEGER,
    event_type      TEXT,
    depth           INTEGER,
    y_start         BIGINT,
    y_end           BIGINT,
    payload         JSONB
) LANGUAGE sql STABLE AS $$
    WITH RECURSIVE tree AS (
        SELECT e.id, e.parent_event_id, e.event_type, e.payload, e.subtree_height,
               0::INTEGER AS depth,
               1::BIGINT AS y_start
        FROM events e
        WHERE e.session_id = p_session_id AND e.parent_event_id IS NULL
        UNION ALL
        SELECT c.id, c.parent_event_id, c.event_type, c.payload, c.subtree_height,
               t.depth + 1,
               t.y_start + 1 + COALESCE((
                   SELECT SUM(s.subtree_height)
                   FROM events s
                   WHERE s.session_id = p_session_id
                     AND s.parent_event_id = c.parent_event_id
                     AND s.id < c.id
               ), 0)
        FROM events c
        JOIN tree t ON c.parent_event_id = t.id
        WHERE c.session_id = p_session_id
    )
    SELECT id, parent_event_id, event_type, depth, y_start,
           y_start + subtree_height - 1 AS y_end, payload
    FROM tree
    WHERE NOT (y_start + subtree_height - 1 < p_y_min OR y_start > p_y_max)
    ORDER BY y_start;
$$;

-- 21. event_search
DROP FUNCTION IF EXISTS event_search(TEXT, TEXT[], INTEGER);
DROP FUNCTION IF EXISTS event_search(TEXT, TEXT[], INTEGER, TEXT[]);
CREATE OR REPLACE FUNCTION event_search(
    p_query       TEXT,
    p_session_ids TEXT[] DEFAULT NULL,
    p_limit       INTEGER DEFAULT 50,
    p_event_types TEXT[] DEFAULT NULL
) RETURNS TABLE(
    id              INTEGER,
    session_id      TEXT,
    event_type      TEXT,
    payload         JSONB,
    searchable_text TEXT,
    created_at      TIMESTAMPTZ,
    score           FLOAT
) LANGUAGE sql STABLE AS $$
    WITH query_terms AS (
        SELECT DISTINCT term
        FROM unnest(event_search_tokenize(p_query)) AS token(term)
    ),
    korean_prefix_terms AS (
        SELECT DISTINCT term, left(term, 3) AS prefix
        FROM query_terms
        WHERE term ~ '[가-힣]'
          AND length(term) >= 3
    ),
    corpus AS (
        SELECT
            total_docs::FLOAT AS total_docs,
            CASE
                WHEN total_docs > 0 THEN total_doc_len::FLOAT / total_docs::FLOAT
                ELSE 0
            END AS avg_doc_len
        FROM event_search_corpus_stats
        WHERE id = TRUE
    ),
    doc_freq AS (
        SELECT t.term, COUNT(DISTINCT (t.session_id, t.event_id))::FLOAT AS doc_count
        FROM query_terms q
        JOIN event_search_terms t ON t.term = q.term
        GROUP BY t.term
    ),
    scored AS (
        SELECT
            e.id,
            e.session_id,
            e.event_type,
            e.payload,
            e.searchable_text,
            e.created_at,
            SUM(
                ln(1 + ((c.total_docs - df.doc_count + 0.5) / (df.doc_count + 0.5))) *
                (
                    (t.term_freq * 2.2) /
                    (
                        t.term_freq +
                        1.2 * (
                            0.25 +
                            0.75 * (t.doc_len::FLOAT / GREATEST(c.avg_doc_len, 1))
                        )
                    )
                )
            )::FLOAT AS score
        FROM query_terms q
        JOIN event_search_terms t ON t.term = q.term
        JOIN doc_freq df ON df.term = t.term
        JOIN corpus c ON c.total_docs > 0
        JOIN events e
          ON e.session_id = t.session_id
         AND e.id = t.event_id
        WHERE (p_session_ids IS NULL OR e.session_id = ANY(p_session_ids))
          AND (p_event_types IS NULL OR e.event_type = ANY(p_event_types))
        GROUP BY
            e.id, e.session_id, e.event_type, e.payload,
            e.searchable_text, e.created_at
    ),
    exact_count AS (
        SELECT COUNT(*) AS count FROM scored
    ),
    prefix_scored AS (
        SELECT
            e.id,
            e.session_id,
            e.event_type,
            e.payload,
            e.searchable_text,
            e.created_at,
            MAX(
                0.000001 +
                LEAST(
                    length(q.term)::FLOAT /
                    GREATEST(length(t.term), 1)::FLOAT,
                    1.0
                ) * 0.000001
            )::FLOAT AS score
        FROM korean_prefix_terms q
        JOIN event_search_terms t
          ON t.term >= q.prefix
         AND t.term < q.prefix || U&'\FFFF'
        JOIN events e
          ON e.session_id = t.session_id
         AND e.id = t.event_id
        WHERE t.term ~ '[가-힣]'
          AND (p_session_ids IS NULL OR e.session_id = ANY(p_session_ids))
          AND (p_event_types IS NULL OR e.event_type = ANY(p_event_types))
          AND (p_limit IS NULL OR (SELECT count FROM exact_count) < p_limit)
          AND NOT EXISTS (
              SELECT 1
              FROM scored s
              WHERE s.session_id = e.session_id
                AND s.id = e.id
          )
        GROUP BY
            e.id, e.session_id, e.event_type, e.payload,
            e.searchable_text, e.created_at
    ),
    combined AS (
        SELECT id, session_id, event_type, payload, searchable_text, created_at, score
        FROM scored
        UNION ALL
        SELECT id, session_id, event_type, payload, searchable_text, created_at, score
        FROM prefix_scored
    )
    SELECT id, session_id, event_type, payload, searchable_text, created_at, score
    FROM combined
    ORDER BY score DESC, created_at DESC
    LIMIT p_limit;
$$;

-- 35. session_list_summary
DROP FUNCTION IF EXISTS session_list_summary(TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT);
CREATE OR REPLACE FUNCTION session_list_summary(
    p_search       TEXT DEFAULT NULL,
    p_session_type TEXT DEFAULT NULL,
    p_limit        INTEGER DEFAULT 20,
    p_offset       INTEGER DEFAULT 0,
    p_folder_id    TEXT DEFAULT NULL,
    p_node_id      TEXT DEFAULT NULL
) RETURNS TABLE(
    session_id    TEXT,
    display_name  TEXT,
    status        TEXT,
    session_type  TEXT,
    created_at    TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ,
    event_count   BIGINT,
    away_summary  TEXT,
    caller_session_id TEXT,
    last_event_id INTEGER,
    last_read_event_id INTEGER,
    node_id TEXT,
    total_count   BIGINT
) LANGUAGE sql STABLE AS $$
    WITH filtered AS (
        SELECT s.session_id, s.display_name, s.status, s.session_type,
               s.created_at, s.updated_at,
               (SELECT COUNT(*) FROM events e WHERE e.session_id = s.session_id) AS event_count,
               s.away_summary, s.caller_session_id,
               s.last_event_id, s.last_read_event_id, s.node_id
        FROM sessions s
        WHERE (p_session_type IS NULL OR s.session_type = p_session_type)
          AND (p_search IS NULL OR s.display_name ILIKE '%' || p_search || '%')
          AND (p_folder_id IS NULL OR s.folder_id = p_folder_id)
          AND (p_node_id IS NULL OR s.node_id = p_node_id)
        ORDER BY s.updated_at DESC
    )
    SELECT f.*, (SELECT COUNT(*) FROM filtered)::BIGINT AS total_count
    FROM filtered f
    LIMIT p_limit OFFSET p_offset;
$$;

-- 폴더 도메인 ----------------------------------------------------

-- 22. folder_create
CREATE OR REPLACE FUNCTION folder_create(
    p_id         TEXT,
    p_name       TEXT,
    p_sort_order INTEGER DEFAULT 0,
    p_parent_folder_id TEXT DEFAULT NULL
) RETURNS void LANGUAGE sql AS $$
    INSERT INTO folders (id, name, sort_order, parent_folder_id)
    VALUES (p_id, p_name, p_sort_order, p_parent_folder_id);
$$;

-- 23. folder_update
CREATE OR REPLACE FUNCTION folder_update(
    p_id      TEXT,
    p_columns TEXT[],
    p_values  TEXT[]
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    allowed TEXT[] := ARRAY['name', 'sort_order', 'settings', 'parent_folder_id'];
    set_list TEXT := '';
    i INTEGER;
    col TEXT;
BEGIN
    FOR i IN 1..array_length(p_columns, 1) LOOP
        col := p_columns[i];
        IF NOT (col = ANY(allowed)) THEN
            RAISE EXCEPTION 'Invalid folder column: %', col;
        END IF;
        IF set_list != '' THEN
            set_list := set_list || ', ';
        END IF;
        IF col = 'sort_order' THEN
            set_list := set_list || col || ' = ' || p_values[i] || '::integer';
        ELSIF col = 'settings' THEN
            set_list := set_list || col || ' = ' || quote_literal(p_values[i]) || '::jsonb';
        ELSIF col = 'parent_folder_id' THEN
            IF p_values[i] IS NULL THEN
                set_list := set_list || col || ' = NULL';
            ELSE
                set_list := set_list || col || ' = ' || quote_literal(p_values[i]);
            END IF;
        ELSE
            set_list := set_list || col || ' = ' || quote_literal(p_values[i]);
        END IF;
    END LOOP;

    EXECUTE format('UPDATE folders SET %s WHERE id = %s', set_list, quote_literal(p_id));
END;
$$;

-- 24. folder_get
CREATE OR REPLACE FUNCTION folder_get(
    p_id TEXT
) RETURNS SETOF folders LANGUAGE sql STABLE AS $$
    SELECT * FROM folders WHERE id = p_id;
$$;

-- 25. folder_delete
CREATE OR REPLACE FUNCTION folder_delete(
    p_id TEXT
) RETURNS void LANGUAGE sql AS $$
    DELETE FROM folders WHERE id = p_id;
$$;

-- 26. folder_get_all
CREATE OR REPLACE FUNCTION folder_get_all()
RETURNS SETOF folders LANGUAGE sql STABLE AS $$
    SELECT * FROM folders ORDER BY sort_order, name;
$$;

-- 27. folder_get_default
CREATE OR REPLACE FUNCTION folder_get_default(
    p_name TEXT
) RETURNS SETOF folders LANGUAGE sql STABLE AS $$
    SELECT * FROM folders WHERE name = p_name;
$$;

-- 28. folder_ensure_defaults
CREATE OR REPLACE FUNCTION folder_ensure_defaults(
    p_folders JSONB
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    item JSONB;
BEGIN
    FOR item IN SELECT jsonb_array_elements(p_folders) LOOP
        INSERT INTO folders (id, name, sort_order)
        VALUES (item->>'id', item->>'name', COALESCE((item->>'sort_order')::integer, 0))
        ON CONFLICT (id) DO NOTHING;
    END LOOP;
END;
$$;

-- 카탈로그 --------------------------------------------------------

-- 29. catalog_get_sessions
CREATE OR REPLACE FUNCTION catalog_get_sessions()
RETURNS TABLE(session_id TEXT, folder_id TEXT, display_name TEXT)
LANGUAGE sql STABLE AS $$
    SELECT session_id, folder_id, display_name FROM sessions;
$$;

-- 29b. board_seed_items
CREATE OR REPLACE FUNCTION board_seed_items()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('soulstream:board_items')::bigint);

    -- 세션 타일 reconcile: folder 컨테이너 타일만 폴더 불일치로 삭제한다.
    -- runbook 컨테이너 타일은 Y.Doc이 생명주기를 소유하므로 세션 자체가
    -- 사라진 경우(고아)에만 정리한다.
    DELETE FROM board_items bi
    WHERE bi.item_type = 'session'
      AND (
          NOT EXISTS (
              SELECT 1 FROM sessions s
              WHERE s.session_id = bi.item_id
          )
          OR (
              bi.container_kind = 'folder'
              AND NOT EXISTS (
                  SELECT 1 FROM sessions s
                  WHERE s.session_id = bi.item_id
                    AND s.folder_id = bi.folder_id
              )
          )
      );

    DELETE FROM board_items bi
    WHERE bi.item_type = 'subfolder'
      AND NOT EXISTS (
          SELECT 1 FROM folders f
          WHERE f.id = bi.item_id
            AND f.parent_folder_id = bi.folder_id
      );

    DELETE FROM board_items bi
    WHERE bi.item_type = 'markdown'
      AND NOT EXISTS (
          SELECT 1 FROM markdown_documents d
          WHERE d.id = bi.item_id
      );

    DELETE FROM board_items bi
    WHERE bi.item_type = 'asset'
      AND NOT EXISTS (
          SELECT 1 FROM file_assets fa
          WHERE fa.id = bi.item_id
      );

    DELETE FROM board_items bi
    WHERE bi.item_type = 'custom_view'
      AND NOT EXISTS (
          SELECT 1 FROM board_custom_views cv
          WHERE cv.id = bi.item_id
      );

    WITH candidates AS (
        SELECT
            s.folder_id AS folder_id,
            'session'::TEXT AS item_type,
            s.session_id AS item_id,
            ('session:' || s.session_id)::TEXT AS board_item_id,
            COALESCE(
                CASE
                    WHEN s.last_message ? 'timestamp' AND s.last_message->>'timestamp' <> ''
                    THEN (s.last_message->>'timestamp')::TIMESTAMPTZ
                    ELSE NULL
                END,
                s.updated_at,
                s.created_at,
                NOW()
            ) AS activity_at,
            s.session_id AS tie_breaker
        FROM sessions s
        WHERE s.folder_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM board_items existing_primary
              WHERE existing_primary.item_type = 'session'
                AND existing_primary.item_id = s.session_id
                AND existing_primary.membership_kind = 'primary'
          )
        UNION ALL
        SELECT
            f.parent_folder_id AS folder_id,
            'subfolder'::TEXT AS item_type,
            f.id AS item_id,
            ('subfolder:' || f.id)::TEXT AS board_item_id,
            COALESCE(f.created_at, NOW()) AS activity_at,
            f.name AS tie_breaker
        FROM folders f
        WHERE f.parent_folder_id IS NOT NULL
    ),
    numbered AS (
        SELECT
            *,
            ROW_NUMBER() OVER (
                PARTITION BY folder_id
                ORDER BY activity_at DESC, item_type ASC, tie_breaker ASC
            ) - 1 AS item_index
        FROM candidates
    )
    INSERT INTO board_items (
        id,
        folder_id,
        container_kind,
        container_id,
        membership_kind,
        item_type,
        item_id,
        x,
        y,
        metadata
    )
    SELECT
        board_item_id,
        folder_id,
        'folder'::TEXT,
        folder_id,
        'primary'::TEXT,
        item_type,
        item_id,
        ((item_index % 4) * 280)::DOUBLE PRECISION,
        (FLOOR(item_index / 4) * 160)::DOUBLE PRECISION,
        '{}'::jsonb
    FROM numbered
    ON CONFLICT DO NOTHING;
END;
$$;

-- 29c. board_item_get_all
-- RETURNS TABLE 시그니처가 바뀌면 CREATE OR REPLACE가 기존 DB에서 실패한다
-- (cannot change return type — 260706 배포 사고). 시그니처 변경 시 DROP 병행 필수.
DROP FUNCTION IF EXISTS board_item_get_all();
CREATE OR REPLACE FUNCTION board_item_get_all()
RETURNS TABLE(
    id TEXT,
    folder_id TEXT,
    container_kind TEXT,
    container_id TEXT,
    membership_kind TEXT,
    source_runbook_item_id TEXT,
    item_type TEXT,
    item_id TEXT,
    x DOUBLE PRECISION,
    y DOUBLE PRECISION,
    metadata JSONB,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
) LANGUAGE sql STABLE AS $$
    SELECT
        bi.id,
        bi.folder_id,
        bi.container_kind,
        bi.container_id,
        bi.membership_kind,
        bi.source_runbook_item_id,
        bi.item_type,
        bi.item_id,
        bi.x,
        bi.y,
        CASE
            WHEN bi.item_type = 'markdown' THEN
                bi.metadata || jsonb_build_object(
                    'title', md.title,
                    'preview', LEFT(regexp_replace(md.body, '[[:space:]]+', ' ', 'g'), 180),
                    'version', md.version
                )
            WHEN bi.item_type = 'asset' THEN
                bi.metadata || jsonb_build_object(
                    'assetId', fa.id,
                    'storageKey', fa.storage_key,
                    'originalName', fa.original_name,
                    'mimeType', fa.mime_type,
                    'byteSize', fa.byte_size,
                    'width', fa.width,
                    'height', fa.height,
                    'durationSeconds', fa.duration_seconds
                )
            WHEN bi.item_type = 'custom_view' THEN
                bi.metadata || jsonb_build_object(
                    'title', COALESCE(cv.title, ''),
                    'preview', LEFT(regexp_replace(regexp_replace(cv.html, '<[^>]*>', ' ', 'g'), '[[:space:]]+', ' ', 'g'), 180),
                    'revision', cv.revision
                )
            ELSE bi.metadata
        END AS metadata,
        bi.created_at,
        bi.updated_at
    FROM board_items bi
    LEFT JOIN markdown_documents md
      ON bi.item_type = 'markdown'
     AND bi.item_id = md.id
    LEFT JOIN file_assets fa
      ON bi.item_type = 'asset'
     AND bi.item_id = fa.id
    LEFT JOIN board_custom_views cv
      ON bi.item_type = 'custom_view'
     AND bi.item_id = cv.id
    ORDER BY bi.folder_id, bi.y, bi.x, bi.created_at;
$$;

INSERT INTO board_yjs_catalog_cache (
    folder_id, container_kind, container_id, board_items, markdown_documents, updated_at
)
SELECT
    bi.folder_id,
    bi.container_kind,
    bi.container_id,
    jsonb_agg(
        jsonb_build_object(
            'id', bi.id,
            'folderId', bi.folder_id,
            'containerKind', bi.container_kind,
            'containerId', bi.container_id,
            'membershipKind', bi.membership_kind,
            'sourceRunbookItemId', bi.source_runbook_item_id,
            'itemType', bi.item_type,
            'itemId', bi.item_id,
            'x', bi.x,
            'y', bi.y,
            'metadata', COALESCE(bi.metadata, '{}'::jsonb),
            'createdAt', bi.created_at,
            'updatedAt', bi.updated_at
        )
        ORDER BY bi.y, bi.x, bi.created_at
    ),
    COALESCE((
        SELECT jsonb_agg(
            jsonb_build_object(
                'id', md.id,
                'title', md.title,
                'body', md.body,
                'version', md.version,
                'createdAt', md.created_at,
                'updatedAt', md.updated_at
            )
            ORDER BY md.created_at, md.id
        )
        FROM board_items mbi
        JOIN markdown_documents md ON md.id = mbi.item_id
        WHERE mbi.container_kind = bi.container_kind
          AND mbi.container_id = bi.container_id
          AND mbi.item_type = 'markdown'
    ), '[]'::jsonb),
    NOW()
FROM board_item_get_all() bi
GROUP BY bi.folder_id, bi.container_kind, bi.container_id
ON CONFLICT (container_kind, container_id) DO NOTHING;

-- 마이그레이션 ----------------------------------------------------

-- 30. migration_upsert_folder
CREATE OR REPLACE FUNCTION migration_upsert_folder(
    p_id         TEXT,
    p_name       TEXT,
    p_sort_order INTEGER
) RETURNS void LANGUAGE sql AS $$
    INSERT INTO folders (id, name, sort_order)
    VALUES (p_id, p_name, p_sort_order)
    ON CONFLICT (id) DO NOTHING;
$$;

-- 31. migration_upsert_session
CREATE OR REPLACE FUNCTION migration_upsert_session(
    p_session_id TEXT,
    p_data       JSONB
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO sessions (
        session_id, folder_id, display_name, node_id, session_type,
        status, prompt, client_id, claude_session_id,
        last_message, metadata, was_running_at_shutdown,
        last_event_id, last_read_event_id, created_at, updated_at,
        agent_id
    ) VALUES (
        p_session_id,
        p_data->>'folder_id',
        p_data->>'display_name',
        p_data->>'node_id',
        p_data->>'session_type',
        p_data->>'status',
        p_data->>'prompt',
        p_data->>'client_id',
        p_data->>'claude_session_id',
        CASE WHEN p_data ? 'last_message' THEN (p_data->'last_message') ELSE NULL END,
        CASE WHEN p_data ? 'metadata' THEN (p_data->'metadata') ELSE NULL END,
        COALESCE((p_data->>'was_running_at_shutdown')::boolean, FALSE),
        (p_data->>'last_event_id')::integer,
        (p_data->>'last_read_event_id')::integer,
        COALESCE((p_data->>'created_at')::timestamptz, NOW()),
        COALESCE((p_data->>'updated_at')::timestamptz, NOW()),
        p_data->>'agent_id'
    )
    ON CONFLICT (session_id) DO UPDATE SET
        folder_id = EXCLUDED.folder_id,
        display_name = EXCLUDED.display_name,
        -- 불변 필드: 기존 값이 있으면 유지, 없을 때만 새 값 사용
        node_id = COALESCE(sessions.node_id, EXCLUDED.node_id),
        session_type = EXCLUDED.session_type,
        status = EXCLUDED.status,
        prompt = EXCLUDED.prompt,
        client_id = EXCLUDED.client_id,
        claude_session_id = COALESCE(sessions.claude_session_id, EXCLUDED.claude_session_id),
        last_message = EXCLUDED.last_message,
        metadata = EXCLUDED.metadata,
        was_running_at_shutdown = EXCLUDED.was_running_at_shutdown,
        last_event_id = EXCLUDED.last_event_id,
        last_read_event_id = EXCLUDED.last_read_event_id,
        updated_at = EXCLUDED.updated_at,
        agent_id = COALESCE(sessions.agent_id, EXCLUDED.agent_id);
END;
$$;

-- 32. migration_insert_event
CREATE OR REPLACE FUNCTION migration_insert_event(
    p_session_id      TEXT,
    p_id              INTEGER,
    p_event_type      TEXT,
    p_payload         JSONB,
    p_searchable_text TEXT,
    p_created_at      TIMESTAMPTZ
) RETURNS void LANGUAGE sql AS $$
    INSERT INTO events (session_id, id, event_type, payload, searchable_text, created_at)
    VALUES (p_session_id, p_id, p_event_type, p_payload, p_searchable_text, p_created_at)
    ON CONFLICT DO NOTHING;
$$;

-- 33. migration_ensure_session
CREATE OR REPLACE FUNCTION migration_ensure_session(
    p_session_id TEXT,
    p_data       JSONB
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM sessions WHERE session_id = p_session_id) THEN
        INSERT INTO sessions (
            session_id, folder_id, display_name, node_id, session_type,
            status, prompt, client_id, claude_session_id,
            last_message, metadata, was_running_at_shutdown,
            last_event_id, last_read_event_id, created_at, updated_at,
            agent_id
        ) VALUES (
            p_session_id,
            p_data->>'folder_id',
            p_data->>'display_name',
            p_data->>'node_id',
            p_data->>'session_type',
            p_data->>'status',
            p_data->>'prompt',
            p_data->>'client_id',
            p_data->>'claude_session_id',
            CASE WHEN p_data ? 'last_message' THEN (p_data->'last_message') ELSE NULL END,
            CASE WHEN p_data ? 'metadata' THEN (p_data->'metadata') ELSE NULL END,
            COALESCE((p_data->>'was_running_at_shutdown')::boolean, FALSE),
            (p_data->>'last_event_id')::integer,
            (p_data->>'last_read_event_id')::integer,
            COALESCE((p_data->>'created_at')::timestamptz, NOW()),
            COALESCE((p_data->>'updated_at')::timestamptz, NOW()),
            p_data->>'agent_id'
        );
    END IF;
END;
$$;

-- 34. migration_update_last_event_id
CREATE OR REPLACE FUNCTION migration_update_last_event_id(
    p_session_id    TEXT,
    p_last_event_id INTEGER
) RETURNS void LANGUAGE sql AS $$
    UPDATE sessions
    SET last_event_id = p_last_event_id
    WHERE session_id = p_session_id
      AND (last_event_id IS NULL OR last_event_id < p_last_event_id);
$$;

-- 35. migration_verify
CREATE OR REPLACE FUNCTION migration_verify(
    p_node_id TEXT
) RETURNS TABLE(session_count BIGINT, event_count BIGINT, folder_count BIGINT)
LANGUAGE sql STABLE AS $$
    SELECT
        (SELECT COUNT(*) FROM sessions WHERE node_id = p_node_id) AS session_count,
        (SELECT COUNT(*) FROM events e
         JOIN sessions s ON e.session_id = s.session_id
         WHERE s.node_id = p_node_id) AS event_count,
        (SELECT COUNT(*) FROM folders) AS folder_count;
$$;

CREATE OR REPLACE FUNCTION claude_transcript_append(
    p_project_key TEXT,
    p_session_id  TEXT,
    p_subpath     TEXT,
    p_entries     JSONB,
    p_now         TIMESTAMPTZ
) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
    v_subpath TEXT := COALESCE(p_subpath, '');
    v_entries JSONB := CASE jsonb_typeof(p_entries)
        WHEN 'array' THEN p_entries
        WHEN 'object' THEN jsonb_build_array(p_entries)
        ELSE '[]'::jsonb
    END;
    v_entry JSONB;
    v_uuid TEXT;
    v_count INTEGER := 0;
BEGIN
    FOR v_entry IN SELECT value FROM jsonb_array_elements(v_entries)
    LOOP
        v_uuid := v_entry->>'uuid';
        INSERT INTO claude_transcript_entries (
            project_key,
            session_id,
            subpath,
            entry_uuid,
            entry,
            created_at,
            updated_at
        ) VALUES (
            p_project_key,
            p_session_id,
            v_subpath,
            v_uuid,
            v_entry,
            p_now,
            p_now
        )
        ON CONFLICT (project_key, session_id, subpath, entry_uuid)
        WHERE entry_uuid IS NOT NULL
        DO UPDATE SET entry = EXCLUDED.entry, updated_at = EXCLUDED.updated_at;

        v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION claude_transcript_load(
    p_project_key TEXT,
    p_session_id  TEXT,
    p_subpath     TEXT
) RETURNS TABLE(entry JSONB) LANGUAGE sql STABLE AS $$
    SELECT e.entry
    FROM claude_transcript_entries e
    WHERE e.project_key = p_project_key
      AND e.session_id = p_session_id
      AND e.subpath = COALESCE(p_subpath, '')
    ORDER BY e.id ASC;
$$;

CREATE OR REPLACE FUNCTION claude_transcript_list_sessions(
    p_project_key TEXT
) RETURNS TABLE(session_id TEXT, mtime DOUBLE PRECISION) LANGUAGE sql STABLE AS $$
    SELECT
        e.session_id,
        EXTRACT(EPOCH FROM MAX(e.updated_at)) * 1000 AS mtime
    FROM claude_transcript_entries e
    WHERE e.project_key = p_project_key
      AND e.subpath = ''
    GROUP BY e.session_id;
$$;

CREATE OR REPLACE FUNCTION claude_transcript_list_subkeys(
    p_project_key TEXT,
    p_session_id  TEXT
) RETURNS TABLE(subpath TEXT) LANGUAGE sql STABLE AS $$
    SELECT DISTINCT e.subpath
    FROM claude_transcript_entries e
    WHERE e.project_key = p_project_key
      AND e.session_id = p_session_id
      AND e.subpath <> ''
    ORDER BY e.subpath ASC;
$$;

CREATE OR REPLACE FUNCTION claude_transcript_delete(
    p_project_key TEXT,
    p_session_id  TEXT,
    p_subpath     TEXT
) RETURNS void LANGUAGE sql AS $$
    DELETE FROM claude_transcript_entries e
    WHERE e.project_key = p_project_key
      AND e.session_id = p_session_id
      AND (p_subpath IS NULL OR e.subpath = p_subpath);
$$;

-- parent_event_id 레거시 백필(2026-05-02 결함 보정)은 완료되어 은퇴 —
-- migrations/034_retire_parent_event_id_backfill.sql 참조.


-- ─── 010_push_tokens.sql ─────────────────────────────────────────────────────
-- Expo Push 토큰 저장 (orch-server가 사용).
-- 자세한 설명은 migrations/010_push_tokens.sql 참조.

CREATE TABLE IF NOT EXISTS push_tokens (
    user_email TEXT NOT NULL,
    device_id TEXT NOT NULL,
    expo_token TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_email, device_id)
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_email ON push_tokens(user_email);

-- Dashboard users and folder visibility policy (orch-server).
CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    display_name TEXT,
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    allowed_folder_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_is_admin ON users(is_admin);

-- Account-scoped dashboard preferences (orch-server).
-- prefs JSONB stores appearance, wallpaper, and liquid glass settings.
CREATE TABLE IF NOT EXISTS user_preferences (
    email TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
    prefs JSONB NOT NULL DEFAULT '{}'::JSONB,
    background_blob BYTEA,
    background_mime TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS prefs JSONB NOT NULL DEFAULT '{}'::JSONB;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS background_blob BYTEA;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS background_mime TEXT;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Runbooks: collaborative checklist state and append-only provenance.
CREATE TABLE IF NOT EXISTS runbooks (
    id                 TEXT PRIMARY KEY,
    board_item_id      TEXT NOT NULL REFERENCES board_items(id) ON DELETE CASCADE, -- 자기 자신의 item_type='runbook' board_item 1:1
    title              TEXT NOT NULL DEFAULT '',
    status             TEXT NOT NULL DEFAULT 'open',
    archived           BOOLEAN NOT NULL DEFAULT FALSE,
    version            INTEGER NOT NULL DEFAULT 1,
    created_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    created_event_id   INTEGER,
    completed_kind     TEXT,
    completed_session_id TEXT,
    completed_event_id INTEGER,
    completed_user_id  TEXT,
    completed_at       TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT runbooks_status_check
        CHECK (status IN ('open','completed')),
    CONSTRAINT runbooks_completed_kind_check
        CHECK (completed_kind IN ('agent','user')),
    FOREIGN KEY (created_session_id, created_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL,
    CONSTRAINT runbooks_completed_session_id_fkey
        FOREIGN KEY (completed_session_id) REFERENCES sessions(session_id) ON DELETE SET NULL,
    CONSTRAINT runbooks_completed_event_fkey
        FOREIGN KEY (completed_session_id, completed_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL
);

ALTER TABLE runbooks DROP CONSTRAINT IF EXISTS runbooks_completed_session_id_completed_event_id_fkey;

ALTER TABLE runbooks ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE runbooks ADD COLUMN IF NOT EXISTS completed_kind TEXT;
ALTER TABLE runbooks ADD COLUMN IF NOT EXISTS completed_session_id TEXT;
ALTER TABLE runbooks ADD COLUMN IF NOT EXISTS completed_event_id INTEGER;
ALTER TABLE runbooks ADD COLUMN IF NOT EXISTS completed_user_id TEXT;
ALTER TABLE runbooks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

ALTER TABLE runbooks DROP CONSTRAINT IF EXISTS runbooks_status_check;
ALTER TABLE runbooks ADD CONSTRAINT runbooks_status_check
    CHECK (status IN ('open','completed'));

ALTER TABLE runbooks DROP CONSTRAINT IF EXISTS runbooks_completed_kind_check;
ALTER TABLE runbooks ADD CONSTRAINT runbooks_completed_kind_check
    CHECK (completed_kind IN ('agent','user'));

ALTER TABLE runbooks DROP CONSTRAINT IF EXISTS runbooks_completed_session_id_fkey;
ALTER TABLE runbooks ADD CONSTRAINT runbooks_completed_session_id_fkey
    FOREIGN KEY (completed_session_id) REFERENCES sessions(session_id) ON DELETE SET NULL;

ALTER TABLE runbooks DROP CONSTRAINT IF EXISTS runbooks_completed_event_fkey;
ALTER TABLE runbooks ADD CONSTRAINT runbooks_completed_event_fkey
    FOREIGN KEY (completed_session_id, completed_event_id)
    REFERENCES events(session_id, id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_runbooks_board_item ON runbooks(board_item_id);

CREATE TABLE IF NOT EXISTS runbook_sections (
    id                 TEXT PRIMARY KEY,
    runbook_id         TEXT NOT NULL REFERENCES runbooks(id) ON DELETE CASCADE,
    position_key       TEXT NOT NULL,
    title              TEXT NOT NULL,
    assignee_kind      TEXT CHECK (assignee_kind IN ('agent','human','session')),
    assignee_agent_id  TEXT,
    assignee_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    assignee_user_id   TEXT,
    archived           BOOLEAN NOT NULL DEFAULT FALSE,
    version            INTEGER NOT NULL DEFAULT 1,
    created_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    created_event_id   INTEGER,
    updated_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    updated_event_id   INTEGER,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (created_session_id, created_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL,
    FOREIGN KEY (updated_session_id, updated_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_runbook_sections_runbook
    ON runbook_sections(runbook_id, position_key);

CREATE TABLE IF NOT EXISTS runbook_items (
    id                   TEXT PRIMARY KEY,
    section_id           TEXT NOT NULL REFERENCES runbook_sections(id) ON DELETE CASCADE,
    position_key         TEXT NOT NULL,
    title                TEXT NOT NULL,
    how_to               TEXT NOT NULL DEFAULT '',
    assignee_kind        TEXT CHECK (assignee_kind IN ('agent','human','session')),
    assignee_agent_id    TEXT,
    assignee_session_id  TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    assignee_user_id     TEXT,
    status               TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','in_progress','review','completed','cancelled')),
    archived             BOOLEAN NOT NULL DEFAULT FALSE,
    version              INTEGER NOT NULL DEFAULT 1,
    created_session_id   TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    created_event_id     INTEGER,
    updated_session_id   TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    updated_event_id     INTEGER,
    completed_kind       TEXT CHECK (completed_kind IN ('agent','user')),
    completed_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    completed_event_id   INTEGER,
    completed_user_id    TEXT,
    completed_at         TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (created_session_id, created_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL,
    FOREIGN KEY (updated_session_id, updated_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL,
    FOREIGN KEY (completed_session_id, completed_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_runbook_items_section
    ON runbook_items(section_id, position_key);

ALTER TABLE board_items DROP CONSTRAINT IF EXISTS board_items_source_runbook_item_id_fkey;
ALTER TABLE board_items ADD CONSTRAINT board_items_source_runbook_item_id_fkey
    FOREIGN KEY (source_runbook_item_id) REFERENCES runbook_items(id) ON DELETE SET NULL;

ALTER TABLE runbook_items DROP CONSTRAINT IF EXISTS runbook_items_status_check;
ALTER TABLE runbook_items ADD CONSTRAINT runbook_items_status_check
    CHECK (status IN ('pending','in_progress','review','completed','cancelled'));

-- "내 차례"는 review이거나, 유효 담당(항목 own, 없으면 섹션 상속)이 human이고 미완·미취소.
-- 상속 케이스는 부분 인덱스로 못 잡으므로 조회 시 항목⨝섹션으로 해석한다.
CREATE INDEX IF NOT EXISTS idx_runbook_items_human_self
    ON runbook_items(section_id)
    WHERE assignee_kind = 'human'
      AND status NOT IN ('completed','cancelled')
      AND archived = FALSE;

CREATE TABLE IF NOT EXISTS runbook_operations (
    id               TEXT PRIMARY KEY,
    runbook_id       TEXT REFERENCES runbooks(id) ON DELETE CASCADE,
    target_kind      TEXT NOT NULL CHECK (target_kind IN ('runbook','section','item')),
    target_id        TEXT NOT NULL,
    operation_type   TEXT NOT NULL,
    actor_kind       TEXT NOT NULL DEFAULT 'agent' CHECK (actor_kind IN ('agent','user','system')),
    actor_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    actor_event_id   INTEGER,
    actor_user_id    TEXT,
    idempotency_key  TEXT,
    payload_json     JSONB NOT NULL DEFAULT '{}'::JSONB,
    reason           TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (actor_session_id, actor_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_runbook_ops_idem
    ON runbook_operations(idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_runbook_ops_target
    ON runbook_operations(target_kind, target_id, created_at);

-- Pages and blocks: Y.Doc-backed page replicas, mutation provenance, and backlinks.
CREATE TABLE IF NOT EXISTS pages (
    id                 TEXT PRIMARY KEY,
    title              TEXT NOT NULL CHECK (btrim(title) <> ''),
    title_key          TEXT GENERATED ALWAYS AS (lower(btrim(title))) STORED,
    daily_date         DATE,
    version            INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    archived           BOOLEAN NOT NULL DEFAULT FALSE,
    metadata           JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    created_event_id   INTEGER,
    updated_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    updated_event_id   INTEGER,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pages_created_event_fkey
        FOREIGN KEY (created_session_id, created_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL,
    CONSTRAINT pages_updated_event_fkey
        FOREIGN KEY (updated_session_id, updated_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL
);

ALTER TABLE pages ADD COLUMN IF NOT EXISTS title TEXT NOT NULL CHECK (btrim(title) <> '');
ALTER TABLE pages ADD COLUMN IF NOT EXISTS title_key TEXT GENERATED ALWAYS AS (lower(btrim(title))) STORED;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS daily_date DATE;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE pages ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::JSONB;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS created_session_id TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS created_event_id INTEGER;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS updated_session_id TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS updated_event_id INTEGER;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE pages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_title_check;
ALTER TABLE pages ADD CONSTRAINT pages_title_check CHECK (btrim(title) <> '');
ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_version_check;
ALTER TABLE pages ADD CONSTRAINT pages_version_check CHECK (version > 0);
ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_created_session_id_fkey;
ALTER TABLE pages ADD CONSTRAINT pages_created_session_id_fkey
    FOREIGN KEY (created_session_id) REFERENCES sessions(session_id) ON DELETE SET NULL;
ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_updated_session_id_fkey;
ALTER TABLE pages ADD CONSTRAINT pages_updated_session_id_fkey
    FOREIGN KEY (updated_session_id) REFERENCES sessions(session_id) ON DELETE SET NULL;
ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_created_event_fkey;
ALTER TABLE pages ADD CONSTRAINT pages_created_event_fkey
    FOREIGN KEY (created_session_id, created_event_id)
    REFERENCES events(session_id, id) ON DELETE SET NULL;
ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_updated_event_fkey;
ALTER TABLE pages ADD CONSTRAINT pages_updated_event_fkey
    FOREIGN KEY (updated_session_id, updated_event_id)
    REFERENCES events(session_id, id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pages_title_key ON pages(title_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pages_daily_date
    ON pages(daily_date) WHERE daily_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pages_active_updated
    ON pages(archived, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pages_title_prefix
    ON pages (title_key text_pattern_ops, id)
    WHERE archived = FALSE;

CREATE TABLE IF NOT EXISTS blocks (
    id                 TEXT PRIMARY KEY,
    page_id            TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    parent_id          TEXT,
    position_key       TEXT NOT NULL CHECK (position_key <> ''),
    block_type         TEXT NOT NULL DEFAULT 'paragraph',
    text_plain         TEXT NOT NULL DEFAULT '',
    properties         JSONB NOT NULL DEFAULT '{}'::JSONB,
    collapsed          BOOLEAN NOT NULL DEFAULT FALSE,
    created_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    created_event_id   INTEGER,
    updated_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    updated_event_id   INTEGER,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_blocks_page_id_id UNIQUE (page_id, id),
    CONSTRAINT blocks_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id),
    CONSTRAINT blocks_parent_same_page_fkey
        FOREIGN KEY (page_id, parent_id)
        REFERENCES blocks(page_id, id) ON DELETE CASCADE,
    CONSTRAINT blocks_created_event_fkey
        FOREIGN KEY (created_session_id, created_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL,
    CONSTRAINT blocks_updated_event_fkey
        FOREIGN KEY (updated_session_id, updated_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL
);

ALTER TABLE blocks ADD COLUMN IF NOT EXISTS page_id TEXT NOT NULL;
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS parent_id TEXT;
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS position_key TEXT NOT NULL CHECK (position_key <> '');
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS block_type TEXT NOT NULL DEFAULT 'paragraph';
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS text_plain TEXT NOT NULL DEFAULT '';
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS properties JSONB NOT NULL DEFAULT '{}'::JSONB;
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS collapsed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS created_session_id TEXT;
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS created_event_id INTEGER;
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS updated_session_id TEXT;
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS updated_event_id INTEGER;
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE blocks DROP CONSTRAINT IF EXISTS blocks_page_id_fkey;
ALTER TABLE blocks ADD CONSTRAINT blocks_page_id_fkey
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE;
ALTER TABLE blocks DROP CONSTRAINT IF EXISTS blocks_created_session_id_fkey;
ALTER TABLE blocks ADD CONSTRAINT blocks_created_session_id_fkey
    FOREIGN KEY (created_session_id) REFERENCES sessions(session_id) ON DELETE SET NULL;
ALTER TABLE blocks DROP CONSTRAINT IF EXISTS blocks_updated_session_id_fkey;
ALTER TABLE blocks ADD CONSTRAINT blocks_updated_session_id_fkey
    FOREIGN KEY (updated_session_id) REFERENCES sessions(session_id) ON DELETE SET NULL;
ALTER TABLE blocks DROP CONSTRAINT IF EXISTS blocks_position_key_check;
ALTER TABLE blocks ADD CONSTRAINT blocks_position_key_check CHECK (position_key <> '');
ALTER TABLE blocks DROP CONSTRAINT IF EXISTS blocks_not_own_parent;
ALTER TABLE blocks ADD CONSTRAINT blocks_not_own_parent
    CHECK (parent_id IS NULL OR parent_id <> id);
ALTER TABLE blocks DROP CONSTRAINT IF EXISTS blocks_parent_same_page_fkey;
ALTER TABLE blocks ADD CONSTRAINT blocks_parent_same_page_fkey
    FOREIGN KEY (page_id, parent_id)
    REFERENCES blocks(page_id, id) ON DELETE CASCADE;
ALTER TABLE blocks DROP CONSTRAINT IF EXISTS blocks_created_event_fkey;
ALTER TABLE blocks ADD CONSTRAINT blocks_created_event_fkey
    FOREIGN KEY (created_session_id, created_event_id)
    REFERENCES events(session_id, id) ON DELETE SET NULL;
ALTER TABLE blocks DROP CONSTRAINT IF EXISTS blocks_updated_event_fkey;
ALTER TABLE blocks ADD CONSTRAINT blocks_updated_event_fkey
    FOREIGN KEY (updated_session_id, updated_event_id)
    REFERENCES events(session_id, id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_blocks_tree
    ON blocks(page_id, parent_id, position_key, id);
CREATE INDEX IF NOT EXISTS idx_blocks_type
    ON blocks(page_id, block_type);
CREATE INDEX IF NOT EXISTS idx_blocks_text_prefix
    ON blocks ((lower(text_plain)) text_pattern_ops, id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_blocks_primary_session_ref
    ON blocks ((properties ->> 'sessionId'))
    WHERE block_type = 'session_ref'
      AND properties ->> 'primary' = 'true';

CREATE TABLE IF NOT EXISTS checklist_runbook_projection_outbox (
    block_id           TEXT PRIMARY KEY,
    page_id            TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    source_hash        TEXT NOT NULL,
    processed_hash     TEXT,
    actor_kind         TEXT NOT NULL DEFAULT 'system',
    actor_session_id   TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    actor_user_id      TEXT,
    routing_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    attempts           INTEGER NOT NULL DEFAULT 0,
    last_error         TEXT,
    next_retry_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_owner_node_id TEXT,
    lease_expires_at   TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS page_id TEXT;
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS source_hash TEXT;
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS processed_hash TEXT;
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS actor_kind TEXT NOT NULL DEFAULT 'system';
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS actor_session_id TEXT;
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS actor_user_id TEXT;
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS routing_session_id TEXT;
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS lease_owner_node_id TEXT;
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE checklist_runbook_projection_outbox ALTER COLUMN page_id SET NOT NULL;
ALTER TABLE checklist_runbook_projection_outbox ALTER COLUMN source_hash SET NOT NULL;
ALTER TABLE checklist_runbook_projection_outbox DROP CONSTRAINT IF EXISTS checklist_runbook_projection_outbox_page_id_fkey;
ALTER TABLE checklist_runbook_projection_outbox ADD CONSTRAINT checklist_runbook_projection_outbox_page_id_fkey
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE;
ALTER TABLE checklist_runbook_projection_outbox DROP CONSTRAINT IF EXISTS checklist_runbook_projection_outbox_actor_session_id_fkey;
ALTER TABLE checklist_runbook_projection_outbox ADD CONSTRAINT checklist_runbook_projection_outbox_actor_session_id_fkey
    FOREIGN KEY (actor_session_id) REFERENCES sessions(session_id) ON DELETE SET NULL;
ALTER TABLE checklist_runbook_projection_outbox DROP CONSTRAINT IF EXISTS checklist_runbook_projection_outbox_routing_session_id_fkey;
ALTER TABLE checklist_runbook_projection_outbox ADD CONSTRAINT checklist_runbook_projection_outbox_routing_session_id_fkey
    FOREIGN KEY (routing_session_id) REFERENCES sessions(session_id) ON DELETE SET NULL;
ALTER TABLE checklist_runbook_projection_outbox DROP CONSTRAINT IF EXISTS checklist_runbook_projection_outbox_actor_kind_check;
ALTER TABLE checklist_runbook_projection_outbox ADD CONSTRAINT checklist_runbook_projection_outbox_actor_kind_check
    CHECK (actor_kind IN ('agent','user','system'));
ALTER TABLE checklist_runbook_projection_outbox DROP CONSTRAINT IF EXISTS checklist_runbook_projection_outbox_actor_shape_check;
ALTER TABLE checklist_runbook_projection_outbox ADD CONSTRAINT checklist_runbook_projection_outbox_actor_shape_check
    CHECK (
      (actor_kind = 'agent' AND actor_session_id IS NOT NULL AND actor_user_id IS NULL)
      OR (actor_kind = 'user' AND actor_user_id IS NOT NULL)
      OR (actor_kind = 'system' AND actor_user_id IS NULL)
    );
ALTER TABLE checklist_runbook_projection_outbox DROP CONSTRAINT IF EXISTS checklist_runbook_projection_outbox_attempts_check;
ALTER TABLE checklist_runbook_projection_outbox ADD CONSTRAINT checklist_runbook_projection_outbox_attempts_check
    CHECK (attempts >= 0);

CREATE INDEX IF NOT EXISTS idx_checklist_runbook_projection_due
    ON checklist_runbook_projection_outbox(next_retry_at, updated_at, block_id)
    WHERE processed_hash IS DISTINCT FROM source_hash;

INSERT INTO checklist_runbook_projection_outbox (
  block_id, page_id, source_hash, actor_kind, actor_session_id
)
SELECT
  block.id,
  block.page_id,
  'reconcile:' || md5(
    block.block_type || E'\x1f' || block.text_plain || E'\x1f' || block.properties::text
  ),
  CASE
    WHEN COALESCE(
      block.updated_session_id, page.updated_session_id,
      block.created_session_id, page.created_session_id
    ) IS NULL THEN 'system'
    ELSE 'agent'
  END,
  COALESCE(
    block.updated_session_id, page.updated_session_id,
    block.created_session_id, page.created_session_id
  )
FROM blocks block
JOIN pages page ON page.id = block.page_id
WHERE block.block_type = 'checklist'
ON CONFLICT (block_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS session_page_bindings (
    session_id             TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
    node_id                TEXT NOT NULL,
    target_page_id         TEXT,
    target_block_id        TEXT,
    target_expected_version INTEGER,
    daily_date             DATE NOT NULL,
    session_type           TEXT NOT NULL,
    legacy_folder_id       TEXT,
    legacy_container_kind  TEXT,
    legacy_container_id    TEXT,
    source_runbook_item_id TEXT,
    page_state             TEXT NOT NULL DEFAULT 'pending'
                           CHECK (page_state IN ('pending','bound','manual_repair')),
    legacy_state           TEXT NOT NULL DEFAULT 'pending'
                           CHECK (legacy_state IN ('pending','completed','manual_repair')),
    attempts               INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error             TEXT,
    next_retry_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT session_page_bindings_anchor_shape CHECK (
      (target_page_id IS NULL AND target_block_id IS NULL AND target_expected_version IS NULL)
      OR (target_page_id IS NOT NULL AND target_block_id IS NOT NULL
          AND target_expected_version IS NOT NULL AND target_expected_version > 0)
    ),
    CONSTRAINT session_page_bindings_container_shape CHECK (
      (legacy_container_kind IS NULL AND legacy_container_id IS NULL)
      OR (legacy_container_kind IS NOT NULL AND legacy_container_id IS NOT NULL)
    ),
    CONSTRAINT session_page_bindings_container_kind_check CHECK (
      legacy_container_kind IS NULL OR legacy_container_kind IN ('folder','runbook')
    )
);

CREATE INDEX IF NOT EXISTS idx_session_page_bindings_due
    ON session_page_bindings(node_id, next_retry_at, created_at)
    WHERE page_state = 'pending'
       OR (page_state = 'bound' AND legacy_state = 'pending');

CREATE TABLE IF NOT EXISTS block_operations (
    id               TEXT PRIMARY KEY,
    page_id          TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    target_block_id  TEXT REFERENCES blocks(id) ON DELETE SET NULL,
    operation_type   TEXT NOT NULL,
    actor_kind       TEXT NOT NULL CHECK (actor_kind IN ('agent','user','system')),
    actor_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    actor_event_id   INTEGER,
    actor_user_id    TEXT,
    idempotency_key  TEXT NOT NULL,
    expected_version INTEGER NOT NULL,
    result_version   INTEGER NOT NULL,
    payload_json     JSONB NOT NULL DEFAULT '{}'::JSONB,
    reason           TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT block_operations_actor_event_fkey
        FOREIGN KEY (actor_session_id, actor_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL,
    CONSTRAINT block_operations_agent_actor_check
        CHECK (actor_kind <> 'agent' OR actor_session_id IS NOT NULL),
    CONSTRAINT block_operations_user_actor_check
        CHECK (actor_kind <> 'user' OR actor_user_id IS NOT NULL),
    CONSTRAINT block_operations_version_check
        CHECK (result_version = expected_version + 1)
);

ALTER TABLE block_operations ADD COLUMN IF NOT EXISTS page_id TEXT NOT NULL;
ALTER TABLE block_operations ADD COLUMN IF NOT EXISTS target_block_id TEXT;
ALTER TABLE block_operations ADD COLUMN IF NOT EXISTS operation_type TEXT NOT NULL;
ALTER TABLE block_operations ADD COLUMN IF NOT EXISTS actor_kind TEXT NOT NULL;
ALTER TABLE block_operations ADD COLUMN IF NOT EXISTS actor_session_id TEXT;
ALTER TABLE block_operations ADD COLUMN IF NOT EXISTS actor_event_id INTEGER;
ALTER TABLE block_operations ADD COLUMN IF NOT EXISTS actor_user_id TEXT;
ALTER TABLE block_operations ADD COLUMN IF NOT EXISTS idempotency_key TEXT NOT NULL;
ALTER TABLE block_operations ADD COLUMN IF NOT EXISTS expected_version INTEGER NOT NULL;
ALTER TABLE block_operations ADD COLUMN IF NOT EXISTS result_version INTEGER NOT NULL;
ALTER TABLE block_operations ADD COLUMN IF NOT EXISTS payload_json JSONB NOT NULL DEFAULT '{}'::JSONB;
ALTER TABLE block_operations ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE block_operations ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE block_operations DROP CONSTRAINT IF EXISTS block_operations_page_id_fkey;
ALTER TABLE block_operations ADD CONSTRAINT block_operations_page_id_fkey
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE;
ALTER TABLE block_operations DROP CONSTRAINT IF EXISTS block_operations_target_block_id_fkey;
ALTER TABLE block_operations ADD CONSTRAINT block_operations_target_block_id_fkey
    FOREIGN KEY (target_block_id) REFERENCES blocks(id) ON DELETE SET NULL;
ALTER TABLE block_operations DROP CONSTRAINT IF EXISTS block_operations_actor_session_id_fkey;
ALTER TABLE block_operations ADD CONSTRAINT block_operations_actor_session_id_fkey
    FOREIGN KEY (actor_session_id) REFERENCES sessions(session_id) ON DELETE SET NULL;
ALTER TABLE block_operations DROP CONSTRAINT IF EXISTS block_operations_actor_kind_check;
ALTER TABLE block_operations ADD CONSTRAINT block_operations_actor_kind_check
    CHECK (actor_kind IN ('agent','user','system'));
ALTER TABLE block_operations DROP CONSTRAINT IF EXISTS block_operations_actor_event_fkey;
ALTER TABLE block_operations ADD CONSTRAINT block_operations_actor_event_fkey
    FOREIGN KEY (actor_session_id, actor_event_id)
    REFERENCES events(session_id, id) ON DELETE SET NULL;
ALTER TABLE block_operations DROP CONSTRAINT IF EXISTS block_operations_agent_actor_check;
ALTER TABLE block_operations ADD CONSTRAINT block_operations_agent_actor_check
    CHECK (actor_kind <> 'agent' OR actor_session_id IS NOT NULL);
ALTER TABLE block_operations DROP CONSTRAINT IF EXISTS block_operations_user_actor_check;
ALTER TABLE block_operations ADD CONSTRAINT block_operations_user_actor_check
    CHECK (actor_kind <> 'user' OR actor_user_id IS NOT NULL);
ALTER TABLE block_operations DROP CONSTRAINT IF EXISTS block_operations_version_check;
ALTER TABLE block_operations ADD CONSTRAINT block_operations_version_check
    CHECK (result_version = expected_version + 1);

CREATE UNIQUE INDEX IF NOT EXISTS uq_block_operations_idempotency
    ON block_operations(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_block_operations_page
    ON block_operations(page_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_block_operations_target
    ON block_operations(target_block_id, created_at, id)
    WHERE target_block_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS block_links (
    id                 TEXT PRIMARY KEY,
    source_block_id    TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    link_kind          TEXT NOT NULL CHECK (link_kind IN ('mount','inline_page','block_ref')),
    ordinal            INTEGER NOT NULL CHECK (ordinal >= 0),
    source_start       INTEGER NOT NULL CHECK (source_start >= 0),
    source_end         INTEGER NOT NULL CHECK (source_end > source_start),
    target_page_id     TEXT REFERENCES pages(id) ON DELETE SET NULL,
    target_title       TEXT,
    target_title_key   TEXT,
    target_block_id    TEXT REFERENCES blocks(id) ON DELETE SET NULL,
    target_block_ref   TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_block_links_source_ordinal UNIQUE (source_block_id, ordinal),
    CONSTRAINT block_links_target_shape_check CHECK (
      (link_kind IN ('mount','inline_page')
       AND target_title IS NOT NULL AND target_title_key IS NOT NULL
       AND target_block_ref IS NULL)
      OR
      (link_kind = 'block_ref'
       AND target_block_ref IS NOT NULL
       AND target_title IS NULL AND target_title_key IS NULL)
    )
);

ALTER TABLE block_links ADD COLUMN IF NOT EXISTS source_block_id TEXT NOT NULL;
ALTER TABLE block_links ADD COLUMN IF NOT EXISTS link_kind TEXT NOT NULL;
ALTER TABLE block_links ADD COLUMN IF NOT EXISTS ordinal INTEGER NOT NULL;
ALTER TABLE block_links ADD COLUMN IF NOT EXISTS source_start INTEGER NOT NULL;
ALTER TABLE block_links ADD COLUMN IF NOT EXISTS source_end INTEGER NOT NULL;
ALTER TABLE block_links ADD COLUMN IF NOT EXISTS target_page_id TEXT;
ALTER TABLE block_links ADD COLUMN IF NOT EXISTS target_title TEXT;
ALTER TABLE block_links ADD COLUMN IF NOT EXISTS target_title_key TEXT;
ALTER TABLE block_links ADD COLUMN IF NOT EXISTS target_block_id TEXT;
ALTER TABLE block_links ADD COLUMN IF NOT EXISTS target_block_ref TEXT;
ALTER TABLE block_links ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE block_links DROP CONSTRAINT IF EXISTS block_links_source_block_id_fkey;
ALTER TABLE block_links ADD CONSTRAINT block_links_source_block_id_fkey
    FOREIGN KEY (source_block_id) REFERENCES blocks(id) ON DELETE CASCADE;
ALTER TABLE block_links DROP CONSTRAINT IF EXISTS block_links_target_page_id_fkey;
ALTER TABLE block_links ADD CONSTRAINT block_links_target_page_id_fkey
    FOREIGN KEY (target_page_id) REFERENCES pages(id) ON DELETE SET NULL;
ALTER TABLE block_links DROP CONSTRAINT IF EXISTS block_links_target_block_id_fkey;
ALTER TABLE block_links ADD CONSTRAINT block_links_target_block_id_fkey
    FOREIGN KEY (target_block_id) REFERENCES blocks(id) ON DELETE SET NULL;
ALTER TABLE block_links DROP CONSTRAINT IF EXISTS block_links_link_kind_check;
ALTER TABLE block_links ADD CONSTRAINT block_links_link_kind_check
    CHECK (link_kind IN ('mount','inline_page','block_ref'));
ALTER TABLE block_links DROP CONSTRAINT IF EXISTS block_links_ordinal_check;
ALTER TABLE block_links ADD CONSTRAINT block_links_ordinal_check CHECK (ordinal >= 0);
ALTER TABLE block_links DROP CONSTRAINT IF EXISTS block_links_source_start_check;
ALTER TABLE block_links ADD CONSTRAINT block_links_source_start_check CHECK (source_start >= 0);
ALTER TABLE block_links DROP CONSTRAINT IF EXISTS block_links_source_end_check;
ALTER TABLE block_links ADD CONSTRAINT block_links_source_end_check CHECK (source_end > source_start);
ALTER TABLE block_links DROP CONSTRAINT IF EXISTS block_links_target_shape_check;
ALTER TABLE block_links ADD CONSTRAINT block_links_target_shape_check CHECK (
  (link_kind IN ('mount','inline_page')
   AND target_title IS NOT NULL AND target_title_key IS NOT NULL
   AND target_block_ref IS NULL)
  OR
  (link_kind = 'block_ref'
   AND target_block_ref IS NOT NULL
   AND target_title IS NULL AND target_title_key IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_block_links_target_page
    ON block_links(target_page_id, link_kind, created_at)
    WHERE target_page_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_block_links_unresolved_page
    ON block_links(target_title_key)
    WHERE target_page_id IS NULL AND target_title_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_block_links_target_block
    ON block_links(target_block_id, created_at)
    WHERE target_block_id IS NOT NULL;

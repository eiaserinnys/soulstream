-- schema.sql — DDL 정본 파일
-- 모든 테이블, 인덱스, 트리거, 함수를 멱등하게 정의한다.
-- CREATE OR REPLACE / IF NOT EXISTS로 반복 실행 가능.

-- 041_retire_task_tree.sql mirror: retire the legacy v1 Task Tree before the 042
-- rename. Self-guarded so it can ONLY ever drop the v1 tree, never the live task
-- table: it fires only in the pre-rename state — `runbooks` is still a base table
-- AND `task_items` carries the v1 tree shape (a `parent_id` column). After the
-- rename, `task_items` is the renamed `runbook_items` (a `section_id`, no
-- `parent_id`) and this block is a no-op. The external v1 Task Tree backup is
-- captured and checksum-locked in scripts/verify_task_tree_retirement_backup.py.
DO $$
DECLARE
    runbooks_kind "char";
    task_items_is_v1_tree boolean;
BEGIN
    SELECT relkind INTO runbooks_kind FROM pg_class WHERE oid = to_regclass('runbooks');
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'task_items'
          AND column_name = 'parent_id'
    ) INTO task_items_is_v1_tree;

    IF runbooks_kind IN ('r', 'p') AND task_items_is_v1_tree THEN
        DROP TABLE IF EXISTS task_operations;
        DROP TABLE IF EXISTS task_items;
        DROP FUNCTION IF EXISTS task_tree_notify_change();
    END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS agent_profiles (
    agent_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    atom_contexts JSONB NOT NULL DEFAULT '[]'::jsonb,
    default_preset TEXT,
    aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
    portrait_blob BYTEA,
    portrait_mime TEXT,
    portrait_sha256 TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT agent_profiles_agent_id_nonempty CHECK (length(agent_id) > 0),
    CONSTRAINT agent_profiles_name_nonempty CHECK (length(name) > 0),
    CONSTRAINT agent_profiles_atom_contexts_array CHECK (jsonb_typeof(atom_contexts) = 'array'),
    CONSTRAINT agent_profiles_aliases_array CHECK (jsonb_typeof(aliases) = 'array'),
    CONSTRAINT agent_profiles_version_positive CHECK (version > 0),
    CONSTRAINT agent_profiles_portrait_complete CHECK (
        (portrait_blob IS NULL AND portrait_mime IS NULL AND portrait_sha256 IS NULL)
        OR
        (portrait_blob IS NOT NULL AND portrait_mime IS NOT NULL AND portrait_sha256 IS NOT NULL)
    ),
    CONSTRAINT agent_profiles_portrait_mime_supported CHECK (
        portrait_mime IS NULL OR portrait_mime IN (
            'image/png', 'image/jpeg', 'image/webp', 'image/gif'
        )
    ),
    CONSTRAINT agent_profiles_portrait_sha256_format CHECK (
        portrait_sha256 IS NULL OR portrait_sha256 ~ '^[0-9a-f]{64}$'
    )
);

CREATE INDEX IF NOT EXISTS idx_agent_profiles_updated_at
    ON agent_profiles(updated_at DESC, agent_id ASC);

-- 042_runbook_to_task.sql mirror: this must run before any canonical Task DDL.
-- A legacy runbooks table plus task_items means v1 Task Tree still occupies the
-- namespace, so 041 must be applied by a human before this schema is deployed.
DO $$
DECLARE
    legacy_kind "char";
    task_items_kind "char";
BEGIN
    SELECT relkind INTO legacy_kind FROM pg_class WHERE oid = to_regclass('runbooks');
    SELECT relkind INTO task_items_kind FROM pg_class WHERE oid = to_regclass('task_items');

    IF legacy_kind IN ('r', 'p') AND task_items_kind IN ('r', 'p') THEN
        RAISE EXCEPTION '041_retire_task_tree.sql must run before 042_runbook_to_task.sql';
    END IF;

    IF legacy_kind IN ('r', 'p') THEN
        IF EXISTS (
            SELECT 1 FROM pg_class WHERE oid = to_regclass('tasks') AND relkind IN ('r', 'p')
        ) THEN
            RAISE EXCEPTION 'cannot rename runbooks: tasks table already exists';
        END IF;
        ALTER TABLE runbooks RENAME TO tasks;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('runbook_sections') AND relkind IN ('r', 'p')) THEN
        ALTER TABLE runbook_sections RENAME TO task_sections;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('runbook_items') AND relkind IN ('r', 'p')) THEN
        ALTER TABLE runbook_items RENAME TO task_items;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('runbook_operations') AND relkind IN ('r', 'p')) THEN
        ALTER TABLE runbook_operations RENAME TO task_operations;
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_class
        WHERE oid = to_regclass('checklist_runbook_projection_outbox') AND relkind IN ('r', 'p')
    ) THEN
        ALTER TABLE checklist_runbook_projection_outbox RENAME TO checklist_task_projection_outbox;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'task_sections' AND column_name = 'runbook_id'
    ) THEN
        ALTER TABLE task_sections RENAME COLUMN runbook_id TO task_id;
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'task_operations' AND column_name = 'runbook_id'
    ) THEN
        ALTER TABLE task_operations RENAME COLUMN runbook_id TO task_id;
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'board_items' AND column_name = 'source_runbook_item_id'
    ) THEN
        ALTER TABLE board_items RENAME COLUMN source_runbook_item_id TO source_task_item_id;
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'session_page_bindings' AND column_name = 'source_runbook_item_id'
    ) THEN
        ALTER TABLE session_page_bindings RENAME COLUMN source_runbook_item_id TO source_task_item_id;
    END IF;

    IF to_regclass('board_items') IS NOT NULL THEN
        ALTER TABLE board_items DROP CONSTRAINT IF EXISTS board_items_item_type_check;
        UPDATE board_items SET item_type = 'task' WHERE item_type = 'runbook';
        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'board_items'
              AND column_name = 'container_kind'
        ) THEN
            ALTER TABLE board_items DROP CONSTRAINT IF EXISTS board_items_container_kind_check;
            UPDATE board_items SET container_kind = 'task' WHERE container_kind = 'runbook';
        END IF;
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'board_yjs_catalog_cache'
          AND column_name = 'container_kind'
    ) THEN
        ALTER TABLE board_yjs_catalog_cache DROP CONSTRAINT IF EXISTS board_yjs_catalog_cache_container_kind_check;
        UPDATE board_yjs_catalog_cache SET container_kind = 'task' WHERE container_kind = 'runbook';
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'session_page_bindings'
          AND column_name = 'legacy_container_kind'
    ) THEN
        ALTER TABLE session_page_bindings DROP CONSTRAINT IF EXISTS session_page_bindings_container_kind_check;
        UPDATE session_page_bindings SET legacy_container_kind = 'task' WHERE legacy_container_kind = 'runbook';
    END IF;
    IF to_regclass('task_operations') IS NOT NULL THEN
        ALTER TABLE task_operations DROP CONSTRAINT IF EXISTS runbook_operations_target_kind_check;
        ALTER TABLE task_operations DROP CONSTRAINT IF EXISTS task_operations_target_kind_check;
        UPDATE task_operations
        SET target_kind = CASE WHEN target_kind = 'runbook' THEN 'task' ELSE target_kind END,
            operation_type = replace(operation_type, 'runbook', 'task')
        WHERE target_kind = 'runbook' OR operation_type LIKE '%runbook%';
    END IF;
    -- Do not mirror 042's blocks rewrite here. Page/block canonical state lives
    -- in Y.Doc; direct SQL changes only the relational projection and is reverted
    -- when the live document is loaded. Use the page mutation API instead.
    IF to_regclass('folders') IS NOT NULL THEN
        UPDATE folders SET name = '📋 업무' WHERE name = '📒 런북';
    END IF;
END;
$$;

-- ============================================================
-- 1. 테이블
-- ============================================================

CREATE TABLE IF NOT EXISTS folders (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    parent_folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
    project_page_id TEXT,
    archived    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 기존 테이블에 settings 컬럼 추가 (멱등)
ALTER TABLE folders ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}';
-- 기존 테이블에 created_at 컬럼 추가 (멱등)
ALTER TABLE folders ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
-- 기존 테이블에 parent_folder_id 컬럼 추가 (멱등)
ALTER TABLE folders ADD COLUMN IF NOT EXISTS parent_folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL;
-- 사용자 폴더는 프로젝트 페이지와 한 객체다. legacy NULL은 승인된 백필 전까지만 허용한다.
ALTER TABLE folders ADD COLUMN IF NOT EXISTS project_page_id TEXT;
ALTER TABLE folders ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;

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
    model_preset            TEXT,
    model                   TEXT,
    caller_session_id       TEXT,
    notify_completion       BOOLEAN NOT NULL DEFAULT TRUE,
    termination_reason      TEXT,
    termination_detail      TEXT,
    termination_event_id    INTEGER,
    last_assistant_text     TEXT,
    review_required         BOOLEAN NOT NULL DEFAULT FALSE,
    review_state            TEXT NOT NULL DEFAULT 'not_required',
    predecessor_session_id  TEXT REFERENCES sessions(session_id) ON DELETE SET NULL
);

-- 기존 테이블에 caller_session_id 컬럼 추가 (멱등)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS caller_session_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS model_preset TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS notify_completion BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS predecessor_session_id TEXT;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_predecessor_session_id_fkey;
ALTER TABLE sessions ADD CONSTRAINT sessions_predecessor_session_id_fkey
    FOREIGN KEY (predecessor_session_id) REFERENCES sessions(session_id) ON DELETE SET NULL;

-- away_summary 컬럼 추가 (멱등)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS away_summary TEXT;

-- Session termination and review state columns (idempotent).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS termination_reason TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS termination_detail TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS termination_event_id INTEGER;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_assistant_text TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS review_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS review_state TEXT NOT NULL DEFAULT 'not_required';
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_review_state_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_review_state_check
    CHECK (review_state IN ('not_required', 'needs_review', 'acknowledged'));

CREATE TABLE IF NOT EXISTS session_digests (
    session_id                  TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
    narrative                   TEXT NOT NULL,
    highlight                   TEXT NOT NULL,
    narrative_through_event_id  INTEGER NOT NULL,
    fold_count                  INTEGER NOT NULL DEFAULT 0,
    version                     INTEGER NOT NULL DEFAULT 1,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE session_digests ADD COLUMN IF NOT EXISTS narrative TEXT NOT NULL DEFAULT '';
ALTER TABLE session_digests ADD COLUMN IF NOT EXISTS highlight TEXT NOT NULL DEFAULT '';
ALTER TABLE session_digests ADD COLUMN IF NOT EXISTS narrative_through_event_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_digests ADD COLUMN IF NOT EXISTS fold_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_digests ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE session_digests ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE session_digests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Async intervention/completion delivery ledger.
-- Existing installations receive this table through versioned migration 045.
CREATE TABLE IF NOT EXISTS session_deliveries (
    delivery_id                TEXT PRIMARY KEY,
    enqueue_sequence           BIGINT GENERATED ALWAYS AS IDENTITY,
    target_session_id          TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    source_session_id          TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    relation_key               TEXT NOT NULL,
    completion_id              TEXT,
    intent                     TEXT NOT NULL,
    source                     TEXT NOT NULL,
    producer_kind              TEXT,
    producer_id                TEXT,
    producer_terminal_revision TEXT,
    parent_delivery_id         TEXT,
    caller_turn_id             TEXT,
    payload_hash               TEXT NOT NULL,
    payload                    JSONB NOT NULL DEFAULT '{}'::jsonb,
    state                      TEXT NOT NULL DEFAULT 'pending',
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_at                 TIMESTAMPTZ,
    dispatching_at             TIMESTAMPTZ,
    lease_owner                TEXT,
    lease_expires_at           TIMESTAMPTZ,
    attempt_count              INTEGER NOT NULL DEFAULT 0,
    next_attempt_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error                 TEXT,
    queued_at                  TIMESTAMPTZ,
    delivered_at               TIMESTAMPTZ,
    consumed_at                TIMESTAMPTZ,
    superseded_at              TIMESTAMPTZ,
    superseded_terminal_revision TEXT,
    CONSTRAINT session_deliveries_relation_unique
        UNIQUE (relation_key),
    CONSTRAINT session_deliveries_intent_check
        CHECK (intent IN (
            'human_live_steer',
            'durable_next_turn',
            'completion_notification',
            'runtime_followup'
        )),
    CONSTRAINT session_deliveries_state_check
        CHECK (state IN (
            'pending',
            'claimed',
            'dispatching',
            'queued',
            'delivered',
            'consumed',
            'superseded',
            'uncertain'
    ))
);

ALTER TABLE session_deliveries
    DROP CONSTRAINT IF EXISTS session_deliveries_target_session_id_fkey;
ALTER TABLE session_deliveries
    ALTER COLUMN target_session_id DROP NOT NULL;
ALTER TABLE session_deliveries
    ADD CONSTRAINT session_deliveries_target_session_id_fkey
    FOREIGN KEY (target_session_id)
    REFERENCES sessions(session_id)
    ON DELETE SET NULL;
ALTER TABLE session_deliveries
    ADD COLUMN IF NOT EXISTS enqueue_sequence BIGINT GENERATED ALWAYS AS IDENTITY,
    ADD COLUMN IF NOT EXISTS dispatching_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS lease_owner TEXT,
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS last_error TEXT,
    ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS superseded_terminal_revision TEXT;
ALTER TABLE session_deliveries
    DROP CONSTRAINT IF EXISTS session_deliveries_state_check;
ALTER TABLE session_deliveries
    ADD CONSTRAINT session_deliveries_state_check
    CHECK (state IN (
        'pending',
        'claimed',
        'dispatching',
        'queued',
        'delivered',
        'consumed',
        'superseded',
        'uncertain'
    ));

CREATE INDEX IF NOT EXISTS idx_session_deliveries_target_state
    ON session_deliveries(target_session_id, state, created_at);
CREATE INDEX IF NOT EXISTS idx_session_deliveries_recovery
    ON session_deliveries(state, next_attempt_at, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS idx_session_deliveries_completion
    ON session_deliveries(completion_id)
    WHERE completion_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_session_deliveries_source_terminal_revision
    ON session_deliveries(source_session_id, producer_terminal_revision, state)
    WHERE intent = 'completion_notification'
      AND source = 'completion_notifier';
CREATE INDEX IF NOT EXISTS idx_session_deliveries_runtime_followup_latest
    ON session_deliveries (
        target_session_id,
        (payload->>'followup_key'),
        created_at,
        enqueue_sequence
    )
    WHERE intent = 'runtime_followup'
      AND source = 'claude_runtime_task_followup';

-- Semantic completion consumption is intentionally independent from the
-- delivery row. A caller can consume an inline child result before the
-- notifier creates session_deliveries, and target session deletion must not
-- erase that exactly-once fact.
CREATE TABLE IF NOT EXISTS session_delivery_relation_consumptions (
    relation_key       TEXT PRIMARY KEY,
    completion_id      TEXT NOT NULL,
    caller_session_id  TEXT NOT NULL,
    consumed_turn_id   TEXT NOT NULL,
    consumed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_delivery_relation_consumptions_caller
    ON session_delivery_relation_consumptions(caller_session_id, consumed_at);

CREATE TABLE IF NOT EXISTS session_delivery_notification_outbox (
    delivery_id        TEXT PRIMARY KEY
        REFERENCES session_deliveries(delivery_id) ON DELETE CASCADE,
    target_session_id  TEXT NOT NULL,
    payload            JSONB NOT NULL,
    disposition        TEXT NOT NULL,
    state              TEXT NOT NULL DEFAULT 'claimed',
    lease_owner        TEXT,
    lease_expires_at   TIMESTAMPTZ,
    attempt_count      INTEGER NOT NULL DEFAULT 0,
    next_attempt_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error         TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at       TIMESTAMPTZ,
    dead_lettered_at   TIMESTAMPTZ,
    CONSTRAINT session_delivery_notification_disposition_check
        CHECK (disposition IN ('queued', 'auto_resume')),
    CONSTRAINT session_delivery_notification_state_check
        CHECK (state IN ('pending', 'claimed', 'published', 'dead_letter'))
);

ALTER TABLE session_delivery_notification_outbox
    ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;
ALTER TABLE session_delivery_notification_outbox
    DROP CONSTRAINT IF EXISTS session_delivery_notification_state_check;
ALTER TABLE session_delivery_notification_outbox
    ADD CONSTRAINT session_delivery_notification_state_check
    CHECK (state IN ('pending', 'claimed', 'published', 'dead_letter'));

CREATE INDEX IF NOT EXISTS idx_session_delivery_notification_recovery
    ON session_delivery_notification_outbox(
        state,
        next_attempt_at,
        lease_expires_at,
        created_at
    );

-- Persistent Claude background task lifecycle journal.
-- Existing installations receive this table through versioned migration 046.
CREATE TABLE IF NOT EXISTS claude_background_tasks (
    source_node              TEXT NOT NULL,
    session_id               TEXT NOT NULL,
    task_id                  TEXT NOT NULL,
    sdk_session_id           TEXT,
    status                   TEXT NOT NULL DEFAULT 'running',
    close_reason             TEXT,
    description              TEXT,
    summary                  TEXT,
    output_file              TEXT,
    tool_use_id              TEXT,
    terminal_revision        TEXT,
    notification_delivery_id TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    terminal_at              TIMESTAMPTZ,
    PRIMARY KEY (source_node, session_id, task_id),
    CONSTRAINT claude_background_tasks_status_check
        CHECK (status IN (
            'pending',
            'running',
            'completed',
            'failed',
            'stopped',
            'killed'
        ))
);

CREATE INDEX IF NOT EXISTS idx_claude_background_tasks_active_node
    ON claude_background_tasks(source_node, updated_at, session_id, task_id)
    WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_claude_background_tasks_delivery
    ON claude_background_tasks(notification_delivery_id)
    WHERE notification_delivery_id IS NOT NULL;

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

CREATE OR REPLACE FUNCTION board_assert_session_ydoc_refs_removed()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM board_yjs_catalog_cache cache
        WHERE (
            jsonb_typeof(cache.board_items) <> 'array'
            AND cache.board_items::text LIKE '%' || OLD.session_id || '%'
        ) OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(cache.board_items) = 'array'
                    THEN cache.board_items ELSE '[]'::jsonb END
            ) AS entry(value)
            WHERE (
                entry.value ->> 'id' = 'session:' || OLD.session_id
                OR (
                    COALESCE(entry.value ->> 'itemType', entry.value ->> 'item_type') = 'session'
                    AND COALESCE(entry.value ->> 'itemId', entry.value ->> 'item_id') = OLD.session_id
                )
            )
        )
    ) THEN
        RAISE EXCEPTION
            'session % still has a board Y.Doc card; remove canonical card before deleting session',
            OLD.session_id
            USING ERRCODE = '23503';
    END IF;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS board_assert_session_ydoc_refs_removed_trigger ON sessions;
CREATE TRIGGER board_assert_session_ydoc_refs_removed_trigger
BEFORE DELETE ON sessions
FOR EACH ROW EXECUTE FUNCTION board_assert_session_ydoc_refs_removed();

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
    source_task_item_id TEXT,
    item_type              TEXT NOT NULL CHECK (item_type IN ('session', 'markdown', 'subfolder', 'asset', 'frame', 'task', 'custom_view')),
    item_id                TEXT NOT NULL,
    x                      DOUBLE PRECISION NOT NULL DEFAULT 0,
    y                      DOUBLE PRECISION NOT NULL DEFAULT 0,
    metadata               JSONB NOT NULL DEFAULT '{}',
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT board_items_container_kind_check
        CHECK (container_kind IN ('folder','task')),
    CONSTRAINT board_items_membership_kind_check
        CHECK (membership_kind IN ('primary','reference')),
    CONSTRAINT uq_board_items_container_item
        UNIQUE (container_kind, container_id, item_id)
);

ALTER TABLE board_items ADD COLUMN IF NOT EXISTS container_kind TEXT NOT NULL DEFAULT 'folder';
ALTER TABLE board_items ADD COLUMN IF NOT EXISTS container_id TEXT;
ALTER TABLE board_items ADD COLUMN IF NOT EXISTS membership_kind TEXT NOT NULL DEFAULT 'primary';
ALTER TABLE board_items ADD COLUMN IF NOT EXISTS source_task_item_id TEXT;
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
    CHECK (item_type IN ('session', 'markdown', 'subfolder', 'asset', 'frame', 'task', 'custom_view'));
ALTER TABLE board_items DROP CONSTRAINT IF EXISTS board_items_container_kind_check;
ALTER TABLE board_items ADD CONSTRAINT board_items_container_kind_check
    CHECK (container_kind IN ('folder','task'));
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
    revision    INTEGER NOT NULL DEFAULT 1,
    synced_at   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE board_yjs_documents ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE board_yjs_documents ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION board_yjs_documents_advance_revision()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.snapshot IS DISTINCT FROM OLD.snapshot THEN
        NEW.revision := OLD.revision + 1;
    ELSE
        NEW.revision := OLD.revision;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_board_yjs_documents_advance_revision ON board_yjs_documents;
CREATE TRIGGER trg_board_yjs_documents_advance_revision
    BEFORE UPDATE OF snapshot ON board_yjs_documents
    FOR EACH ROW EXECUTE FUNCTION board_yjs_documents_advance_revision();

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
        CHECK (container_kind IN ('folder','task')),
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
    CHECK (container_kind IN ('folder','task'));
ALTER TABLE board_yjs_catalog_cache DROP CONSTRAINT IF EXISTS board_yjs_catalog_cache_pkey;
ALTER TABLE board_yjs_catalog_cache ADD CONSTRAINT board_yjs_catalog_cache_pkey
    PRIMARY KEY (container_kind, container_id);

UPDATE board_yjs_catalog_cache cache
SET board_items = normalized.board_items
FROM (
    SELECT source.container_kind,
           source.container_id,
           jsonb_agg(
             (entry.value - 'sourceRunbookItemId' - 'runbookId')
             || CASE WHEN entry.value ? 'sourceRunbookItemId'
                  THEN jsonb_build_object('sourceTaskItemId', entry.value -> 'sourceRunbookItemId')
                  ELSE '{}'::jsonb END
             || CASE WHEN entry.value ? 'runbookId'
                  THEN jsonb_build_object('taskId', entry.value -> 'runbookId')
                  ELSE '{}'::jsonb END
             || CASE WHEN entry.value ->> 'itemType' = 'runbook'
                  THEN jsonb_build_object('itemType', 'task')
                  ELSE '{}'::jsonb END
             || CASE WHEN entry.value ->> 'containerKind' = 'runbook'
                  THEN jsonb_build_object('containerKind', 'task')
                  ELSE '{}'::jsonb END
             ORDER BY entry.ordinality
           ) AS board_items
    FROM board_yjs_catalog_cache source
    CROSS JOIN LATERAL jsonb_array_elements(source.board_items)
      WITH ORDINALITY AS entry(value, ordinality)
    GROUP BY source.container_kind, source.container_id
) normalized
WHERE cache.container_kind = normalized.container_kind
  AND cache.container_id = normalized.container_id;

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

CREATE TABLE IF NOT EXISTS event_ingress_receipts (
    node_id      TEXT NOT NULL,
    stream_id    UUID NOT NULL,
    source_seq   BIGINT NOT NULL CHECK (source_seq > 0),
    session_id   TEXT NOT NULL,
    payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    event_id     INTEGER NOT NULL,
    effect_application JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (node_id, stream_id, source_seq),
    FOREIGN KEY (session_id, event_id)
        REFERENCES events(session_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_event_ingress_receipts_event
    ON event_ingress_receipts (session_id, event_id);

CREATE TABLE IF NOT EXISTS session_mutation_receipts (
    idempotency_key TEXT PRIMARY KEY,
    operation       TEXT NOT NULL,
    session_id      TEXT NOT NULL,
    request_hash    TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    result_json     JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_mutation_receipts_session
    ON session_mutation_receipts (session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS board_custom_views (
    id                 TEXT PRIMARY KEY,
    board_item_id      TEXT NOT NULL UNIQUE REFERENCES board_items(id) ON DELETE CASCADE,
    title              TEXT,
    html               TEXT NOT NULL DEFAULT '',
    revision           INTEGER NOT NULL DEFAULT 1,
    archived           BOOLEAN NOT NULL DEFAULT FALSE,
    created_actor_kind TEXT NOT NULL DEFAULT 'agent'
                       CHECK (created_actor_kind IN ('agent','user','system','llm')),
    created_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    created_event_id   INTEGER,
    updated_actor_kind TEXT NOT NULL DEFAULT 'agent'
                       CHECK (updated_actor_kind IN ('agent','user','system','llm')),
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
ALTER TABLE board_custom_views ADD COLUMN IF NOT EXISTS created_actor_kind TEXT NOT NULL DEFAULT 'agent';
ALTER TABLE board_custom_views ADD COLUMN IF NOT EXISTS created_session_id TEXT;
ALTER TABLE board_custom_views ADD COLUMN IF NOT EXISTS created_event_id INTEGER;
ALTER TABLE board_custom_views ADD COLUMN IF NOT EXISTS updated_actor_kind TEXT NOT NULL DEFAULT 'agent';
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
ALTER TABLE board_custom_views DROP CONSTRAINT IF EXISTS board_custom_views_created_actor_kind_check;
ALTER TABLE board_custom_views ADD CONSTRAINT board_custom_views_created_actor_kind_check
    CHECK (created_actor_kind IN ('agent','user','system','llm'));
ALTER TABLE board_custom_views DROP CONSTRAINT IF EXISTS board_custom_views_updated_actor_kind_check;
ALTER TABLE board_custom_views ADD CONSTRAINT board_custom_views_updated_actor_kind_check
    CHECK (updated_actor_kind IN ('agent','user','system','llm'));

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
CREATE INDEX IF NOT EXISTS idx_board_items_folder ON board_items (folder_id, y, x);
CREATE INDEX IF NOT EXISTS idx_board_items_container ON board_items (container_kind, container_id, y, x);
CREATE INDEX IF NOT EXISTS idx_board_items_ref ON board_items (item_type, item_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_board_items_primary_membership
    ON board_items (item_type, item_id)
    WHERE membership_kind = 'primary';
CREATE INDEX IF NOT EXISTS idx_board_yjs_catalog_cache_folder
    ON board_yjs_catalog_cache (folder_id);
CREATE INDEX IF NOT EXISTS idx_board_yjs_updates_document ON board_yjs_updates (document_name, id);

CREATE INDEX IF NOT EXISTS idx_claude_transcript_load
    ON claude_transcript_entries (project_key, session_id, subpath, id);
CREATE INDEX IF NOT EXISTS idx_claude_transcript_sessions
    ON claude_transcript_entries (project_key, session_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_claude_transcript_entry_uuid
    ON claude_transcript_entries (project_key, session_id, subpath, entry_uuid)
    WHERE entry_uuid IS NOT NULL;

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

-- Additive model-preset-aware registration. Older worker signatures remain intact.
DROP FUNCTION IF EXISTS session_register_with_model_preset(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BOOLEAN, BOOLEAN, TEXT, TEXT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION session_register_with_model_preset(
    p_session_id             TEXT,
    p_node_id                TEXT,
    p_agent_id               TEXT,
    p_claude_session_id      TEXT,
    p_session_type           TEXT,
    p_prompt                 TEXT,
    p_client_id              TEXT,
    p_status                 TEXT,
    p_created_at             TIMESTAMPTZ,
    p_updated_at             TIMESTAMPTZ,
    p_caller_session_id      TEXT,
    p_notify_completion      BOOLEAN,
    p_review_required        BOOLEAN,
    p_review_state           TEXT,
    p_predecessor_session_id TEXT,
    p_model_preset           TEXT,
    p_model                  TEXT
) RETURNS void LANGUAGE sql AS $$
    INSERT INTO sessions (
        session_id, node_id, agent_id, claude_session_id,
        session_type, prompt, client_id, status,
        created_at, updated_at, caller_session_id, notify_completion,
        review_required, review_state, predecessor_session_id,
        model_preset, model
    ) VALUES (
        p_session_id, p_node_id, p_agent_id, p_claude_session_id,
        p_session_type, p_prompt, p_client_id, p_status,
        p_created_at, p_updated_at, p_caller_session_id,
        COALESCE(p_notify_completion, TRUE),
        COALESCE(p_review_required, FALSE),
        COALESCE(p_review_state, 'not_required'),
        p_predecessor_session_id, p_model_preset, p_model
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

-- session_rotate_claude_id (복구 가능한 backend session 1회 교체)
-- expected → new 원자 교체, 이미 new면 event ingress replay를 위한 no-op.
CREATE OR REPLACE FUNCTION session_rotate_claude_id(
    p_session_id                TEXT,
    p_expected_claude_session_id TEXT,
    p_new_claude_session_id     TEXT
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    v_existing TEXT;
BEGIN
    SELECT claude_session_id INTO v_existing
    FROM sessions
    WHERE session_id = p_session_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Session not found: %', p_session_id;
    ELSIF v_existing = p_new_claude_session_id THEN
        NULL;
    ELSIF v_existing IS DISTINCT FROM p_expected_claude_session_id THEN
        RAISE EXCEPTION 'claude_session_id rotation predecessor mismatch: session_id=%, expected=%, existing=%, new=%',
            p_session_id, p_expected_claude_session_id, v_existing, p_new_claude_session_id;
    ELSE
        UPDATE sessions
        SET claude_session_id = p_new_claude_session_id,
            updated_at = NOW()
        WHERE session_id = p_session_id;
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

CREATE OR REPLACE FUNCTION session_apply_terminal_transition(
    p_session_id           TEXT,
    p_status               TEXT,
    p_termination_reason   TEXT,
    p_termination_detail   TEXT,
    p_review_state         TEXT,
    p_last_assistant_text  TEXT,
    p_terminal_event_id    INTEGER,
    p_updated_at           TIMESTAMPTZ
) RETURNS TABLE (
    applied                BOOLEAN,
    status                 TEXT,
    termination_reason     TEXT,
    termination_detail     TEXT,
    review_state           TEXT,
    last_assistant_text    TEXT,
    termination_event_id   INTEGER,
    updated_at              TIMESTAMPTZ,
    last_event_id           INTEGER
) LANGUAGE plpgsql AS $$
DECLARE
    v_row_count INTEGER;
BEGIN
    IF p_terminal_event_id IS NULL OR p_terminal_event_id <= 0 THEN
        RAISE EXCEPTION 'terminal event id must be a positive integer';
    END IF;

    UPDATE sessions AS session
       SET status = p_status,
           termination_reason = p_termination_reason,
           termination_detail = p_termination_detail,
           review_state = p_review_state,
           last_assistant_text = p_last_assistant_text,
           termination_event_id = p_terminal_event_id,
           updated_at = p_updated_at
     WHERE session.session_id = p_session_id
       AND session.termination_event_id IS NULL;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;

    RETURN QUERY
    SELECT v_row_count = 1,
           session.status,
           session.termination_reason,
           session.termination_detail,
           session.review_state,
           session.last_assistant_text,
           session.termination_event_id,
           session.updated_at,
           session.last_event_id
      FROM sessions AS session
     WHERE session.session_id = p_session_id;
END;
$$;

CREATE OR REPLACE FUNCTION session_apply_running_transition(
    p_session_id                 TEXT,
    p_review_state               TEXT,
    p_expected_terminal_event_id INTEGER,
    p_terminal_resume            BOOLEAN,
    p_updated_at                 TIMESTAMPTZ
) RETURNS TABLE (
    applied                BOOLEAN,
    status                 TEXT,
    termination_reason     TEXT,
    termination_detail     TEXT,
    review_state           TEXT,
    last_assistant_text    TEXT,
    termination_event_id   INTEGER,
    updated_at              TIMESTAMPTZ,
    last_event_id           INTEGER
) LANGUAGE plpgsql AS $$
DECLARE
    v_row_count INTEGER;
BEGIN
    IF p_terminal_resume THEN
        UPDATE sessions AS session
           SET status = 'running',
               termination_reason = NULL,
               termination_detail = NULL,
               termination_event_id = NULL,
               last_assistant_text = NULL,
               review_state = p_review_state,
               updated_at = p_updated_at
         WHERE session.session_id = p_session_id
           AND session.status IN ('completed', 'error', 'interrupted')
           AND session.termination_event_id IS NOT DISTINCT FROM p_expected_terminal_event_id;
    ELSE
        UPDATE sessions AS session
           SET status = 'running',
               termination_reason = NULL,
               termination_detail = NULL,
               review_state = p_review_state,
               updated_at = p_updated_at
         WHERE session.session_id = p_session_id
           AND session.status NOT IN ('completed', 'error');
    END IF;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;

    IF p_terminal_resume AND v_row_count = 1 THEN
        UPDATE session_deliveries
           SET state = 'superseded',
               aggregate_state = 'consumed',
               consumed_at = p_updated_at,
               consumed_reason = 'superseded by terminal resume',
               superseded_at = p_updated_at,
               superseded_terminal_revision = p_expected_terminal_event_id::text,
               lease_owner = NULL,
               lease_expires_at = NULL,
               updated_at = p_updated_at
         WHERE source_session_id = p_session_id
           AND intent = 'completion_notification'
           AND source = 'completion_notifier'
           AND producer_kind = 'child_session'
           AND producer_terminal_revision = p_expected_terminal_event_id::text
           AND state IN ('pending', 'claimed', 'dispatching', 'queued');
    END IF;

    RETURN QUERY
    SELECT v_row_count = 1,
           session.status,
           session.termination_reason,
           session.termination_detail,
           session.review_state,
           session.last_assistant_text,
           session.termination_event_id,
           session.updated_at,
           session.last_event_id
      FROM sessions AS session
     WHERE session.session_id = p_session_id;
END;
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
    IF p_filters IS NOT NULL AND p_filters ? 'review_state' THEN
        q := q || ' AND s.review_state = ' || quote_literal(p_filters->>'review_state');
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'search' THEN
        q := q || ' AND (' ||
            'COALESCE(s.display_name, '''') ILIKE ' ||
                quote_literal('%' || (p_filters->>'search') || '%') ||
            ' OR s.session_id ILIKE ' ||
                quote_literal('%' || (p_filters->>'search') || '%') ||
            ' OR COALESCE(s.node_id, '''') ILIKE ' ||
                quote_literal('%' || (p_filters->>'search') || '%') ||
            ' OR COALESCE(f.name, '''') ILIKE ' ||
                quote_literal('%' || (p_filters->>'search') || '%') ||
            ')';
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
    IF p_filters IS NOT NULL AND p_filters ? 'review_state' THEN
        q := q || ' AND s.review_state = ' || quote_literal(p_filters->>'review_state');
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'search' THEN
        q := q || ' AND (' ||
            'COALESCE(s.display_name, '''') ILIKE ' ||
                quote_literal('%' || (p_filters->>'search') || '%') ||
            ' OR s.session_id ILIKE ' ||
                quote_literal('%' || (p_filters->>'search') || '%') ||
            ' OR COALESCE(s.node_id, '''') ILIKE ' ||
                quote_literal('%' || (p_filters->>'search') || '%') ||
            ' OR COALESCE(f.name, '''') ILIKE ' ||
                quote_literal('%' || (p_filters->>'search') || '%') ||
            ')';
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

CREATE OR REPLACE FUNCTION session_apply_metadata_entry(
    p_session_id            TEXT,
    p_metadata_json         TEXT,
    p_replace_existing_type TEXT,
    p_updated_at            TIMESTAMPTZ
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    v_metadata JSONB;
BEGIN
    SELECT COALESCE(metadata, '[]'::jsonb)
      INTO v_metadata
      FROM sessions
     WHERE session_id = p_session_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Session not found: %', p_session_id;
    END IF;

    IF p_replace_existing_type IS NOT NULL THEN
        SELECT COALESCE(jsonb_agg(entry), '[]'::jsonb)
          INTO v_metadata
          FROM jsonb_array_elements(v_metadata) AS entry
         WHERE entry->>'type' IS DISTINCT FROM p_replace_existing_type;
    END IF;

    UPDATE sessions
       SET metadata = v_metadata || jsonb_build_array(p_metadata_json::jsonb),
           updated_at = p_updated_at
     WHERE session_id = p_session_id;
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

CREATE OR REPLACE FUNCTION session_id_search(
    p_query       TEXT,
    p_event_types TEXT[] DEFAULT NULL,
    p_limit       INTEGER DEFAULT 50
) RETURNS TABLE(
    id              INTEGER,
    session_id      TEXT,
    event_type      TEXT,
    payload         JSONB,
    searchable_text TEXT,
    created_at      TIMESTAMPTZ,
    score           FLOAT
) LANGUAGE sql STABLE AS $$
    WITH matched_sessions AS (
        SELECT s.session_id
        FROM sessions s
        WHERE s.session_id ILIKE '%' || p_query || '%'
        ORDER BY s.updated_at DESC
        LIMIT p_limit
    )
    SELECT latest.id, latest.session_id, latest.event_type, latest.payload,
           latest.searchable_text, latest.created_at,
           0.5::FLOAT AS score
    FROM matched_sessions matched
    CROSS JOIN LATERAL (
        SELECT e.id, e.session_id, e.event_type,
               e.payload, e.searchable_text, e.created_at
        FROM events e
        WHERE e.session_id = matched.session_id
          AND (p_event_types IS NULL OR e.event_type = ANY(p_event_types))
        ORDER BY e.id DESC
        LIMIT 1
    ) latest
    ORDER BY latest.id DESC
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
    model_preset TEXT,
    model TEXT,
    total_count   BIGINT
) LANGUAGE sql STABLE AS $$
    WITH filtered AS (
        SELECT s.session_id, s.display_name, s.status, s.session_type,
               s.created_at, s.updated_at,
               (SELECT COUNT(*) FROM events e WHERE e.session_id = s.session_id) AS event_count,
               s.away_summary, s.caller_session_id,
               s.last_event_id, s.last_read_event_id, s.node_id,
               s.model_preset, s.model
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
    SELECT * FROM folders WHERE id = p_id AND archived = FALSE;
$$;

-- 25. folder_delete
CREATE OR REPLACE FUNCTION folder_delete(
    p_id TEXT
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    UPDATE sessions SET folder_id = NULL WHERE folder_id = p_id;
    UPDATE folders SET parent_folder_id = NULL WHERE parent_folder_id = p_id;
    DELETE FROM board_items WHERE folder_id = p_id;
    DELETE FROM board_items WHERE item_type = 'subfolder' AND item_id = p_id;
    UPDATE folders SET archived = TRUE WHERE id = p_id;
END;
$$;

-- 26. folder_get_all
CREATE OR REPLACE FUNCTION folder_get_all()
RETURNS SETOF folders LANGUAGE sql STABLE AS $$
    SELECT * FROM folders WHERE archived = FALSE ORDER BY sort_order, name;
$$;

-- 27. folder_get_default
CREATE OR REPLACE FUNCTION folder_get_default(
    p_name TEXT
) RETURNS SETOF folders LANGUAGE sql STABLE AS $$
    SELECT * FROM folders WHERE name = p_name AND archived = FALSE;
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

-- 067: generation-fenced execution ownership and delivery convergence
--
-- This migration is intentionally additive. Existing state columns and
-- transition functions remain available while orch and node releases roll.

CREATE TABLE IF NOT EXISTS session_execution_ownerships (
    session_id                 TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    ownership_generation       BIGINT NOT NULL,
    owner_kind                 TEXT NOT NULL,
    manifest_id                TEXT NOT NULL,
    registration_id            TEXT,
    pid                        INTEGER,
    start_identity             TEXT,
    execution_command_id       TEXT,
    phase                      TEXT NOT NULL DEFAULT 'reserved',
    runner_fact                TEXT,
    reserved_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    identity_proven_at         TIMESTAMPTZ,
    activated_at               TIMESTAMPTZ,
    reservation_expires_at     TIMESTAMPTZ,
    terminal_at                TIMESTAMPTZ,
    failure_reason             TEXT,
    PRIMARY KEY (session_id, ownership_generation),
    CONSTRAINT session_execution_ownership_owner_kind_check
        CHECK (owner_kind IN ('runner_process', 'adopted_runner', 'in_process')),
    CONSTRAINT session_execution_ownership_phase_check
        CHECK (phase IN ('reserved', 'identity_proven', 'active', 'terminal', 'failed')),
    CONSTRAINT session_execution_ownership_runner_fact_check
        CHECK (runner_fact IS NULL OR runner_fact IN ('completed', 'failed', 'reaped', 'closed')),
    CONSTRAINT session_execution_ownership_identity_shape_check
        CHECK (
            phase IN ('reserved', 'failed')
            OR (
                registration_id IS NOT NULL
                AND pid IS NOT NULL
                AND start_identity IS NOT NULL
                AND execution_command_id IS NOT NULL
                AND identity_proven_at IS NOT NULL
            )
        ),
    CONSTRAINT session_execution_ownership_reservation_lease_check
        CHECK (
            (phase IN ('reserved', 'identity_proven') AND reservation_expires_at IS NOT NULL)
            OR (phase NOT IN ('reserved', 'identity_proven'))
        )
);

DROP INDEX IF EXISTS idx_session_execution_ownership_open;
CREATE UNIQUE INDEX idx_session_execution_ownership_open
    ON session_execution_ownerships(session_id)
    WHERE phase = 'active';

CREATE INDEX IF NOT EXISTS idx_session_execution_ownership_identity
    ON session_execution_ownerships(registration_id, pid, start_identity)
    WHERE registration_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS session_execution_ownership_migration_audit (
    audit_id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id                 TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    action                     TEXT NOT NULL,
    manifest_id                TEXT,
    registration_id            TEXT,
    pid                        INTEGER,
    start_identity             TEXT,
    execution_command_id       TEXT,
    first_observed_at          TIMESTAMPTZ,
    second_observed_at         TIMESTAMPTZ,
    evidence_hash              TEXT,
    first_observation          JSONB,
    second_observation         JSONB,
    detail                     TEXT NOT NULL,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT session_execution_ownership_audit_action_check
        CHECK (action IN ('observed', 'backfilled', 'interrupted'))
);

ALTER TABLE session_execution_ownership_migration_audit
    ADD COLUMN IF NOT EXISTS execution_command_id TEXT,
    ADD COLUMN IF NOT EXISTS evidence_hash TEXT,
    ADD COLUMN IF NOT EXISTS first_observation JSONB,
    ADD COLUMN IF NOT EXISTS second_observation JSONB;

CREATE OR REPLACE VIEW session_owner_null_running_inventory AS
SELECT session.session_id, session.node_id, session.updated_at
FROM sessions AS session
WHERE session.status = 'running'
  AND NOT EXISTS (
      SELECT 1
      FROM session_execution_ownerships AS ownership
      WHERE ownership.session_id = session.session_id
        AND ownership.phase = 'active'
  );

CREATE OR REPLACE FUNCTION session_reserve_execution_ownership(
    p_session_id               TEXT,
    p_ownership_generation     BIGINT,
    p_owner_kind               TEXT,
    p_manifest_id              TEXT,
    p_updated_at               TIMESTAMPTZ
) RETURNS TABLE (
    applied                    BOOLEAN,
    ownership_generation       BIGINT,
    status                     TEXT,
    termination_reason         TEXT,
    termination_detail         TEXT,
    review_state               TEXT,
    last_assistant_text        TEXT,
    termination_event_id       INTEGER,
    updated_at                 TIMESTAMPTZ,
    last_event_id              INTEGER
) LANGUAGE plpgsql AS $$
DECLARE
BEGIN
    IF p_owner_kind NOT IN ('runner_process', 'adopted_runner', 'in_process') THEN
        RAISE EXCEPTION 'unsupported execution owner kind: %', p_owner_kind;
    END IF;
    IF p_manifest_id IS NULL OR p_manifest_id = '' THEN
        RAISE EXCEPTION 'execution manifest id required';
    END IF;
    IF p_ownership_generation IS NULL OR p_ownership_generation <= 0 THEN
        RAISE EXCEPTION 'positive execution ownership generation required';
    END IF;

    PERFORM 1 FROM sessions WHERE session_id = p_session_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'session not found: %', p_session_id;
    END IF;

    UPDATE session_execution_ownerships
       SET phase = 'failed', failure_reason = 'reservation lease expired',
           terminal_at = p_updated_at, reservation_expires_at = NULL
     WHERE session_id = p_session_id
       AND phase IN ('reserved', 'identity_proven')
       AND reservation_expires_at <= p_updated_at;

    IF EXISTS (
        SELECT 1 FROM session_execution_ownerships
        WHERE session_id = p_session_id
          AND phase IN ('reserved', 'identity_proven', 'active')
    ) THEN
        RETURN QUERY
        SELECT FALSE, ownership.ownership_generation,
               session.status, session.termination_reason,
               session.termination_detail, session.review_state,
               session.last_assistant_text, session.termination_event_id,
               session.updated_at, session.last_event_id
        FROM sessions AS session
        JOIN LATERAL (
            SELECT candidate.ownership_generation
              FROM session_execution_ownerships AS candidate
             WHERE candidate.session_id = session.session_id
               AND candidate.phase IN ('reserved', 'identity_proven', 'active')
             ORDER BY CASE candidate.phase WHEN 'active' THEN 0 ELSE 1 END,
                      candidate.ownership_generation DESC
             LIMIT 1
        ) AS ownership ON TRUE
        WHERE session.session_id = p_session_id;
        RETURN;
    END IF;

    INSERT INTO session_execution_ownerships (
        session_id, ownership_generation, owner_kind, manifest_id,
        phase, reserved_at, reservation_expires_at
    ) VALUES (
        p_session_id, p_ownership_generation, p_owner_kind, p_manifest_id,
        'reserved', p_updated_at, p_updated_at + INTERVAL '60 seconds'
    );

    RETURN QUERY
    SELECT TRUE, p_ownership_generation,
           session.status, session.termination_reason,
           session.termination_detail, session.review_state,
           session.last_assistant_text, session.termination_event_id,
           session.updated_at, session.last_event_id
      FROM sessions AS session
     WHERE session.session_id = p_session_id;
END;
$$;

CREATE OR REPLACE FUNCTION session_prove_execution_ownership(
    p_session_id               TEXT,
    p_ownership_generation     BIGINT,
    p_registration_id          TEXT,
    p_pid                      INTEGER,
    p_start_identity           TEXT,
    p_execution_command_id     TEXT,
    p_proven_at                TIMESTAMPTZ
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
    v_row_count INTEGER;
BEGIN
    IF p_registration_id IS NULL OR p_registration_id = ''
       OR p_pid IS NULL OR p_pid <= 0
       OR p_start_identity IS NULL OR p_start_identity = ''
       OR p_execution_command_id IS NULL OR p_execution_command_id = '' THEN
        RAISE EXCEPTION 'complete execution identity proof required';
    END IF;
    UPDATE session_execution_ownerships
       SET registration_id = p_registration_id,
           pid = p_pid,
           start_identity = p_start_identity,
           execution_command_id = p_execution_command_id,
           phase = 'identity_proven',
           identity_proven_at = p_proven_at,
           reservation_expires_at = p_proven_at + INTERVAL '60 seconds'
     WHERE session_id = p_session_id
       AND ownership_generation = p_ownership_generation
       AND phase = 'reserved'
       AND reservation_expires_at > p_proven_at;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RETURN v_row_count = 1;
END;
$$;

CREATE OR REPLACE FUNCTION session_mark_execution_orphaned_spawn(
    p_session_id               TEXT,
    p_ownership_generation     BIGINT,
    p_registration_id          TEXT,
    p_pid                      INTEGER,
    p_start_identity           TEXT,
    p_execution_command_id     TEXT,
    p_updated_at               TIMESTAMPTZ
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
    v_row_count INTEGER;
BEGIN
    IF p_registration_id IS NULL OR p_registration_id = ''
       OR p_pid IS NULL OR p_pid <= 0
       OR p_start_identity IS NULL OR p_start_identity = ''
       OR p_execution_command_id IS NULL OR p_execution_command_id = '' THEN
        RAISE EXCEPTION 'complete orphaned spawn identity required';
    END IF;
    UPDATE session_execution_ownerships
       SET registration_id = p_registration_id,
           pid = p_pid,
           start_identity = p_start_identity,
           execution_command_id = p_execution_command_id,
           phase = 'identity_proven',
           identity_proven_at = p_updated_at,
           reservation_expires_at = p_updated_at + INTERVAL '60 seconds',
           failure_reason = 'orphaned_spawn'
     WHERE session_id = p_session_id
       AND ownership_generation = p_ownership_generation
       AND phase = 'reserved'
       AND reservation_expires_at > p_updated_at;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RETURN v_row_count = 1;
END;
$$;

CREATE OR REPLACE FUNCTION session_reserve_execution_adoption(
    p_session_id               TEXT,
    p_ownership_generation     BIGINT,
    p_manifest_id              TEXT,
    p_previous_registration_id TEXT,
    p_pid                      INTEGER,
    p_start_identity           TEXT,
    p_execution_command_id     TEXT,
    p_updated_at               TIMESTAMPTZ
) RETURNS TABLE (
    applied                    BOOLEAN,
    status                     TEXT,
    termination_reason         TEXT,
    termination_detail         TEXT,
    review_state               TEXT,
    last_assistant_text        TEXT,
    termination_event_id       INTEGER,
    updated_at                 TIMESTAMPTZ,
    last_event_id              INTEGER
) LANGUAGE plpgsql AS $$
DECLARE
    v_row_count INTEGER := 0;
    v_previous_generation BIGINT;
BEGIN
    PERFORM 1 FROM sessions WHERE session_id = p_session_id FOR UPDATE;
    UPDATE session_execution_ownerships
       SET phase = 'failed', failure_reason = 'reservation lease expired',
           terminal_at = p_updated_at, reservation_expires_at = NULL
     WHERE session_id = p_session_id
       AND phase IN ('reserved', 'identity_proven')
       AND reservation_expires_at <= p_updated_at;
    SELECT ownership_generation
      INTO v_previous_generation
      FROM session_execution_ownerships
     WHERE session_id = p_session_id
       AND (
           phase = 'active'
           OR (
               phase = 'identity_proven'
               AND failure_reason = 'orphaned_spawn'
               AND reservation_expires_at > p_updated_at
           )
       )
       AND manifest_id = p_manifest_id
       AND registration_id = p_previous_registration_id
       AND pid = p_pid
       AND start_identity = p_start_identity
       AND execution_command_id = p_execution_command_id
     ORDER BY CASE phase WHEN 'active' THEN 0 ELSE 1 END
     LIMIT 1
     FOR UPDATE;
    IF FOUND AND NOT EXISTS (
        SELECT 1 FROM session_execution_ownerships
         WHERE session_id = p_session_id
           AND ownership_generation <> v_previous_generation
           AND phase IN ('reserved', 'identity_proven')
    ) THEN
        INSERT INTO session_execution_ownerships (
            session_id, ownership_generation, owner_kind, manifest_id,
            phase, reserved_at, reservation_expires_at
        ) VALUES (
            p_session_id, p_ownership_generation, 'adopted_runner', p_manifest_id,
            'reserved', p_updated_at, p_updated_at + INTERVAL '60 seconds'
        );
        v_row_count := 1;
    END IF;
    RETURN QUERY
    SELECT v_row_count = 1, session.status, session.termination_reason,
           session.termination_detail, session.review_state,
           session.last_assistant_text, session.termination_event_id,
           session.updated_at, session.last_event_id
      FROM sessions AS session
     WHERE session.session_id = p_session_id;
END;
$$;

CREATE OR REPLACE FUNCTION session_activate_execution_ownership(
    p_session_id                 TEXT,
    p_ownership_generation       BIGINT,
    p_review_state               TEXT,
    p_expected_terminal_event_id INTEGER,
    p_terminal_resume            BOOLEAN,
    p_updated_at                 TIMESTAMPTZ
) RETURNS TABLE (
    applied                    BOOLEAN,
    status                     TEXT,
    termination_reason         TEXT,
    termination_detail         TEXT,
    review_state               TEXT,
    last_assistant_text        TEXT,
    termination_event_id       INTEGER,
    updated_at                 TIMESTAMPTZ,
    last_event_id              INTEGER
) LANGUAGE plpgsql AS $$
DECLARE
    v_row_count INTEGER := 0;
    v_owner_kind TEXT;
    v_manifest_id TEXT;
    v_registration_id TEXT;
    v_pid INTEGER;
    v_start_identity TEXT;
    v_execution_command_id TEXT;
BEGIN
    SELECT owner_kind, manifest_id, registration_id, pid, start_identity,
           execution_command_id
      INTO v_owner_kind, v_manifest_id, v_registration_id, v_pid,
           v_start_identity, v_execution_command_id
      FROM session_execution_ownerships
     WHERE session_id = p_session_id
       AND ownership_generation = p_ownership_generation
       AND phase = 'identity_proven'
       AND reservation_expires_at > p_updated_at
     FOR UPDATE;
    IF FOUND THEN
        IF v_owner_kind = 'adopted_runner' THEN
            PERFORM 1
             FROM session_execution_ownerships
             WHERE session_id = p_session_id
               AND ownership_generation <> p_ownership_generation
               AND (
                   phase = 'active'
                   OR (
                       phase = 'identity_proven'
                       AND failure_reason = 'orphaned_spawn'
                       AND reservation_expires_at > p_updated_at
                   )
               )
               AND manifest_id = v_manifest_id
               AND registration_id = v_registration_id
               AND pid = v_pid
               AND start_identity = v_start_identity
               AND execution_command_id = v_execution_command_id
             FOR UPDATE;
            IF NOT FOUND THEN
                RETURN QUERY
                SELECT FALSE, session.status, session.termination_reason,
                       session.termination_detail, session.review_state,
                       session.last_assistant_text, session.termination_event_id,
                       session.updated_at, session.last_event_id
                  FROM sessions AS session
                 WHERE session.session_id = p_session_id;
                RETURN;
            END IF;
        END IF;
        IF p_terminal_resume THEN
            UPDATE sessions AS session
               SET status = 'running', termination_reason = NULL,
                   termination_detail = NULL, termination_event_id = NULL,
                   last_assistant_text = NULL, review_state = p_review_state,
                   updated_at = p_updated_at
             WHERE session.session_id = p_session_id
               AND session.status IN ('completed', 'error', 'interrupted')
               AND session.termination_event_id IS NOT DISTINCT FROM p_expected_terminal_event_id;
        ELSE
            UPDATE sessions AS session
               SET status = 'running', termination_reason = NULL,
                   termination_detail = NULL, review_state = p_review_state,
                   updated_at = p_updated_at
             WHERE session.session_id = p_session_id
               AND session.status NOT IN ('completed', 'error', 'interrupted');
        END IF;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        IF v_row_count = 1 THEN
            IF v_owner_kind = 'adopted_runner' THEN
                UPDATE session_execution_ownerships
                   SET phase = 'terminal', terminal_at = p_updated_at,
                       reservation_expires_at = NULL,
                       failure_reason = 'ownership handed to adopting host'
                 WHERE session_id = p_session_id
                   AND ownership_generation <> p_ownership_generation
                   AND (
                       phase = 'active'
                       OR (
                           phase = 'identity_proven'
                           AND failure_reason = 'orphaned_spawn'
                       )
                   )
                   AND manifest_id = v_manifest_id
                   AND registration_id = v_registration_id
                   AND pid = v_pid
                   AND start_identity = v_start_identity
                   AND execution_command_id = v_execution_command_id;
            END IF;
            UPDATE session_execution_ownerships
               SET phase = 'active', activated_at = p_updated_at,
                   reservation_expires_at = NULL
             WHERE session_id = p_session_id
               AND ownership_generation = p_ownership_generation
               AND phase = 'identity_proven';
            IF p_terminal_resume THEN
                UPDATE session_deliveries
                   SET state = 'superseded',
                       aggregate_state = 'consumed',
                       consumed_at = p_updated_at,
                       consumed_reason = 'superseded by terminal resume',
                       superseded_at = p_updated_at,
                       superseded_terminal_revision = p_expected_terminal_event_id::text,
                       lease_owner = NULL,
                       lease_expires_at = NULL,
                       updated_at = p_updated_at
                 WHERE source_session_id = p_session_id
                   AND intent = 'completion_notification'
                   AND source = 'completion_notifier'
                   AND producer_kind = 'child_session'
                   AND producer_terminal_revision = p_expected_terminal_event_id::text
                   AND state IN ('pending', 'claimed', 'dispatching', 'queued');
            END IF;
        END IF;
    END IF;

    RETURN QUERY
    SELECT v_row_count = 1, session.status, session.termination_reason,
           session.termination_detail, session.review_state,
           session.last_assistant_text, session.termination_event_id,
           session.updated_at, session.last_event_id
      FROM sessions AS session
     WHERE session.session_id = p_session_id;
END;
$$;

CREATE OR REPLACE FUNCTION session_project_runner_terminal_fact(
    p_session_id               TEXT,
    p_ownership_generation     BIGINT,
    p_execution_command_id     TEXT,
    p_runner_fact              TEXT,
    p_termination_detail       TEXT,
    p_review_state             TEXT,
    p_last_assistant_text      TEXT,
    p_terminal_event_id        INTEGER,
    p_updated_at               TIMESTAMPTZ
) RETURNS TABLE (
    applied                    BOOLEAN,
    status                     TEXT,
    termination_reason         TEXT,
    termination_detail         TEXT,
    review_state               TEXT,
    last_assistant_text        TEXT,
    termination_event_id       INTEGER,
    updated_at                 TIMESTAMPTZ,
    last_event_id              INTEGER
) LANGUAGE plpgsql AS $$
DECLARE
    v_status TEXT;
    v_reason TEXT;
    v_existing_status TEXT;
    v_row_count INTEGER := 0;
BEGIN
    IF p_runner_fact NOT IN ('completed', 'failed', 'reaped', 'closed') THEN
        RAISE EXCEPTION 'unsupported runner terminal fact: %', p_runner_fact;
    END IF;
    IF p_execution_command_id IS NULL OR p_execution_command_id = '' THEN
        RAISE EXCEPTION 'execution command id must be non-empty';
    END IF;
    IF p_terminal_event_id IS NULL OR p_terminal_event_id <= 0 THEN
        RAISE EXCEPTION 'terminal event id must be a positive integer';
    END IF;
    v_status := CASE p_runner_fact
        WHEN 'completed' THEN 'completed'
        WHEN 'closed' THEN 'interrupted'
        ELSE 'error'
    END;
    v_reason := CASE p_runner_fact
        WHEN 'completed' THEN 'completed_ok'
        WHEN 'closed' THEN 'killed'
        ELSE 'error_aborted'
    END;

    SELECT session.status INTO v_existing_status
      FROM sessions AS session
     WHERE session.session_id = p_session_id
     FOR UPDATE;

    UPDATE session_execution_ownerships AS ownership
       SET phase = 'terminal', runner_fact = p_runner_fact,
           terminal_at = p_updated_at
     WHERE ownership.session_id = p_session_id
       AND ownership.ownership_generation = p_ownership_generation
       AND ownership.execution_command_id = p_execution_command_id
       AND ownership.phase = 'active';
    GET DIAGNOSTICS v_row_count = ROW_COUNT;

    IF v_row_count = 1
       AND v_existing_status NOT IN ('completed', 'error', 'interrupted') THEN
        UPDATE sessions AS session
           SET status = v_status, termination_reason = v_reason,
               termination_detail = p_termination_detail,
               review_state = p_review_state,
               last_assistant_text = p_last_assistant_text,
               termination_event_id = p_terminal_event_id,
               updated_at = p_updated_at
         WHERE session.session_id = p_session_id;
    END IF;

    RETURN QUERY
    SELECT v_row_count = 1
             AND v_existing_status NOT IN ('completed', 'error', 'interrupted'),
           session.status, session.termination_reason,
           session.termination_detail, session.review_state,
           session.last_assistant_text, session.termination_event_id,
           session.updated_at, session.last_event_id
      FROM sessions AS session
     WHERE session.session_id = p_session_id;
END;
$$;

CREATE OR REPLACE FUNCTION session_project_recovered_runner_terminal_fact(
    p_session_id               TEXT,
    p_manifest_id              TEXT,
    p_registration_id          TEXT,
    p_pid                      INTEGER,
    p_start_identity           TEXT,
    p_execution_command_id     TEXT,
    p_runner_fact              TEXT,
    p_termination_detail       TEXT,
    p_review_state             TEXT,
    p_last_assistant_text      TEXT,
    p_terminal_event_id        INTEGER,
    p_updated_at               TIMESTAMPTZ
) RETURNS TABLE (
    applied                    BOOLEAN,
    status                     TEXT,
    termination_reason         TEXT,
    termination_detail         TEXT,
    review_state               TEXT,
    last_assistant_text        TEXT,
    termination_event_id       INTEGER,
    updated_at                 TIMESTAMPTZ,
    last_event_id              INTEGER
) LANGUAGE plpgsql AS $$
DECLARE
    v_ownership_generation BIGINT;
BEGIN
    SELECT ownership.ownership_generation
      INTO v_ownership_generation
      FROM session_execution_ownerships AS ownership
     WHERE ownership.session_id = p_session_id
       AND ownership.manifest_id = p_manifest_id
       AND ownership.registration_id = p_registration_id
       AND ownership.pid = p_pid
       AND ownership.start_identity = p_start_identity
       AND ownership.execution_command_id = p_execution_command_id
       AND ownership.phase = 'active'
     FOR UPDATE;

    IF FOUND THEN
        RETURN QUERY
        SELECT *
          FROM session_project_runner_terminal_fact(
              p_session_id,
              v_ownership_generation,
              p_execution_command_id,
              p_runner_fact,
              p_termination_detail,
              p_review_state,
              p_last_assistant_text,
              p_terminal_event_id,
              p_updated_at
          );
        RETURN;
    END IF;

    RETURN QUERY
    SELECT FALSE, session.status, session.termination_reason,
           session.termination_detail, session.review_state,
           session.last_assistant_text, session.termination_event_id,
           session.updated_at, session.last_event_id
      FROM sessions AS session
     WHERE session.session_id = p_session_id;
END;
$$;

CREATE OR REPLACE FUNCTION session_fail_execution_ownership(
    p_session_id               TEXT,
    p_ownership_generation     BIGINT,
    p_failure_reason           TEXT,
    p_failed_at                TIMESTAMPTZ
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
    v_row_count INTEGER;
BEGIN
    UPDATE session_execution_ownerships
       SET phase = 'failed', failure_reason = p_failure_reason,
           terminal_at = p_failed_at, reservation_expires_at = NULL
     WHERE session_id = p_session_id
       AND ownership_generation = p_ownership_generation
       AND phase IN ('reserved', 'identity_proven');
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RETURN v_row_count = 1;
END;
$$;

CREATE OR REPLACE FUNCTION session_expire_dead_execution_owner(
    p_session_id               TEXT,
    p_ownership_generation     BIGINT,
    p_pid                      INTEGER,
    p_start_identity           TEXT,
    p_failure_reason           TEXT,
    p_failed_at                TIMESTAMPTZ
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
    v_row_count INTEGER;
BEGIN
    IF p_start_identity IS NULL OR p_start_identity = '' THEN
        RAISE EXCEPTION 'dead owner start identity required';
    END IF;

    UPDATE session_execution_ownerships
       SET phase = 'failed', failure_reason = p_failure_reason,
           terminal_at = p_failed_at, reservation_expires_at = NULL
     WHERE session_id = p_session_id
       AND ownership_generation = p_ownership_generation
       AND phase IN ('identity_proven', 'active')
       AND pid = p_pid
       AND start_identity = p_start_identity;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RETURN v_row_count = 1;
END;
$$;

CREATE OR REPLACE FUNCTION session_backfill_execution_ownership(
    p_session_id               TEXT,
    p_first_manifest_id        TEXT,
    p_first_registration_id    TEXT,
    p_first_pid                INTEGER,
    p_first_start_identity     TEXT,
    p_first_execution_command_id TEXT,
    p_first_observed_at        TIMESTAMPTZ,
    p_second_manifest_id       TEXT,
    p_second_registration_id   TEXT,
    p_second_pid               INTEGER,
    p_second_start_identity    TEXT,
    p_second_execution_command_id TEXT,
    p_second_observed_at       TIMESTAMPTZ,
    p_evidence_hash            TEXT,
    p_minimum_lease_interval_ms INTEGER,
    p_probe_only               BOOLEAN
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
    v_generation BIGINT;
    v_identity_complete BOOLEAN;
    v_first_observation JSONB;
    v_second_observation JSONB;
BEGIN
    PERFORM 1 FROM sessions
     WHERE session_id = p_session_id AND status = 'running'
     FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_running'; END IF;
    IF EXISTS (
        SELECT 1 FROM session_execution_ownerships
        WHERE session_id = p_session_id AND phase = 'active'
    ) THEN RETURN 'already_owned'; END IF;

    v_first_observation := jsonb_build_object(
        'manifest_id', p_first_manifest_id,
        'registration_id', p_first_registration_id,
        'pid', p_first_pid,
        'start_identity', p_first_start_identity,
        'execution_command_id', p_first_execution_command_id
    );
    v_second_observation := jsonb_build_object(
        'manifest_id', p_second_manifest_id,
        'registration_id', p_second_registration_id,
        'pid', p_second_pid,
        'start_identity', p_second_start_identity,
        'execution_command_id', p_second_execution_command_id
    );
    IF p_probe_only THEN RETURN 'observation_required'; END IF;

    v_identity_complete := p_first_manifest_id IS NOT NULL
      AND p_first_manifest_id <> ''
      AND p_first_registration_id IS NOT NULL
      AND p_first_registration_id <> ''
      AND p_first_pid > 0
      AND p_first_start_identity IS NOT NULL
      AND p_first_start_identity <> ''
      AND p_first_execution_command_id IS NOT NULL
      AND p_first_execution_command_id <> ''
      AND p_second_manifest_id IS NOT DISTINCT FROM p_first_manifest_id
      AND p_second_registration_id IS NOT DISTINCT FROM p_first_registration_id
      AND p_second_pid IS NOT DISTINCT FROM p_first_pid
      AND p_second_start_identity IS NOT DISTINCT FROM p_first_start_identity
      AND p_second_execution_command_id IS NOT DISTINCT FROM p_first_execution_command_id
      AND p_evidence_hash ~ '^[0-9a-f]{64}$'
      AND p_minimum_lease_interval_ms > 0
      AND p_second_observed_at - p_first_observed_at
          >= p_minimum_lease_interval_ms * INTERVAL '1 millisecond';
    IF v_identity_complete THEN
        SELECT COALESCE(MAX(ownership_generation), 0) + 1 INTO v_generation
          FROM session_execution_ownerships WHERE session_id = p_session_id;
        INSERT INTO session_execution_ownerships (
            session_id, ownership_generation, owner_kind, manifest_id,
            registration_id, pid, start_identity, execution_command_id,
            phase, reserved_at, identity_proven_at, activated_at
        ) VALUES (
            p_session_id, v_generation, 'adopted_runner', p_second_manifest_id,
            p_second_registration_id, p_second_pid, p_second_start_identity,
            p_second_execution_command_id,
            'active', p_first_observed_at, p_second_observed_at, p_second_observed_at
        );
        INSERT INTO session_execution_ownership_migration_audit (
            session_id, action, manifest_id, registration_id, pid,
            start_identity, execution_command_id, first_observed_at,
            second_observed_at, evidence_hash, first_observation,
            second_observation, detail
        ) VALUES (
            p_session_id, 'backfilled', p_second_manifest_id,
            p_second_registration_id, p_second_pid, p_second_start_identity,
            p_second_execution_command_id, p_first_observed_at, p_second_observed_at,
            p_evidence_hash, v_first_observation, v_second_observation,
            'stable identity observed across lease interval'
        );
        RETURN 'backfilled';
    END IF;

    UPDATE sessions
       SET status = 'interrupted', termination_reason = 'unknown',
           termination_detail = 'owner-null running migration could not prove a stable runner identity',
           updated_at = NOW()
     WHERE session_id = p_session_id AND status = 'running';
    INSERT INTO session_execution_ownership_migration_audit (
        session_id, action, manifest_id, registration_id, pid,
        start_identity, execution_command_id, first_observed_at,
        second_observed_at, evidence_hash, first_observation,
        second_observation, detail
    ) VALUES (
        p_session_id, 'interrupted', p_second_manifest_id,
        p_second_registration_id, p_second_pid, p_second_start_identity,
        p_second_execution_command_id, p_first_observed_at, p_second_observed_at,
        p_evidence_hash, v_first_observation, v_second_observation,
        'two-scan identity mismatch or incomplete proof; session converged to interrupted'
    );
    RETURN 'interrupted';
END;
$$;

ALTER TABLE session_deliveries
    ADD COLUMN IF NOT EXISTS aggregate_state TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS target_receipt_id TEXT,
    ADD COLUMN IF NOT EXISTS target_receipt_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS consumed_reason TEXT,
    ADD COLUMN IF NOT EXISTS dead_letter_reason TEXT,
    ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;

ALTER TABLE session_deliveries
    DROP CONSTRAINT IF EXISTS session_deliveries_aggregate_state_check;
ALTER TABLE session_deliveries
    ADD CONSTRAINT session_deliveries_aggregate_state_check
    CHECK (aggregate_state IN ('pending', 'delivered', 'consumed', 'dead_letter'));

CREATE TABLE IF NOT EXISTS session_delivery_attempts (
    delivery_id                TEXT NOT NULL REFERENCES session_deliveries(delivery_id) ON DELETE CASCADE,
    attempt_number             INTEGER NOT NULL,
    lease_owner                TEXT,
    payload_hash               TEXT NOT NULL,
    outcome                    TEXT NOT NULL,
    reason                     TEXT,
    target_receipt_id          TEXT,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (delivery_id, attempt_number),
    CONSTRAINT session_delivery_attempts_outcome_check
        CHECK (outcome IN ('accepted', 'retryable', 'rejected'))
);

ALTER TABLE session_delivery_notification_outbox
    ADD COLUMN IF NOT EXISTS projection_state TEXT NOT NULL DEFAULT 'staged',
    ADD COLUMN IF NOT EXISTS target_receipt_id TEXT,
    ADD COLUMN IF NOT EXISTS target_receipt_at TIMESTAMPTZ;
ALTER TABLE session_delivery_notification_outbox
    DROP CONSTRAINT IF EXISTS session_delivery_notification_projection_state_check;
ALTER TABLE session_delivery_notification_outbox
    ADD CONSTRAINT session_delivery_notification_projection_state_check
    CHECK (projection_state IN ('staged', 'publishing', 'published', 'discarded'));

UPDATE session_deliveries
SET aggregate_state = 'consumed',
    consumed_reason = CASE
        WHEN state = 'superseded'
        THEN COALESCE(superseded_terminal_revision, 'superseded')
        ELSE consumed_reason
    END
WHERE state IN ('consumed', 'superseded');

WITH legacy AS MATERIALIZED (
    SELECT delivery.delivery_id,
           delivery.state,
           delivery.attempt_count,
           delivery.lease_owner,
           delivery.payload_hash,
           delivery.last_error,
           delivery.created_at,
           delivery.updated_at,
           delivery.next_attempt_at,
           delivery.target_receipt_id,
           delivery.target_receipt_at,
           receipt.target_receipt_id AS outbox_receipt_id,
           receipt.target_receipt_at AS outbox_receipt_at
    FROM session_deliveries AS delivery
    LEFT JOIN LATERAL (
        SELECT outbox.target_receipt_id, outbox.target_receipt_at
        FROM session_delivery_notification_outbox AS outbox
        WHERE outbox.delivery_id = delivery.delivery_id
          AND outbox.state = 'published'
          AND outbox.target_receipt_id IS NOT NULL
        LIMIT 1
    ) AS receipt ON TRUE
    WHERE delivery.state IN ('delivered', 'uncertain')
), updated AS (
    UPDATE session_deliveries AS delivery
    SET aggregate_state = CASE
            WHEN COALESCE(legacy.target_receipt_id, legacy.outbox_receipt_id) IS NOT NULL
            THEN 'delivered'
            WHEN legacy.attempt_count + 1 < 16
              AND legacy.created_at > NOW() - INTERVAL '24 hours'
            THEN 'pending'
            ELSE 'dead_letter'
        END,
        state = CASE
            WHEN COALESCE(legacy.target_receipt_id, legacy.outbox_receipt_id) IS NOT NULL
            THEN 'delivered'
            WHEN legacy.attempt_count + 1 < 16
              AND legacy.created_at > NOW() - INTERVAL '24 hours'
            THEN 'pending'
            ELSE 'uncertain'
        END,
        target_receipt_id = COALESCE(legacy.target_receipt_id, legacy.outbox_receipt_id),
        target_receipt_at = COALESCE(legacy.target_receipt_at, legacy.outbox_receipt_at),
        lease_owner = NULL,
        lease_expires_at = NULL,
        attempt_count = legacy.attempt_count + 1,
        next_attempt_at = CASE
            WHEN COALESCE(legacy.target_receipt_id, legacy.outbox_receipt_id) IS NULL
              AND legacy.attempt_count + 1 < 16
              AND legacy.created_at > NOW() - INTERVAL '24 hours'
            THEN LEAST(legacy.next_attempt_at, NOW())
            ELSE legacy.next_attempt_at
        END,
        last_error = CASE
            WHEN COALESCE(legacy.target_receipt_id, legacy.outbox_receipt_id) IS NULL
            THEN COALESCE(legacy.last_error, 'legacy delivery missing target receipt')
            ELSE legacy.last_error
        END,
        dead_letter_reason = CASE
            WHEN COALESCE(legacy.target_receipt_id, legacy.outbox_receipt_id) IS NULL
              AND NOT (
                legacy.attempt_count + 1 < 16
                AND legacy.created_at > NOW() - INTERVAL '24 hours'
              )
            THEN COALESCE(legacy.last_error, 'legacy delivery retry budget exhausted')
            ELSE NULL
        END,
        dead_lettered_at = CASE
            WHEN COALESCE(legacy.target_receipt_id, legacy.outbox_receipt_id) IS NULL
              AND NOT (
                legacy.attempt_count + 1 < 16
                AND legacy.created_at > NOW() - INTERVAL '24 hours'
              )
            THEN NOW()
            ELSE NULL
        END,
        updated_at = NOW()
    FROM legacy
    WHERE delivery.delivery_id = legacy.delivery_id
    RETURNING delivery.*
)
INSERT INTO session_delivery_attempts (
    delivery_id, attempt_number, lease_owner, payload_hash, outcome, reason,
    target_receipt_id, created_at
)
SELECT delivery_id, attempt_count, lease_owner, payload_hash,
       CASE aggregate_state
           WHEN 'delivered' THEN 'accepted'
           WHEN 'dead_letter' THEN 'rejected'
           ELSE 'retryable'
       END,
       COALESCE(last_error, 'legacy delivery receipt backfill'),
       target_receipt_id,
       updated_at
FROM updated
ON CONFLICT (delivery_id, attempt_number) DO NOTHING;

UPDATE session_delivery_notification_outbox AS outbox
SET projection_state = CASE
        WHEN outbox.state = 'published' AND outbox.target_receipt_id IS NOT NULL
        THEN 'published'
        WHEN delivery.aggregate_state IN ('consumed', 'dead_letter') THEN 'discarded'
        WHEN delivery.aggregate_state = 'pending' THEN 'staged'
        WHEN outbox.state = 'claimed' THEN 'publishing'
        ELSE 'staged'
    END,
    state = CASE
        WHEN delivery.aggregate_state IN ('consumed', 'dead_letter')
          AND NOT (outbox.state = 'published' AND outbox.target_receipt_id IS NOT NULL)
        THEN 'dead_letter'
        WHEN delivery.aggregate_state = 'pending'
          AND outbox.state = 'published'
          AND outbox.target_receipt_id IS NULL
        THEN 'pending'
        ELSE outbox.state
    END,
    lease_owner = CASE
        WHEN delivery.aggregate_state IN ('pending', 'consumed', 'dead_letter') THEN NULL
        ELSE outbox.lease_owner
    END,
    lease_expires_at = CASE
        WHEN delivery.aggregate_state IN ('pending', 'consumed', 'dead_letter') THEN NULL
        ELSE outbox.lease_expires_at
    END,
    last_error = CASE
        WHEN delivery.aggregate_state = 'consumed'
          AND NOT (outbox.state = 'published' AND outbox.target_receipt_id IS NOT NULL)
        THEN 'delivery aggregate consumed before notification projection'
        WHEN delivery.aggregate_state = 'pending'
          AND outbox.state = 'published'
          AND outbox.target_receipt_id IS NULL
        THEN 'published notification missing target receipt; retry required'
        ELSE outbox.last_error
    END,
    dead_lettered_at = CASE
        WHEN delivery.aggregate_state IN ('consumed', 'dead_letter')
          AND NOT (outbox.state = 'published' AND outbox.target_receipt_id IS NOT NULL)
        THEN COALESCE(outbox.dead_lettered_at, NOW())
        WHEN delivery.aggregate_state = 'pending' THEN NULL
        ELSE outbox.dead_lettered_at
    END,
    updated_at = CASE
        WHEN delivery.aggregate_state IN ('pending', 'consumed', 'dead_letter')
        THEN NOW()
        ELSE outbox.updated_at
    END
FROM session_deliveries AS delivery
WHERE delivery.delivery_id = outbox.delivery_id;

CREATE OR REPLACE FUNCTION session_discard_notification_projection_on_consumed()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.aggregate_state = 'consumed'
       AND OLD.aggregate_state IS DISTINCT FROM NEW.aggregate_state THEN
        UPDATE session_delivery_notification_outbox
           SET state = 'dead_letter',
               projection_state = 'discarded',
               lease_owner = NULL,
               lease_expires_at = NULL,
               last_error = 'delivery aggregate consumed before notification projection',
               dead_lettered_at = COALESCE(dead_lettered_at, NOW()),
               updated_at = NOW()
         WHERE delivery_id = NEW.delivery_id
           AND state IN ('pending', 'claimed');
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_session_discard_notification_projection
    ON session_deliveries;
CREATE TRIGGER trg_session_discard_notification_projection
AFTER UPDATE OF aggregate_state ON session_deliveries
FOR EACH ROW
EXECUTE FUNCTION session_discard_notification_projection_on_consumed();

CREATE INDEX IF NOT EXISTS idx_session_delivery_aggregate_recovery
    ON session_deliveries(aggregate_state, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_session_delivery_attempt_outcome
    ON session_delivery_attempts(outcome, created_at);

-- 카탈로그 --------------------------------------------------------

-- 29. catalog_get_sessions
CREATE OR REPLACE FUNCTION catalog_get_sessions()
RETURNS TABLE(session_id TEXT, folder_id TEXT, display_name TEXT)
LANGUAGE sql STABLE AS $$
    SELECT session_id, folder_id, display_name FROM sessions;
$$;

-- 29b. board_seed_items
DROP FUNCTION IF EXISTS board_seed_items();
DROP FUNCTION IF EXISTS board_seed_items(TEXT, TEXT);
CREATE OR REPLACE FUNCTION board_seed_items(p_container_kind TEXT, p_container_id TEXT)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF p_container_kind IS NULL OR p_container_kind NOT IN ('folder', 'task') THEN
        RAISE EXCEPTION 'unsupported board container kind: %', p_container_kind;
    END IF;
    IF NULLIF(BTRIM(p_container_id), '') IS NULL THEN
        RAISE EXCEPTION 'board container id must not be empty';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('soulstream:board_items')::bigint);

    -- 세션 타일 reconcile: folder 컨테이너 타일만 폴더 불일치로 삭제한다.
    -- task 컨테이너 타일은 Y.Doc이 생명주기를 소유하므로 세션 자체가
    -- 사라진 경우(고아)에만 정리한다.
    DELETE FROM board_items bi
    WHERE bi.item_type = 'session'
      AND bi.container_kind = p_container_kind
      AND bi.container_id = p_container_id
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
      AND bi.container_kind = p_container_kind
      AND bi.container_id = p_container_id
      AND NOT EXISTS (
          SELECT 1 FROM folders f
          WHERE f.id = bi.item_id
            AND f.parent_folder_id = bi.folder_id
      );

    DELETE FROM board_items bi
    WHERE bi.item_type = 'markdown'
      AND bi.container_kind = p_container_kind
      AND bi.container_id = p_container_id
      AND NOT EXISTS (
          SELECT 1 FROM markdown_documents d
          WHERE d.id = bi.item_id
      );

    DELETE FROM board_items bi
    WHERE bi.item_type = 'asset'
      AND bi.container_kind = p_container_kind
      AND bi.container_id = p_container_id
      AND NOT EXISTS (
          SELECT 1 FROM file_assets fa
          WHERE fa.id = bi.item_id
      );

    DELETE FROM board_items bi
    WHERE bi.item_type = 'custom_view'
      AND bi.container_kind = p_container_kind
      AND bi.container_id = p_container_id
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
        WHERE p_container_kind = 'folder'
          AND s.folder_id = p_container_id
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
        WHERE p_container_kind = 'folder'
          AND f.parent_folder_id = p_container_id
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
    source_task_item_id TEXT,
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
        bi.source_task_item_id,
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
            'sourceTaskItemId', bi.source_task_item_id,
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
-- prefs JSONB stores appearance, wallpaper, liquid glass, and chat font-size settings.
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

-- Tasks: collaborative checklist state and append-only provenance.
CREATE TABLE IF NOT EXISTS tasks (
    id                 TEXT PRIMARY KEY,
    board_item_id      TEXT NOT NULL REFERENCES board_items(id) ON DELETE CASCADE, -- 자기 자신의 item_type='task' board_item 1:1
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
    CONSTRAINT tasks_status_check
        CHECK (status IN ('open','completed')),
    CONSTRAINT tasks_completed_kind_check
        CHECK (completed_kind IN ('agent','user','llm')),
    FOREIGN KEY (created_session_id, created_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL,
    CONSTRAINT tasks_completed_session_id_fkey
        FOREIGN KEY (completed_session_id) REFERENCES sessions(session_id) ON DELETE SET NULL,
    CONSTRAINT tasks_completed_event_fkey
        FOREIGN KEY (completed_session_id, completed_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL
);

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_completed_session_id_completed_event_id_fkey;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_kind TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_session_id TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_event_id INTEGER;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_user_id TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
    CHECK (status IN ('open','completed'));

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_completed_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_completed_kind_check
    CHECK (completed_kind IN ('agent','user','llm'));

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_completed_session_id_fkey;
ALTER TABLE tasks ADD CONSTRAINT tasks_completed_session_id_fkey
    FOREIGN KEY (completed_session_id) REFERENCES sessions(session_id) ON DELETE SET NULL;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_completed_event_fkey;
ALTER TABLE tasks ADD CONSTRAINT tasks_completed_event_fkey
    FOREIGN KEY (completed_session_id, completed_event_id)
    REFERENCES events(session_id, id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_board_item ON tasks(board_item_id);

CREATE TABLE IF NOT EXISTS task_sections (
    id                 TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS idx_task_sections_task
    ON task_sections(task_id, position_key);

CREATE TABLE IF NOT EXISTS task_items (
    id                   TEXT PRIMARY KEY,
    section_id           TEXT NOT NULL REFERENCES task_sections(id) ON DELETE CASCADE,
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
    completed_kind       TEXT CHECK (completed_kind IN ('agent','user','llm')),
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

CREATE INDEX IF NOT EXISTS idx_task_items_section
    ON task_items(section_id, position_key);

ALTER TABLE board_items DROP CONSTRAINT IF EXISTS board_items_source_runbook_item_id_fkey;
ALTER TABLE board_items DROP CONSTRAINT IF EXISTS board_items_source_task_item_id_fkey;
ALTER TABLE board_items ADD CONSTRAINT board_items_source_task_item_id_fkey
    FOREIGN KEY (source_task_item_id) REFERENCES task_items(id) ON DELETE SET NULL;

ALTER TABLE task_items DROP CONSTRAINT IF EXISTS task_items_status_check;
ALTER TABLE task_items ADD CONSTRAINT task_items_status_check
    CHECK (status IN ('pending','in_progress','review','completed','cancelled'));

-- "내 차례"는 review이거나, 유효 담당(항목 own, 없으면 섹션 상속)이 human이고 미완·미취소.
-- 상속 케이스는 부분 인덱스로 못 잡으므로 조회 시 항목⨝섹션으로 해석한다.
CREATE INDEX IF NOT EXISTS idx_task_items_human_self
    ON task_items(section_id)
    WHERE assignee_kind = 'human'
      AND status NOT IN ('completed','cancelled')
      AND archived = FALSE;

CREATE TABLE IF NOT EXISTS task_operations (
    id               TEXT PRIMARY KEY,
    task_id       TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    target_kind      TEXT NOT NULL CHECK (target_kind IN ('task','section','item')),
    target_id        TEXT NOT NULL,
    operation_type   TEXT NOT NULL,
    actor_kind       TEXT NOT NULL DEFAULT 'agent' CHECK (actor_kind IN ('agent','user','system','llm')),
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

CREATE UNIQUE INDEX IF NOT EXISTS uq_task_ops_idem
    ON task_operations(idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_task_ops_target
    ON task_operations(target_kind, target_id, created_at);

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

ALTER TABLE folders DROP CONSTRAINT IF EXISTS folders_project_page_id_fkey;
ALTER TABLE folders ADD CONSTRAINT folders_project_page_id_fkey
    FOREIGN KEY (project_page_id) REFERENCES pages(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_folders_project_page_id
    ON folders(project_page_id) WHERE project_page_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS folder_project_operations (
    id               TEXT PRIMARY KEY,
    folder_id        TEXT NOT NULL REFERENCES folders(id) ON DELETE RESTRICT,
    operation_type   TEXT NOT NULL,
    actor_kind       TEXT NOT NULL CHECK (actor_kind IN ('agent','user','system','llm')),
    actor_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    actor_user_id    TEXT,
    idempotency_key  TEXT NOT NULL,
    payload_json     JSONB NOT NULL DEFAULT '{}'::JSONB,
    reason           TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_folder_project_ops_idem
    ON folder_project_operations(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_folder_project_ops_folder
    ON folder_project_operations(folder_id, created_at);

-- One task identity has a task execution aspect and a page document aspect.
-- New rows use task_page_id = id; legacy rows remain NULL until canonical Y.Doc backfill.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_page_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_task_page_id
    ON tasks(task_page_id) WHERE task_page_id IS NOT NULL;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_task_page_id_fkey;
ALTER TABLE tasks ADD CONSTRAINT tasks_task_page_id_fkey
    FOREIGN KEY (task_page_id) REFERENCES pages(id) ON DELETE RESTRICT;

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

CREATE TABLE IF NOT EXISTS checklist_task_projection_outbox (
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

ALTER TABLE checklist_task_projection_outbox ADD COLUMN IF NOT EXISTS page_id TEXT;
ALTER TABLE checklist_task_projection_outbox ADD COLUMN IF NOT EXISTS source_hash TEXT;
ALTER TABLE checklist_task_projection_outbox ADD COLUMN IF NOT EXISTS processed_hash TEXT;
ALTER TABLE checklist_task_projection_outbox ADD COLUMN IF NOT EXISTS actor_kind TEXT NOT NULL DEFAULT 'system';
ALTER TABLE checklist_task_projection_outbox ADD COLUMN IF NOT EXISTS actor_session_id TEXT;
ALTER TABLE checklist_task_projection_outbox ADD COLUMN IF NOT EXISTS actor_user_id TEXT;
ALTER TABLE checklist_task_projection_outbox ADD COLUMN IF NOT EXISTS routing_session_id TEXT;
ALTER TABLE checklist_task_projection_outbox ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checklist_task_projection_outbox ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE checklist_task_projection_outbox ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE checklist_task_projection_outbox ADD COLUMN IF NOT EXISTS lease_owner_node_id TEXT;
ALTER TABLE checklist_task_projection_outbox ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE checklist_task_projection_outbox ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE checklist_task_projection_outbox ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE checklist_task_projection_outbox ALTER COLUMN page_id SET NOT NULL;
ALTER TABLE checklist_task_projection_outbox ALTER COLUMN source_hash SET NOT NULL;
ALTER TABLE checklist_task_projection_outbox DROP CONSTRAINT IF EXISTS checklist_task_projection_outbox_page_id_fkey;
ALTER TABLE checklist_task_projection_outbox ADD CONSTRAINT checklist_task_projection_outbox_page_id_fkey
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE;
ALTER TABLE checklist_task_projection_outbox DROP CONSTRAINT IF EXISTS checklist_task_projection_outbox_actor_session_id_fkey;
ALTER TABLE checklist_task_projection_outbox ADD CONSTRAINT checklist_task_projection_outbox_actor_session_id_fkey
    FOREIGN KEY (actor_session_id) REFERENCES sessions(session_id) ON DELETE SET NULL;
ALTER TABLE checklist_task_projection_outbox DROP CONSTRAINT IF EXISTS checklist_task_projection_outbox_routing_session_id_fkey;
ALTER TABLE checklist_task_projection_outbox ADD CONSTRAINT checklist_task_projection_outbox_routing_session_id_fkey
    FOREIGN KEY (routing_session_id) REFERENCES sessions(session_id) ON DELETE SET NULL;
ALTER TABLE checklist_task_projection_outbox DROP CONSTRAINT IF EXISTS checklist_task_projection_outbox_actor_kind_check;
ALTER TABLE checklist_task_projection_outbox ADD CONSTRAINT checklist_task_projection_outbox_actor_kind_check
    CHECK (actor_kind IN ('agent','user','system','llm'));
ALTER TABLE checklist_task_projection_outbox DROP CONSTRAINT IF EXISTS checklist_task_projection_outbox_actor_shape_check;
ALTER TABLE checklist_task_projection_outbox ADD CONSTRAINT checklist_task_projection_outbox_actor_shape_check
    CHECK (
      (actor_kind = 'agent' AND actor_session_id IS NOT NULL AND actor_user_id IS NULL)
      OR (actor_kind = 'user' AND actor_user_id IS NOT NULL)
      OR (actor_kind = 'system' AND actor_user_id IS NULL)
      OR (actor_kind = 'llm' AND actor_session_id IS NULL AND actor_user_id IS NULL)
    );
ALTER TABLE checklist_task_projection_outbox DROP CONSTRAINT IF EXISTS checklist_task_projection_outbox_attempts_check;
ALTER TABLE checklist_task_projection_outbox ADD CONSTRAINT checklist_task_projection_outbox_attempts_check
    CHECK (attempts >= 0);

CREATE INDEX IF NOT EXISTS idx_checklist_task_projection_due
    ON checklist_task_projection_outbox(next_retry_at, updated_at, block_id)
    WHERE processed_hash IS DISTINCT FROM source_hash;

INSERT INTO checklist_task_projection_outbox (
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
    source_task_item_id TEXT,
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
      legacy_container_kind IS NULL OR legacy_container_kind IN ('folder','task')
    )
);

ALTER TABLE session_page_bindings
    DROP CONSTRAINT IF EXISTS session_page_bindings_source_task_item_id_fkey;
ALTER TABLE session_page_bindings
    ADD CONSTRAINT session_page_bindings_source_task_item_id_fkey
    FOREIGN KEY (source_task_item_id) REFERENCES task_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_session_page_bindings_due
    ON session_page_bindings(node_id, next_retry_at, created_at)
    WHERE page_state = 'pending'
       OR (page_state = 'bound' AND legacy_state = 'pending');

CREATE TABLE IF NOT EXISTS block_operations (
    id               TEXT PRIMARY KEY,
    page_id          TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    target_block_id  TEXT REFERENCES blocks(id) ON DELETE SET NULL,
    operation_type   TEXT NOT NULL,
    actor_kind       TEXT NOT NULL CHECK (actor_kind IN ('agent','user','system','llm')),
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
    CHECK (actor_kind IN ('agent','user','system','llm'));
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

-- Production-gated read compatibility; docs/task-read-compatibility.md is the
-- removal contract. UNION ALL keeps every view read-only.
CREATE OR REPLACE VIEW runbooks AS
SELECT id, board_item_id, title, status, archived, version,
       created_session_id, created_event_id, completed_kind,
       completed_session_id, completed_event_id, completed_user_id,
       completed_at, created_at, updated_at, task_page_id
FROM tasks
UNION ALL
SELECT id, board_item_id, title, status, archived, version,
       created_session_id, created_event_id, completed_kind,
       completed_session_id, completed_event_id, completed_user_id,
       completed_at, created_at, updated_at, task_page_id
FROM tasks WHERE FALSE;

CREATE OR REPLACE VIEW runbook_sections AS
SELECT id, task_id AS runbook_id, position_key, title, assignee_kind,
       assignee_agent_id, assignee_session_id, assignee_user_id, archived,
       version, created_session_id, created_event_id, updated_session_id,
       updated_event_id, created_at, updated_at
FROM task_sections
UNION ALL
SELECT id, task_id, position_key, title, assignee_kind,
       assignee_agent_id, assignee_session_id, assignee_user_id, archived,
       version, created_session_id, created_event_id, updated_session_id,
       updated_event_id, created_at, updated_at
FROM task_sections WHERE FALSE;

CREATE OR REPLACE VIEW runbook_items AS
SELECT id, section_id, position_key, title, how_to, assignee_kind,
       assignee_agent_id, assignee_session_id, assignee_user_id, status,
       archived, version, created_session_id, created_event_id,
       updated_session_id, updated_event_id, completed_kind,
       completed_session_id, completed_event_id, completed_user_id,
       completed_at, created_at, updated_at
FROM task_items
UNION ALL
SELECT id, section_id, position_key, title, how_to, assignee_kind,
       assignee_agent_id, assignee_session_id, assignee_user_id, status,
       archived, version, created_session_id, created_event_id,
       updated_session_id, updated_event_id, completed_kind,
       completed_session_id, completed_event_id, completed_user_id,
       completed_at, created_at, updated_at
FROM task_items WHERE FALSE;

CREATE OR REPLACE VIEW runbook_operations AS
SELECT id, task_id AS runbook_id,
       CASE WHEN target_kind = 'task' THEN 'runbook' ELSE target_kind END AS target_kind,
       target_id, replace(operation_type, 'task', 'runbook') AS operation_type,
       actor_kind, actor_session_id, actor_event_id, actor_user_id,
       idempotency_key, payload_json, reason, created_at
FROM task_operations
UNION ALL
SELECT id, task_id,
       CASE WHEN target_kind = 'task' THEN 'runbook' ELSE target_kind END,
       target_id, replace(operation_type, 'task', 'runbook'), actor_kind,
       actor_session_id, actor_event_id, actor_user_id, idempotency_key,
       payload_json, reason, created_at
FROM task_operations WHERE FALSE;

-- Sweep pre-llm CHECK constraints that survived under their original names.
--
-- 042 renamed runbook_* tables to task_*, but PostgreSQL keeps constraint names
-- across a rename, so a database bootstrapped before 042 still carries
-- runbooks_completed_kind_check, runbook_items_completed_kind_check,
-- runbook_operations_actor_kind_check and checklist_runbook_projection_outbox_*.
-- The name-keyed ALTER statements above are no-ops for those, and PostgreSQL
-- ANDs CHECK constraints together — one survivor keeps rejecting 'llm' even
-- though every llm-aware constraint was installed.
--
-- Unlike migration 049 this file has no verification block, so a survivor here
-- would fail silently and only surface as a rejected write at runtime. Runs
-- last so it only ever removes constraints the statements above did not
-- replace; anything already mentioning 'llm' is left alone.
DO $$
DECLARE
    target RECORD;
    legacy RECORD;
BEGIN
    FOR target IN
        SELECT *
        FROM (
            VALUES
              ('tasks', 'completed_kind'),
              ('task_items', 'completed_kind'),
              ('task_operations', 'actor_kind'),
              ('folder_project_operations', 'actor_kind'),
              ('checklist_task_projection_outbox', 'actor_kind'),
              ('block_operations', 'actor_kind'),
              ('board_custom_views', 'created_actor_kind'),
              ('board_custom_views', 'updated_actor_kind')
        ) AS targets(table_name, column_name)
    LOOP
        FOR legacy IN
            SELECT constraint_row.conname
            FROM pg_constraint constraint_row
            WHERE constraint_row.conrelid = to_regclass(target.table_name)
              AND constraint_row.contype = 'c'
              AND pg_get_constraintdef(constraint_row.oid) LIKE
                  '%' || target.column_name || '%'
              AND pg_get_constraintdef(constraint_row.oid) NOT LIKE '%''llm''%'
              AND (
                  target.table_name = 'checklist_task_projection_outbox'
                  OR pg_get_constraintdef(constraint_row.oid) LIKE '%ANY (ARRAY%'
              )
        LOOP
            EXECUTE format(
                'ALTER TABLE %I DROP CONSTRAINT %I',
                target.table_name,
                legacy.conname
            );
        END LOOP;
    END LOOP;
END;
$$;

CREATE TABLE IF NOT EXISTS node_release_activation_receipts (
    activation_generation        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    node_id                      TEXT NOT NULL,
    manifest_id                  TEXT NOT NULL,
    release_cohort_id            TEXT NOT NULL,
    source_commit                TEXT NOT NULL,
    prewarmed_at                 TIMESTAMPTZ NOT NULL,
    activated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    verification                 JSONB NOT NULL,
    registration_idempotency_key TEXT NOT NULL,
    CONSTRAINT node_release_activation_receipts_registration_key_unique
        UNIQUE (node_id, registration_idempotency_key),
    CONSTRAINT node_release_activation_receipts_verification_check
        CHECK (
            verification = jsonb_build_object(
                'host', 'verified',
                'runner', 'verified',
                'env', 'verified',
                'executable', 'verified'
            )
        )
);

CREATE INDEX IF NOT EXISTS idx_node_release_activation_receipts_node_generation
    ON node_release_activation_receipts(node_id, activation_generation DESC);

CREATE INDEX IF NOT EXISTS idx_node_release_activation_receipts_manifest
    ON node_release_activation_receipts(manifest_id);

ALTER TABLE session_execution_ownerships
    ADD COLUMN IF NOT EXISTS runtime_env_identity TEXT;

CREATE OR REPLACE FUNCTION session_reserve_execution_ownership_v2(
    p_session_id               TEXT,
    p_ownership_generation     BIGINT,
    p_owner_kind               TEXT,
    p_manifest_id              TEXT,
    p_runtime_env_identity     TEXT,
    p_updated_at               TIMESTAMPTZ
) RETURNS TABLE (
    applied                    BOOLEAN,
    ownership_generation       BIGINT,
    status                     TEXT,
    termination_reason         TEXT,
    termination_detail         TEXT,
    review_state               TEXT,
    last_assistant_text        TEXT,
    termination_event_id       INTEGER,
    updated_at                 TIMESTAMPTZ,
    last_event_id              INTEGER
) LANGUAGE plpgsql AS $$
DECLARE
    v_application RECORD;
    v_row_count INTEGER;
BEGIN
    IF p_runtime_env_identity IS NULL OR p_runtime_env_identity = '' THEN
        RAISE EXCEPTION 'runtime env identity required';
    END IF;

    SELECT * INTO v_application
      FROM session_reserve_execution_ownership(
          p_session_id,
          p_ownership_generation,
          p_owner_kind,
          p_manifest_id,
          p_updated_at
      );

    IF v_application.applied
       AND v_application.ownership_generation = p_ownership_generation THEN
        UPDATE session_execution_ownerships AS ownership
           SET runtime_env_identity = p_runtime_env_identity
         WHERE ownership.session_id = p_session_id
           AND ownership.ownership_generation = p_ownership_generation
           AND ownership.manifest_id = p_manifest_id
           AND (
               ownership.runtime_env_identity IS NULL
               OR ownership.runtime_env_identity = p_runtime_env_identity
           );
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        IF v_row_count <> 1 THEN
            RAISE EXCEPTION 'execution runtime env identity conflict';
        END IF;
    END IF;

    RETURN QUERY SELECT
        v_application.applied,
        v_application.ownership_generation,
        v_application.status,
        v_application.termination_reason,
        v_application.termination_detail,
        v_application.review_state,
        v_application.last_assistant_text,
        v_application.termination_event_id,
        v_application.updated_at,
        v_application.last_event_id;
END;
$$;

CREATE OR REPLACE FUNCTION session_reserve_execution_adoption_v2(
    p_session_id               TEXT,
    p_ownership_generation     BIGINT,
    p_manifest_id              TEXT,
    p_runtime_env_identity     TEXT,
    p_previous_registration_id TEXT,
    p_pid                      INTEGER,
    p_start_identity           TEXT,
    p_execution_command_id     TEXT,
    p_updated_at               TIMESTAMPTZ
) RETURNS TABLE (
    applied                    BOOLEAN,
    status                     TEXT,
    termination_reason         TEXT,
    termination_detail         TEXT,
    review_state               TEXT,
    last_assistant_text        TEXT,
    termination_event_id       INTEGER,
    updated_at                 TIMESTAMPTZ,
    last_event_id              INTEGER
) LANGUAGE plpgsql AS $$
DECLARE
    v_application RECORD;
    v_row_count INTEGER;
BEGIN
    IF p_runtime_env_identity IS NULL OR p_runtime_env_identity = '' THEN
        RAISE EXCEPTION 'runtime env identity required';
    END IF;

    SELECT * INTO v_application
      FROM session_reserve_execution_adoption(
          p_session_id,
          p_ownership_generation,
          p_manifest_id,
          p_previous_registration_id,
          p_pid,
          p_start_identity,
          p_execution_command_id,
          p_updated_at
      );

    IF v_application.applied THEN
        UPDATE session_execution_ownerships AS ownership
           SET runtime_env_identity = p_runtime_env_identity
         WHERE ownership.session_id = p_session_id
           AND ownership.ownership_generation = p_ownership_generation
           AND ownership.manifest_id = p_manifest_id
           AND (
               ownership.runtime_env_identity IS NULL
               OR ownership.runtime_env_identity = p_runtime_env_identity
           );
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        IF v_row_count <> 1 THEN
            RAISE EXCEPTION 'adopted execution runtime env identity conflict';
        END IF;
    END IF;

    RETURN QUERY SELECT
        v_application.applied,
        v_application.status,
        v_application.termination_reason,
        v_application.termination_detail,
        v_application.review_state,
        v_application.last_assistant_text,
        v_application.termination_event_id,
        v_application.updated_at,
        v_application.last_event_id;
END;
$$;

CREATE OR REPLACE FUNCTION session_backfill_execution_ownership_v2(
    p_session_id                 TEXT,
    p_first_manifest_id          TEXT,
    p_first_runtime_env_identity TEXT,
    p_first_registration_id      TEXT,
    p_first_pid                  INTEGER,
    p_first_start_identity       TEXT,
    p_first_execution_command_id TEXT,
    p_first_observed_at          TIMESTAMPTZ,
    p_second_manifest_id         TEXT,
    p_second_runtime_env_identity TEXT,
    p_second_registration_id     TEXT,
    p_second_pid                 INTEGER,
    p_second_start_identity      TEXT,
    p_second_execution_command_id TEXT,
    p_second_observed_at         TIMESTAMPTZ,
    p_evidence_hash              TEXT,
    p_minimum_lease_interval_ms  INTEGER,
    p_probe_only                 BOOLEAN
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
    v_action TEXT;
    v_row_count INTEGER;
BEGIN
    -- Only an observation that names a runtime can be required to identify it.
    -- The owner-null reconciler exists to report that *nothing* is running, and
    -- says so with an entirely empty observation; `session_backfill_execution_
    -- ownership` treats that as a first-class input and takes its incomplete
    -- identity branch. Requiring the identity unconditionally rejected exactly
    -- that evidence, so from migration 070 onward the reconciler threw on every
    -- real sample -- twenty-one times in one lab dead-owner run -- and an
    -- owner-null running session had nothing left that could converge it.
    IF (
        p_second_manifest_id IS NOT NULL
        OR p_second_registration_id IS NOT NULL
        OR p_second_pid IS NOT NULL
        OR p_second_start_identity IS NOT NULL
        OR p_second_execution_command_id IS NOT NULL
    ) AND (
        p_second_runtime_env_identity IS NULL OR p_second_runtime_env_identity = ''
    ) THEN
        RAISE EXCEPTION 'second runtime env identity required';
    END IF;
    IF p_first_runtime_env_identity IS NOT NULL
       AND p_first_runtime_env_identity <> p_second_runtime_env_identity THEN
        RAISE EXCEPTION 'backfill runtime env identity changed across observations';
    END IF;

    SELECT session_backfill_execution_ownership(
        p_session_id,
        p_first_manifest_id,
        p_first_registration_id,
        p_first_pid,
        p_first_start_identity,
        p_first_execution_command_id,
        p_first_observed_at,
        p_second_manifest_id,
        p_second_registration_id,
        p_second_pid,
        p_second_start_identity,
        p_second_execution_command_id,
        p_second_observed_at,
        p_evidence_hash,
        p_minimum_lease_interval_ms,
        p_probe_only
    ) INTO v_action;

    IF v_action = 'backfilled' THEN
        UPDATE session_execution_ownerships AS ownership
           SET runtime_env_identity = p_second_runtime_env_identity
         WHERE ownership.session_id = p_session_id
           AND ownership.manifest_id = p_second_manifest_id
           AND ownership.registration_id = p_second_registration_id
           AND ownership.pid = p_second_pid
           AND ownership.start_identity = p_second_start_identity
           AND ownership.execution_command_id = p_second_execution_command_id
           AND ownership.phase = 'active'
           AND (
               ownership.runtime_env_identity IS NULL
               OR ownership.runtime_env_identity = p_second_runtime_env_identity
           );
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        IF v_row_count <> 1 THEN
            RAISE EXCEPTION 'backfilled execution runtime env identity conflict';
        END IF;
    END IF;

    RETURN v_action;
END;
$$;

-- 073: recover exhausted deliveries and index strict per-target ordering

CREATE INDEX IF NOT EXISTS idx_session_deliveries_target_enqueue_open
    ON session_deliveries(target_session_id, enqueue_sequence)
    WHERE aggregate_state IN ('pending', 'delivered')
      AND state NOT IN ('consumed', 'superseded');

UPDATE session_deliveries
SET
    aggregate_state = 'pending',
    next_attempt_at = NOW(),
    dead_letter_reason = NULL,
    dead_lettered_at = NULL,
    updated_at = NOW()
WHERE state = 'uncertain'
  AND aggregate_state = 'dead_letter'
  AND target_receipt_id IS NULL
  AND attempt_count >= 16
  AND COALESCE(dead_letter_reason, '') NOT IN (
      'delivery identity conflict',
      'delivery_result_not_accepted',
      'stale_self_completion_delivery'
  );

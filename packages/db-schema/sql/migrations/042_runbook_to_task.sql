-- 042: assign the retired v1 Task Tree namespace to the current work-task model.
-- Apply only after 041_retire_task_tree.sql. Production application requires
-- a separate human approval and the migration verifier in this repository.

DO $$
DECLARE
    legacy_kind "char";
    task_items_kind "char";
BEGIN
    SELECT relkind INTO legacy_kind
    FROM pg_class
    WHERE oid = to_regclass('runbooks');

    SELECT relkind INTO task_items_kind
    FROM pg_class
    WHERE oid = to_regclass('task_items');

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

    IF EXISTS (
        SELECT 1 FROM pg_class WHERE oid = to_regclass('runbook_sections') AND relkind IN ('r', 'p')
    ) THEN
        ALTER TABLE runbook_sections RENAME TO task_sections;
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_class WHERE oid = to_regclass('runbook_items') AND relkind IN ('r', 'p')
    ) THEN
        ALTER TABLE runbook_items RENAME TO task_items;
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_class WHERE oid = to_regclass('runbook_operations') AND relkind IN ('r', 'p')
    ) THEN
        ALTER TABLE runbook_operations RENAME TO task_operations;
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_class
        WHERE oid = to_regclass('checklist_runbook_projection_outbox') AND relkind IN ('r', 'p')
    ) THEN
        ALTER TABLE checklist_runbook_projection_outbox
            RENAME TO checklist_task_projection_outbox;
    END IF;
END;
$$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'task_sections'
          AND column_name = 'runbook_id'
    ) THEN
        ALTER TABLE task_sections RENAME COLUMN runbook_id TO task_id;
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'task_operations'
          AND column_name = 'runbook_id'
    ) THEN
        ALTER TABLE task_operations RENAME COLUMN runbook_id TO task_id;
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'board_items'
          AND column_name = 'source_runbook_item_id'
    ) THEN
        ALTER TABLE board_items RENAME COLUMN source_runbook_item_id TO source_task_item_id;
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'session_page_bindings'
          AND column_name = 'source_runbook_item_id'
    ) THEN
        ALTER TABLE session_page_bindings
            RENAME COLUMN source_runbook_item_id TO source_task_item_id;
    END IF;
END;
$$;

ALTER TABLE IF EXISTS board_items DROP CONSTRAINT IF EXISTS board_items_item_type_check;
ALTER TABLE IF EXISTS board_items DROP CONSTRAINT IF EXISTS board_items_container_kind_check;
ALTER TABLE IF EXISTS board_yjs_catalog_cache
    DROP CONSTRAINT IF EXISTS board_yjs_catalog_cache_container_kind_check;
ALTER TABLE IF EXISTS session_page_bindings
    DROP CONSTRAINT IF EXISTS session_page_bindings_container_kind_check;
ALTER TABLE IF EXISTS task_operations DROP CONSTRAINT IF EXISTS runbook_operations_target_kind_check;
ALTER TABLE IF EXISTS task_operations DROP CONSTRAINT IF EXISTS task_operations_target_kind_check;

UPDATE board_items SET item_type = 'task' WHERE item_type = 'runbook';
UPDATE board_items SET container_kind = 'task' WHERE container_kind = 'runbook';
UPDATE board_yjs_catalog_cache
SET container_kind = 'task'
WHERE container_kind = 'runbook';
UPDATE session_page_bindings
SET legacy_container_kind = 'task'
WHERE legacy_container_kind = 'runbook';

UPDATE task_operations
SET target_kind = CASE WHEN target_kind = 'runbook' THEN 'task' ELSE target_kind END,
    operation_type = replace(operation_type, 'runbook', 'task')
WHERE target_kind = 'runbook' OR operation_type LIKE '%runbook%';

UPDATE blocks
SET block_type = 'task_ref',
    properties = (properties - 'runbookId')
      || CASE
           WHEN properties ? 'runbookId'
             THEN jsonb_build_object('taskId', properties -> 'runbookId')
           ELSE '{}'::jsonb
         END
WHERE block_type = 'runbook_ref' OR properties ? 'runbookId';

UPDATE board_yjs_catalog_cache cache
SET board_items = normalized.board_items
FROM (
    SELECT source.container_kind,
           source.container_id,
           jsonb_agg(
             (entry.value - 'sourceRunbookItemId' - 'runbookId')
             || CASE
                  WHEN entry.value ? 'sourceRunbookItemId'
                    THEN jsonb_build_object(
                      'sourceTaskItemId', entry.value -> 'sourceRunbookItemId'
                    )
                  ELSE '{}'::jsonb
                END
             || CASE
                  WHEN entry.value ? 'runbookId'
                    THEN jsonb_build_object('taskId', entry.value -> 'runbookId')
                  ELSE '{}'::jsonb
                END
             || CASE
                  WHEN entry.value ->> 'itemType' = 'runbook'
                    THEN jsonb_build_object('itemType', 'task')
                  ELSE '{}'::jsonb
                END
             || CASE
                  WHEN entry.value ->> 'containerKind' = 'runbook'
                    THEN jsonb_build_object('containerKind', 'task')
                  ELSE '{}'::jsonb
                END
             ORDER BY entry.ordinality
           ) AS board_items
    FROM board_yjs_catalog_cache source
    CROSS JOIN LATERAL jsonb_array_elements(source.board_items)
      WITH ORDINALITY AS entry(value, ordinality)
    GROUP BY source.container_kind, source.container_id
) normalized
WHERE cache.container_kind = normalized.container_kind
  AND cache.container_id = normalized.container_id;

UPDATE folders SET name = '📋 업무' WHERE name = '📒 런북';

ALTER TABLE IF EXISTS board_items ADD CONSTRAINT board_items_item_type_check
    CHECK (item_type IN ('session', 'markdown', 'subfolder', 'asset', 'frame', 'task', 'custom_view'));
ALTER TABLE IF EXISTS board_items ADD CONSTRAINT board_items_container_kind_check
    CHECK (container_kind IN ('folder','task'));
ALTER TABLE IF EXISTS board_yjs_catalog_cache
    ADD CONSTRAINT board_yjs_catalog_cache_container_kind_check
    CHECK (container_kind IN ('folder','task'));
ALTER TABLE IF EXISTS session_page_bindings
    ADD CONSTRAINT session_page_bindings_container_kind_check
    CHECK (legacy_container_kind IS NULL OR legacy_container_kind IN ('folder','task'));
ALTER TABLE IF EXISTS task_operations ADD CONSTRAINT task_operations_target_kind_check
    CHECK (target_kind IN ('task','section','item'));

DO $$
DECLARE
    index_row RECORD;
    constraint_row RECORD;
    next_name TEXT;
BEGIN
    FOR index_row IN
        SELECT c.oid::regclass AS qualified_name, c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relkind = 'i'
          AND c.relname LIKE '%runbook%'
    LOOP
        next_name := replace(index_row.relname, 'runbook', 'task');
        IF to_regclass(next_name) IS NULL THEN
            EXECUTE format('ALTER INDEX %s RENAME TO %I', index_row.qualified_name, next_name);
        END IF;
    END LOOP;

    FOR constraint_row IN
        SELECT conrelid::regclass AS qualified_table, conname
        FROM pg_constraint
        WHERE connamespace = current_schema()::regnamespace
          AND conname LIKE '%runbook%'
    LOOP
        next_name := replace(constraint_row.conname, 'runbook', 'task');
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE connamespace = current_schema()::regnamespace AND conname = next_name
        ) THEN
            EXECUTE format(
              'ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
              constraint_row.qualified_table,
              constraint_row.conname,
              next_name
            );
        END IF;
    END LOOP;
END;
$$;

-- One-release read compatibility. UNION ALL makes these views read-only.
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

-- 049: external LLM caller provenance across caller-aware mutation stores

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_completed_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_completed_kind_check
    CHECK (completed_kind IN ('agent','user','llm'));

ALTER TABLE task_items DROP CONSTRAINT IF EXISTS task_items_completed_kind_check;
ALTER TABLE task_items ADD CONSTRAINT task_items_completed_kind_check
    CHECK (completed_kind IN ('agent','user','llm'));

ALTER TABLE task_operations DROP CONSTRAINT IF EXISTS task_operations_actor_kind_check;
ALTER TABLE task_operations ADD CONSTRAINT task_operations_actor_kind_check
    CHECK (actor_kind IN ('agent','user','system','llm'));

ALTER TABLE folder_project_operations
    DROP CONSTRAINT IF EXISTS folder_project_operations_actor_kind_check;
ALTER TABLE folder_project_operations
    ADD CONSTRAINT folder_project_operations_actor_kind_check
    CHECK (actor_kind IN ('agent','user','system','llm'));

ALTER TABLE checklist_task_projection_outbox
    DROP CONSTRAINT IF EXISTS checklist_task_projection_outbox_actor_kind_check;
ALTER TABLE checklist_task_projection_outbox
    ADD CONSTRAINT checklist_task_projection_outbox_actor_kind_check
    CHECK (actor_kind IN ('agent','user','system','llm'));
ALTER TABLE checklist_task_projection_outbox
    DROP CONSTRAINT IF EXISTS checklist_task_projection_outbox_actor_shape_check;
ALTER TABLE checklist_task_projection_outbox
    ADD CONSTRAINT checklist_task_projection_outbox_actor_shape_check
    CHECK (
      (actor_kind = 'agent' AND actor_session_id IS NOT NULL AND actor_user_id IS NULL)
      OR (actor_kind = 'user' AND actor_user_id IS NOT NULL)
      OR (actor_kind = 'system' AND actor_user_id IS NULL)
      OR (actor_kind = 'llm' AND actor_session_id IS NULL AND actor_user_id IS NULL)
    );

ALTER TABLE block_operations DROP CONSTRAINT IF EXISTS block_operations_actor_kind_check;
ALTER TABLE block_operations ADD CONSTRAINT block_operations_actor_kind_check
    CHECK (actor_kind IN ('agent','user','system','llm'));

ALTER TABLE board_custom_views ADD COLUMN IF NOT EXISTS created_actor_kind TEXT;
ALTER TABLE board_custom_views ADD COLUMN IF NOT EXISTS updated_actor_kind TEXT;

UPDATE board_custom_views
SET created_actor_kind = CASE
      WHEN created_session_id IS NULL THEN 'system'
      ELSE 'agent'
    END
WHERE created_actor_kind IS NULL;

UPDATE board_custom_views
SET updated_actor_kind = CASE
      WHEN updated_session_id IS NULL THEN 'system'
      ELSE 'agent'
    END
WHERE updated_actor_kind IS NULL;

ALTER TABLE board_custom_views
    ALTER COLUMN created_actor_kind SET DEFAULT 'agent',
    ALTER COLUMN created_actor_kind SET NOT NULL,
    ALTER COLUMN updated_actor_kind SET DEFAULT 'agent',
    ALTER COLUMN updated_actor_kind SET NOT NULL;

ALTER TABLE board_custom_views
    DROP CONSTRAINT IF EXISTS board_custom_views_created_actor_kind_check;
ALTER TABLE board_custom_views
    ADD CONSTRAINT board_custom_views_created_actor_kind_check
    CHECK (created_actor_kind IN ('agent','user','system','llm'));
ALTER TABLE board_custom_views
    DROP CONSTRAINT IF EXISTS board_custom_views_updated_actor_kind_check;
ALTER TABLE board_custom_views
    ADD CONSTRAINT board_custom_views_updated_actor_kind_check
    CHECK (updated_actor_kind IN ('agent','user','system','llm'));

-- Fail the migration if a differently named legacy CHECK survived a
-- DROP ... IF EXISTS. PostgreSQL combines CHECK constraints with AND, so one
-- stale constraint that omits llm would otherwise make the migration appear
-- successful while rejecting the first external-LLM write at runtime.
DO $$
DECLARE
    target RECORD;
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
        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint constraint_row
            WHERE constraint_row.conrelid = to_regclass(target.table_name)
              AND constraint_row.contype = 'c'
              AND pg_get_constraintdef(constraint_row.oid) LIKE
                  '%' || target.column_name || '%'
              AND pg_get_constraintdef(constraint_row.oid) LIKE '%''llm''%'
        ) THEN
            RAISE EXCEPTION
                'external LLM migration did not install an llm-aware CHECK for %.%',
                target.table_name,
                target.column_name;
        END IF;

        IF EXISTS (
            SELECT 1
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
        ) THEN
            RAISE EXCEPTION
                'external LLM migration left a legacy CHECK on %.% that rejects llm',
                target.table_name,
                target.column_name;
        END IF;
    END LOOP;
END;
$$;

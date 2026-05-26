-- Migration 014: Task Tree realtime notifications and canonical pinned state

ALTER TABLE task_items
    ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_task_items_sibling_sort
    ON task_items (parent_id, pinned DESC, updated_at DESC)
    WHERE archived = FALSE;

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

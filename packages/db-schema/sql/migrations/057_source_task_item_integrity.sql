ALTER TABLE board_items
    DROP CONSTRAINT IF EXISTS board_items_source_runbook_item_id_fkey;

ALTER TABLE session_page_bindings
    DROP CONSTRAINT IF EXISTS session_page_bindings_source_task_item_id_fkey;

ALTER TABLE session_page_bindings
    ADD CONSTRAINT session_page_bindings_source_task_item_id_fkey
    FOREIGN KEY (source_task_item_id) REFERENCES task_items(id) ON DELETE SET NULL;

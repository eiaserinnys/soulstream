ALTER TABLE runbook_items DROP CONSTRAINT IF EXISTS runbook_items_status_check;
ALTER TABLE runbook_items ADD CONSTRAINT runbook_items_status_check
    CHECK (status IN ('pending','in_progress','review','completed','cancelled'));

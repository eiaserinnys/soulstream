-- Deployment precondition: verify the external v1 Task Tree backup index,
-- all JSON chunks, checksums, status distribution, and recovery manifest
-- before applying this destructive migration. This migration is committed
-- for a later human-approved deployment and must not be applied by CI.

DROP TABLE IF EXISTS task_operations;
DROP TABLE IF EXISTS task_items;
DROP FUNCTION IF EXISTS task_tree_notify_change();

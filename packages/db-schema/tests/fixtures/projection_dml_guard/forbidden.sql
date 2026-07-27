CREATE TABLE audit_log (id UUID PRIMARY KEY);

UPDATE blocks
SET block_type = 'task_ref';

INSERT INTO public.pages (id) VALUES ('page-1');

DELETE FROM "blocks" WHERE id = 'block-1';

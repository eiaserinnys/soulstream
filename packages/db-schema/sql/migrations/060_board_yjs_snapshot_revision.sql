ALTER TABLE board_yjs_documents
    ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;

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

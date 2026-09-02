-- Migration 085b destroys historical ownership rows and columns. Restoring the
-- schema without the matching pre-migration data would fabricate runtime facts.
-- Restore the verified database backup taken immediately before 085b instead.
DO $$
BEGIN
    RAISE EXCEPTION '085b rollback requires restoration of the pre-migration database backup';
END;
$$;

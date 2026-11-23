-- Claude transcript copies were never populated (card #1075). Drop the store.
-- session_delete must stop referencing the table before the table is dropped.
CREATE OR REPLACE FUNCTION session_delete(
    p_session_id TEXT
) RETURNS void LANGUAGE sql AS $$
    DELETE FROM sessions WHERE session_id = p_session_id;
$$;

DROP FUNCTION IF EXISTS claude_transcript_append(TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS claude_transcript_load(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS claude_transcript_list_sessions(TEXT);
DROP FUNCTION IF EXISTS claude_transcript_list_subkeys(TEXT, TEXT);
DROP FUNCTION IF EXISTS claude_transcript_delete(TEXT, TEXT, TEXT);
DROP TABLE IF EXISTS claude_transcript_entries;

DELETE FROM session_mutation_receipts
 WHERE operation IN ('runner_claude_transcript_append', 'runner_claude_transcript_delete');

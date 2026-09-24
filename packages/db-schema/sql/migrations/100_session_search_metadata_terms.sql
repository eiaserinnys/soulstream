-- Add bounded indexed metadata-term candidates without stripping language particles.
CREATE OR REPLACE FUNCTION session_search_tokens(p_text TEXT) RETURNS TEXT[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    WITH normalized AS (
        SELECT lower(normalize(left(coalesce(p_text, ''), 512), NFKC)) AS value
    ), distinct_terms AS (
        SELECT DISTINCT token.value AS term
        FROM normalized
        CROSS JOIN LATERAL regexp_split_to_table(
            normalized.value,
            '[[:space:][:punct:]]+'
        ) AS token(value)
    )
    SELECT coalesce(array_agg(term ORDER BY term), ARRAY[]::TEXT[])
    FROM distinct_terms
    WHERE term <> '';
$$;

CREATE INDEX IF NOT EXISTS idx_sessions_display_name_search_terms
    ON sessions USING GIN (session_search_tokens(display_name));
CREATE INDEX IF NOT EXISTS idx_sessions_prompt_search_terms
    ON sessions USING GIN (session_search_tokens(prompt));

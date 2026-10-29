CREATE OR REPLACE FUNCTION event_search_tokenize(p_text TEXT)
RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$
    SELECT COALESCE(array_agg(term), ARRAY[]::TEXT[])
    FROM regexp_split_to_table(
        lower(coalesce(p_text, '')),
        '[^[:alnum:]_가-힣]+'
    ) AS token(term)
    WHERE term <> ''
      AND octet_length(term) <= 1024;
$$;

CREATE INDEX IF NOT EXISTS idx_pages_title_prefix
    ON pages (title_key text_pattern_ops, id)
    WHERE archived = FALSE;

CREATE INDEX IF NOT EXISTS idx_blocks_text_prefix
    ON blocks ((lower(text_plain)) text_pattern_ops, id);

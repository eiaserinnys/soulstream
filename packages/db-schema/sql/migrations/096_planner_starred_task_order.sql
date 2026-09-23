CREATE OR REPLACE FUNCTION planner_starred_task_identity_trim(identity_value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT NULLIF(BTRIM(
        identity_value,
        chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) ||
        chr(160) || chr(5760) || chr(8192) || chr(8193) || chr(8194) ||
        chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199) ||
        chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) ||
        chr(8239) || chr(8287) || chr(12288) || chr(65279)
    ), '')
$$;

CREATE TABLE IF NOT EXISTS planner_starred_task_order (
    page_id  TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
    position BIGINT NOT NULL CHECK (position >= 0)
);

CREATE INDEX IF NOT EXISTS idx_planner_starred_task_order_position
    ON planner_starred_task_order(position, page_id);

INSERT INTO planner_starred_task_order (page_id, position)
SELECT eligible.page_id,
       row_number() OVER (ORDER BY eligible.updated_at DESC, eligible.page_id DESC) - 1
FROM (
    SELECT page.id AS page_id, page.updated_at
    FROM pages page
    WHERE page.archived = FALSE
      AND page.daily_date IS NULL
      AND page.metadata->'starred' = 'true'::jsonb
      AND EXISTS (
        SELECT 1
        FROM blocks block
        WHERE block.page_id = page.id
          AND block.block_type IN ('task_ref', 'runbook_ref')
          AND block.properties->'primary' = 'true'::jsonb
          AND jsonb_typeof(CASE block.block_type
            WHEN 'task_ref' THEN block.properties->'taskId'
            WHEN 'runbook_ref' THEN block.properties->'runbookId'
          END) = 'string'
          AND planner_starred_task_identity_trim(CASE block.block_type
            WHEN 'task_ref' THEN block.properties->>'taskId'
            WHEN 'runbook_ref' THEN block.properties->>'runbookId'
          END) IS NOT NULL
      )
) eligible
ON CONFLICT (page_id) DO NOTHING;

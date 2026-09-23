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
      AND COALESCE((page.metadata->>'starred')::boolean, FALSE)
      AND EXISTS (
        SELECT 1
        FROM blocks block
        WHERE block.page_id = page.id
          AND block.block_type IN ('task_ref', 'runbook_ref')
          AND COALESCE((block.properties->>'primary')::boolean, FALSE)
          AND NULLIF(BTRIM(CASE block.block_type
            WHEN 'task_ref' THEN block.properties->>'taskId'
            WHEN 'runbook_ref' THEN block.properties->>'runbookId'
          END), '') IS NOT NULL
      )
) eligible
ON CONFLICT (page_id) DO NOTHING;

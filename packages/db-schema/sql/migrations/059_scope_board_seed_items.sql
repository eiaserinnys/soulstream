DROP FUNCTION IF EXISTS board_seed_items();
DROP FUNCTION IF EXISTS board_seed_items(TEXT, TEXT);

CREATE OR REPLACE FUNCTION board_seed_items(p_container_kind TEXT, p_container_id TEXT)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF p_container_kind IS NULL OR p_container_kind NOT IN ('folder', 'task') THEN
        RAISE EXCEPTION 'unsupported board container kind: %', p_container_kind;
    END IF;
    IF NULLIF(BTRIM(p_container_id), '') IS NULL THEN
        RAISE EXCEPTION 'board container id must not be empty';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('soulstream:board_items')::bigint);

    -- Only reconcile the container currently being bootstrapped. Other containers'
    -- relational projections and Y.Doc state must remain untouched.
    DELETE FROM board_items bi
    WHERE bi.item_type = 'session'
      AND bi.container_kind = p_container_kind
      AND bi.container_id = p_container_id
      AND (
          NOT EXISTS (
              SELECT 1 FROM sessions s
              WHERE s.session_id = bi.item_id
          )
          OR (
              bi.container_kind = 'folder'
              AND NOT EXISTS (
                  SELECT 1 FROM sessions s
                  WHERE s.session_id = bi.item_id
                    AND s.folder_id = bi.folder_id
              )
          )
      );

    DELETE FROM board_items bi
    WHERE bi.item_type = 'subfolder'
      AND bi.container_kind = p_container_kind
      AND bi.container_id = p_container_id
      AND NOT EXISTS (
          SELECT 1 FROM folders f
          WHERE f.id = bi.item_id
            AND f.parent_folder_id = bi.folder_id
      );

    DELETE FROM board_items bi
    WHERE bi.item_type = 'markdown'
      AND bi.container_kind = p_container_kind
      AND bi.container_id = p_container_id
      AND NOT EXISTS (
          SELECT 1 FROM markdown_documents d
          WHERE d.id = bi.item_id
      );

    DELETE FROM board_items bi
    WHERE bi.item_type = 'asset'
      AND bi.container_kind = p_container_kind
      AND bi.container_id = p_container_id
      AND NOT EXISTS (
          SELECT 1 FROM file_assets fa
          WHERE fa.id = bi.item_id
      );

    DELETE FROM board_items bi
    WHERE bi.item_type = 'custom_view'
      AND bi.container_kind = p_container_kind
      AND bi.container_id = p_container_id
      AND NOT EXISTS (
          SELECT 1 FROM board_custom_views cv
          WHERE cv.id = bi.item_id
      );

    WITH candidates AS (
        SELECT
            s.folder_id AS folder_id,
            'session'::TEXT AS item_type,
            s.session_id AS item_id,
            ('session:' || s.session_id)::TEXT AS board_item_id,
            COALESCE(
                CASE
                    WHEN s.last_message ? 'timestamp' AND s.last_message->>'timestamp' <> ''
                    THEN (s.last_message->>'timestamp')::TIMESTAMPTZ
                    ELSE NULL
                END,
                s.updated_at,
                s.created_at,
                NOW()
            ) AS activity_at,
            s.session_id AS tie_breaker
        FROM sessions s
        WHERE p_container_kind = 'folder'
          AND s.folder_id = p_container_id
          AND NOT EXISTS (
              SELECT 1 FROM board_items existing_primary
              WHERE existing_primary.item_type = 'session'
                AND existing_primary.item_id = s.session_id
                AND existing_primary.membership_kind = 'primary'
          )
        UNION ALL
        SELECT
            f.parent_folder_id AS folder_id,
            'subfolder'::TEXT AS item_type,
            f.id AS item_id,
            ('subfolder:' || f.id)::TEXT AS board_item_id,
            COALESCE(f.created_at, NOW()) AS activity_at,
            f.name AS tie_breaker
        FROM folders f
        WHERE p_container_kind = 'folder'
          AND f.parent_folder_id = p_container_id
    ),
    numbered AS (
        SELECT
            *,
            ROW_NUMBER() OVER (
                PARTITION BY folder_id
                ORDER BY activity_at DESC, item_type ASC, tie_breaker ASC
            ) - 1 AS item_index
        FROM candidates
    )
    INSERT INTO board_items (
        id,
        folder_id,
        container_kind,
        container_id,
        membership_kind,
        item_type,
        item_id,
        x,
        y,
        metadata
    )
    SELECT
        board_item_id,
        folder_id,
        'folder'::TEXT,
        folder_id,
        'primary'::TEXT,
        item_type,
        item_id,
        ((item_index % 4) * 280)::DOUBLE PRECISION,
        (FLOOR(item_index / 4) * 160)::DOUBLE PRECISION,
        '{}'::jsonb
    FROM numbered
    ON CONFLICT DO NOTHING;
END;
$$;

CREATE TABLE IF NOT EXISTS file_assets (
    id                   TEXT PRIMARY KEY,
    storage_key          TEXT NOT NULL UNIQUE,
    original_name        TEXT NOT NULL,
    mime_type            TEXT NOT NULL,
    byte_size            BIGINT NOT NULL CHECK (byte_size >= 0),
    width                INTEGER,
    height               INTEGER,
    duration_seconds     DOUBLE PRECISION,
    checksum_sha256      TEXT,
    upload_status        TEXT NOT NULL DEFAULT 'pending' CHECK (upload_status IN ('pending', 'committed')),
    multipart_upload_id  TEXT,
    garbage_collected_at TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE board_items DROP CONSTRAINT IF EXISTS board_items_item_type_check;
ALTER TABLE board_items ADD CONSTRAINT board_items_item_type_check
    CHECK (item_type IN ('session', 'markdown', 'subfolder', 'asset'));

CREATE OR REPLACE FUNCTION board_delete_asset_refs()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM board_items WHERE item_type = 'asset' AND item_id = OLD.id;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS board_delete_asset_refs_trigger ON file_assets;
CREATE TRIGGER board_delete_asset_refs_trigger
AFTER DELETE ON file_assets
FOR EACH ROW EXECUTE FUNCTION board_delete_asset_refs();

CREATE OR REPLACE FUNCTION board_seed_items()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM board_items bi
    WHERE bi.item_type = 'session'
      AND NOT EXISTS (
          SELECT 1 FROM sessions s
          WHERE s.session_id = bi.item_id
            AND s.folder_id = bi.folder_id
      );

    DELETE FROM board_items bi
    WHERE bi.item_type = 'subfolder'
      AND NOT EXISTS (
          SELECT 1 FROM folders f
          WHERE f.id = bi.item_id
            AND f.parent_folder_id = bi.folder_id
      );

    DELETE FROM board_items bi
    WHERE bi.item_type = 'markdown'
      AND NOT EXISTS (
          SELECT 1 FROM markdown_documents d
          WHERE d.id = bi.item_id
      );

    DELETE FROM board_items bi
    WHERE bi.item_type = 'asset'
      AND NOT EXISTS (
          SELECT 1 FROM file_assets fa
          WHERE fa.id = bi.item_id
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
        WHERE s.folder_id IS NOT NULL
        UNION ALL
        SELECT
            f.parent_folder_id AS folder_id,
            'subfolder'::TEXT AS item_type,
            f.id AS item_id,
            ('subfolder:' || f.id)::TEXT AS board_item_id,
            COALESCE(f.created_at, NOW()) AS activity_at,
            f.name AS tie_breaker
        FROM folders f
        WHERE f.parent_folder_id IS NOT NULL
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
    INSERT INTO board_items (id, folder_id, item_type, item_id, x, y, metadata)
    SELECT
        board_item_id,
        folder_id,
        item_type,
        item_id,
        ((item_index % 4) * 280)::DOUBLE PRECISION,
        (FLOOR(item_index / 4) * 160)::DOUBLE PRECISION,
        '{}'::jsonb
    FROM numbered
    ON CONFLICT (id) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION board_item_get_all()
RETURNS TABLE(
    id TEXT,
    folder_id TEXT,
    item_type TEXT,
    item_id TEXT,
    x DOUBLE PRECISION,
    y DOUBLE PRECISION,
    metadata JSONB,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
) LANGUAGE sql STABLE AS $$
    SELECT
        bi.id,
        bi.folder_id,
        bi.item_type,
        bi.item_id,
        bi.x,
        bi.y,
        CASE
            WHEN bi.item_type = 'markdown' THEN
                bi.metadata || jsonb_build_object(
                    'title', md.title,
                    'preview', LEFT(regexp_replace(md.body, '[[:space:]]+', ' ', 'g'), 180)
                )
            WHEN bi.item_type = 'asset' THEN
                bi.metadata || jsonb_build_object(
                    'assetId', fa.id,
                    'storageKey', fa.storage_key,
                    'originalName', fa.original_name,
                    'mimeType', fa.mime_type,
                    'byteSize', fa.byte_size,
                    'width', fa.width,
                    'height', fa.height,
                    'durationSeconds', fa.duration_seconds
                )
            ELSE bi.metadata
        END AS metadata,
        bi.created_at,
        bi.updated_at
    FROM board_items bi
    LEFT JOIN markdown_documents md
      ON bi.item_type = 'markdown'
     AND bi.item_id = md.id
    LEFT JOIN file_assets fa
      ON bi.item_type = 'asset'
     AND bi.item_id = fa.id
    ORDER BY bi.folder_id, bi.y, bi.x, bi.created_at;
$$;

DROP TRIGGER IF EXISTS board_delete_session_refs_trigger ON sessions;
DROP TRIGGER IF EXISTS board_assert_session_refs_removed_trigger ON sessions;
DROP FUNCTION IF EXISTS board_delete_session_refs();

CREATE OR REPLACE FUNCTION board_assert_session_refs_removed()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM board_items
        WHERE item_type = 'session' AND item_id = OLD.session_id
    ) OR EXISTS (
        SELECT 1
        FROM board_yjs_catalog_cache cache
        WHERE (
            jsonb_typeof(cache.board_items) <> 'array'
            AND cache.board_items::text LIKE '%' || OLD.session_id || '%'
        ) OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(cache.board_items) = 'array'
                    THEN cache.board_items ELSE '[]'::jsonb END
            ) AS entry(value)
            WHERE (
                entry.value ->> 'id' = 'session:' || OLD.session_id
                OR (
                    COALESCE(entry.value ->> 'itemType', entry.value ->> 'item_type') = 'session'
                    AND COALESCE(entry.value ->> 'itemId', entry.value ->> 'item_id') = OLD.session_id
                )
            )
        )
    ) THEN
        RAISE EXCEPTION
            'session % still has a board Y.Doc card; remove canonical card before deleting session',
            OLD.session_id
            USING ERRCODE = '23503';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER board_assert_session_refs_removed_trigger
BEFORE DELETE ON sessions
FOR EACH ROW EXECUTE FUNCTION board_assert_session_refs_removed();

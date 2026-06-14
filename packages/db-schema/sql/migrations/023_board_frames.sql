ALTER TABLE board_items DROP CONSTRAINT IF EXISTS board_items_item_type_check;
ALTER TABLE board_items ADD CONSTRAINT board_items_item_type_check
    CHECK (item_type IN ('session', 'markdown', 'subfolder', 'asset', 'frame'));

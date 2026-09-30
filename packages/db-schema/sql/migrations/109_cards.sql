-- 소울스트림 정의 밖 드리프트: 실험 중 유입된 지식 카드 두 테이블.
-- 백업: .local/artifacts/cards-p1-rehearsal/legacy-knowledge-cards.dump (데이터 포함).
-- 테이블 삭제가 전용 트리거와 인덱스도 함께 제거한다.
DROP TABLE IF EXISTS public.tree_nodes;
DROP TABLE IF EXISTS public.cards;
DROP FUNCTION IF EXISTS public.update_fts_vector();
DROP FUNCTION IF EXISTS public.update_updated_at();

-- Card identity is inherited; link provenance is consolidated before either source is removed.
ALTER TABLE checklist_items RENAME TO cards;
ALTER TABLE cards ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE;
UPDATE cards i SET folder_id=s.folder_id,
    assignee_kind=COALESCE(i.assignee_kind,s.assignee_kind),
    assignee_agent_id=CASE WHEN i.assignee_kind IS NULL THEN s.assignee_agent_id ELSE i.assignee_agent_id END,
    assignee_session_id=CASE WHEN i.assignee_kind IS NULL THEN s.assignee_session_id ELSE i.assignee_session_id END,
    assignee_user_id=CASE WHEN i.assignee_kind IS NULL THEN s.assignee_user_id ELSE i.assignee_user_id END
FROM checklist_sections s WHERE s.id=i.section_id;
ALTER TABLE cards ALTER COLUMN folder_id SET NOT NULL;
WITH ordered AS (
  SELECT i.id,row_number() OVER (PARTITION BY s.folder_id ORDER BY s.position_key COLLATE "C",i.position_key COLLATE "C",i.id) AS n
  FROM cards i JOIN checklist_sections s ON s.id=i.section_id
) UPDATE cards i SET position_key=lpad(ordered.n::text,12,'0') || 'V' FROM ordered WHERE ordered.id=i.id;
ALTER TABLE cards RENAME COLUMN how_to TO request;
ALTER TABLE cards ADD COLUMN queue_position_key TEXT,
  ADD COLUMN brief TEXT NOT NULL DEFAULT '',
  ADD COLUMN blocked_kind TEXT CHECK (blocked_kind IN ('limit','question','no_report')),
  ADD COLUMN blocked_detail TEXT, ADD COLUMN node_id TEXT, ADD COLUMN model_preset TEXT;
DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid='cards'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%status%' LOOP
    EXECUTE format('ALTER TABLE cards DROP CONSTRAINT %I',r.conname);
  END LOOP;
END $$;
UPDATE cards SET status=CASE status WHEN 'pending' THEN 'todo' WHEN 'in_progress' THEN 'running' WHEN 'completed' THEN 'done' ELSE status END;
ALTER TABLE cards ALTER COLUMN status SET DEFAULT 'todo';
ALTER TABLE cards ADD CONSTRAINT cards_status_check CHECK(status IN ('todo','queued','blocked','running','review','done','cancelled'));
ALTER TABLE cards DROP COLUMN section_id;
-- RENAME TABLE does not rename its existing constraints or backing indexes.
DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid='cards'::regclass AND conname LIKE '%checklist_items%' LOOP
    EXECUTE format('ALTER TABLE cards RENAME CONSTRAINT %I TO %I',r.conname,replace(r.conname,'checklist_items','cards'));
  END LOOP;
  FOR r IN SELECT indexname FROM pg_indexes WHERE tablename='cards' AND indexname LIKE '%checklist_items%' LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I',r.indexname,replace(r.indexname,'checklist_items','cards'));
  END LOOP;
END $$;
DROP TABLE checklist_sections;
CREATE TEMP TABLE card_link_migration ON COMMIT DROP AS
SELECT item_id AS session_id,source_checklist_item_id AS card_id FROM board_items
WHERE item_type='session' AND source_checklist_item_id IS NOT NULL
UNION SELECT session_id,source_checklist_item_id FROM session_page_bindings WHERE source_checklist_item_id IS NOT NULL;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM card_link_migration GROUP BY session_id HAVING count(DISTINCT card_id)>1) THEN
    RAISE EXCEPTION 'conflicting card links';
  END IF;
END $$;
ALTER TABLE sessions ADD COLUMN card_id TEXT REFERENCES cards(id) ON DELETE SET NULL;
UPDATE sessions s SET card_id=l.card_id FROM card_link_migration l WHERE s.session_id=l.session_id;
DROP FUNCTION IF EXISTS board_item_get_all();
ALTER TABLE board_items DROP COLUMN source_checklist_item_id;
ALTER TABLE session_page_bindings DROP COLUMN source_checklist_item_id;
ALTER TABLE folder_operations DROP CONSTRAINT folder_operations_target_kind_check;
UPDATE folder_operations SET target_kind='card' WHERE target_kind='item';
UPDATE folder_operations SET operation_type=replace(replace(operation_type,'_checklist_item','_card'),'_checklist_section','_section');
ALTER TABLE folder_operations ADD CONSTRAINT folder_operations_target_kind_check CHECK(target_kind IN ('folder','section','card'));
CREATE INDEX idx_cards_folder ON cards(folder_id, position_key COLLATE "C");
CREATE INDEX idx_cards_queue ON cards(queue_position_key COLLATE "C") WHERE status='queued' AND archived=FALSE;
CREATE INDEX idx_sessions_card ON sessions(card_id) WHERE card_id IS NOT NULL;

CREATE TABLE card_reports (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('markdown','html')),
    body TEXT NOT NULL,
    session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_card_reports_card ON card_reports(card_id, created_at DESC);
CREATE TABLE card_questions (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    text TEXT NOT NULL,
    options JSONB,
    answer TEXT,
    asked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    answered_at TIMESTAMPTZ,
    answered_by TEXT
);
CREATE INDEX idx_card_questions_card ON card_questions(card_id, asked_at);
INSERT INTO system_settings(setting_key,value,version,updated_by)
VALUES ('card_dispatch','{"nodeConcurrency":{"default":2}}'::jsonb,1,'migration:109_cards') ON CONFLICT (setting_key) DO NOTHING;


DROP FUNCTION IF EXISTS board_item_get_all();
CREATE OR REPLACE FUNCTION board_item_get_all()
RETURNS TABLE(
    id TEXT,
    folder_id TEXT,
    membership_kind TEXT,
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
        bi.membership_kind,
        bi.item_type,
        bi.item_id,
        bi.x,
        bi.y,
        CASE
            WHEN bi.item_type = 'markdown' THEN
                bi.metadata || jsonb_build_object(
                    'title', md.title,
                    'preview', LEFT(regexp_replace(md.body, '[[:space:]]+', ' ', 'g'), 180),
                    'version', md.version
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
            WHEN bi.item_type = 'custom_view' THEN
                bi.metadata || jsonb_build_object(
                    'title', COALESCE(cv.title, ''),
                    'preview', LEFT(regexp_replace(regexp_replace(cv.html, '<[^>]*>', ' ', 'g'), '[[:space:]]+', ' ', 'g'), 180),
                    'revision', cv.revision
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
    LEFT JOIN board_custom_views cv
      ON bi.item_type = 'custom_view'
     AND bi.item_id = cv.id
    ORDER BY bi.folder_id, bi.y, bi.x, bi.created_at;
$$;

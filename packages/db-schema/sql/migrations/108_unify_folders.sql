-- Writers must be quiesced. The pre-start snapshot conversion follows this SQL.
-- IDs and content are preserved; only the container and checklist vocabulary changes.
CREATE TEMP TABLE folder_unification_counts ON COMMIT DROP AS
SELECT (SELECT count(*) FROM folders) AS folders,
       (SELECT count(*) FROM tasks) AS tasks,
       (SELECT count(*) FROM task_sections) AS sections,
       (SELECT count(*) FROM task_items) AS items,
       (SELECT count(*) FROM task_operations) + (SELECT count(*) FROM folder_project_operations) AS operations,
       (SELECT count(*) FROM board_items) AS board_items;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM tasks t JOIN folders f ON f.id=t.id OR f.project_page_id=t.task_page_id)
    THEN RAISE EXCEPTION 'folder unification identity collision'; END IF;
  IF EXISTS (SELECT 1 FROM tasks t LEFT JOIN board_items b ON b.id=t.board_item_id
    LEFT JOIN pages p ON p.id=t.task_page_id
    WHERE b.id IS NULL OR p.id IS NULL OR b.container_kind<>'folder' OR b.membership_kind<>'primary')
    THEN RAISE EXCEPTION 'folder unification source identity incomplete'; END IF;
  IF EXISTS (SELECT 1 FROM task_operations t JOIN folder_project_operations f
    ON f.id=t.id OR f.idempotency_key=t.idempotency_key)
    THEN RAISE EXCEPTION 'folder operation identity collision'; END IF;
END $$;

ALTER TABLE folders
  ADD COLUMN checklist_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN created_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
  ADD COLUMN created_event_id INTEGER,
  ADD COLUMN completed_kind TEXT CHECK (completed_kind IN ('agent','user','llm')),
  ADD COLUMN completed_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
  ADD COLUMN completed_event_id INTEGER,
  ADD COLUMN completed_user_id TEXT,
  ADD COLUMN completed_at TIMESTAMPTZ,
  ADD COLUMN updated_at TIMESTAMPTZ;
UPDATE folders SET updated_at=created_at;
ALTER TABLE folders ALTER COLUMN updated_at SET NOT NULL, ALTER COLUMN updated_at SET DEFAULT NOW();
ALTER TABLE folders ADD CONSTRAINT folders_created_event_fkey
  FOREIGN KEY(created_session_id,created_event_id) REFERENCES events(session_id,id) ON DELETE SET NULL;
ALTER TABLE folders ADD CONSTRAINT folders_completed_event_fkey
  FOREIGN KEY(completed_session_id,completed_event_id) REFERENCES events(session_id,id) ON DELETE SET NULL;

INSERT INTO folders (id,name,parent_folder_id,project_page_id,sort_order,checklist_enabled,
  status,archived,version,created_session_id,created_event_id,created_at,updated_at,
  completed_kind,completed_session_id,completed_event_id,completed_user_id,completed_at)
SELECT t.id,t.title,b.folder_id,t.task_page_id,
  COALESCE((SELECT max(f.sort_order) FROM folders f WHERE f.parent_folder_id=b.folder_id),-1)
    + row_number() OVER (PARTITION BY b.folder_id ORDER BY b.y,b.x,t.id),
  TRUE,t.status,t.archived,t.version,t.created_session_id,t.created_event_id,t.created_at,t.updated_at,
  t.completed_kind,t.completed_session_id,t.completed_event_id,t.completed_user_id,t.completed_at
FROM tasks t JOIN board_items b ON b.id=t.board_item_id;

DROP VIEW runbooks,runbook_sections,runbook_items,runbook_operations;
-- Constraint names may predate migration 042; identify these three FKs by their target.
DO $$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT conrelid::regclass AS rel,conname FROM pg_constraint
    WHERE confrelid='tasks'::regclass AND conrelid IN
      ('task_sections'::regclass,'task_operations'::regclass,'worktrees'::regclass)
  LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',c.rel,c.conname); END LOOP;
END $$;
ALTER TABLE task_sections RENAME TO checklist_sections;
ALTER TABLE checklist_sections RENAME COLUMN task_id TO folder_id;
ALTER TABLE task_items RENAME TO checklist_items;
ALTER TABLE task_operations RENAME TO folder_operations;
ALTER TABLE folder_operations RENAME COLUMN task_id TO folder_id;
ALTER TABLE worktrees RENAME COLUMN owner_task_id TO owner_folder_id;
ALTER TABLE checklist_sections ADD CONSTRAINT checklist_sections_folder_id_fkey
  FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE CASCADE;
ALTER TABLE folder_operations ADD CONSTRAINT folder_operations_folder_id_fkey
  FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE RESTRICT;
ALTER TABLE folder_operations ALTER COLUMN folder_id SET NOT NULL;
ALTER TABLE worktrees ADD CONSTRAINT worktrees_owner_folder_id_fkey
  FOREIGN KEY(owner_folder_id) REFERENCES folders(id) ON DELETE SET NULL;
DO $$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='folder_operations'::regclass
    AND contype='c' AND pg_get_constraintdef(oid) LIKE '%target_kind%'
  LOOP EXECUTE format('ALTER TABLE folder_operations DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
UPDATE folder_operations SET target_kind='folder' WHERE target_kind='task';
INSERT INTO folder_operations (id,folder_id,target_kind,target_id,operation_type,actor_kind,
  actor_session_id,actor_event_id,actor_user_id,idempotency_key,payload_json,reason,created_at)
SELECT id,folder_id,'folder',folder_id,operation_type,actor_kind,
  actor_session_id,NULL,actor_user_id,idempotency_key,payload_json,reason,created_at
FROM folder_project_operations;
DROP TABLE folder_project_operations;
UPDATE folder_operations SET operation_type=CASE operation_type
  WHEN 'create_task' THEN 'create_folder' WHEN 'update_task' THEN 'rename_folder'
  WHEN 'archive_task' THEN 'archive_folder' WHEN 'unarchive_task' THEN 'unarchive_folder'
  WHEN 'set_task_status' THEN 'set_folder_status'
  WHEN 'backfill_task_identity' THEN 'backfill_folder_identity'
  WHEN 'backfill_folder_project' THEN 'backfill_folder_identity'
  WHEN 'create_folder_project' THEN 'create_folder'
  WHEN 'update_folder_project' THEN 'update_folder'
  WHEN 'archive_folder_project' THEN 'archive_folder' WHEN 'unarchive_folder_project' THEN 'unarchive_folder'
  WHEN 'set_item_status' THEN 'set_checklist_item_status'
  ELSE replace(replace(operation_type,'_task_section','_checklist_section'),'_task_item','_checklist_item') END;
ALTER TABLE folder_operations ADD CONSTRAINT folder_operations_target_kind_check
  CHECK(target_kind IN ('folder','section','item'));
CREATE INDEX IF NOT EXISTS idx_folder_operations_folder ON folder_operations(folder_id,created_at);

UPDATE sessions s SET folder_id=b.container_id FROM board_items b
WHERE b.item_type='session' AND b.membership_kind='primary' AND b.container_kind='task'
  AND b.item_id=s.session_id AND s.folder_id IS DISTINCT FROM b.container_id;
UPDATE session_page_bindings SET legacy_folder_id=legacy_container_id
WHERE legacy_container_kind='task';
UPDATE recurring_jobs SET folder_id=container_id WHERE container_kind='task';
UPDATE recurring_job_runs SET job_snapshot=(job_snapshot-'container_kind'-'container_id') ||
  CASE WHEN job_snapshot->>'container_kind'='task'
    THEN jsonb_build_object('folder_id',job_snapshot->>'container_id') ELSE '{}'::jsonb END
WHERE job_snapshot ? 'container_kind' OR job_snapshot ? 'container_id';

UPDATE board_items SET folder_id=container_id WHERE container_kind='task';
UPDATE board_items SET item_type='subfolder' WHERE item_type='task';
ALTER TABLE board_items RENAME COLUMN source_task_item_id TO source_checklist_item_id;
ALTER TABLE session_page_bindings RENAME COLUMN source_task_item_id TO source_checklist_item_id;
DROP TRIGGER IF EXISTS trg_board_items_fill_container_defaults ON board_items;
DROP FUNCTION IF EXISTS board_items_fill_container_defaults();
DROP FUNCTION IF EXISTS board_seed_items(TEXT,TEXT);
DROP FUNCTION IF EXISTS board_item_get_all();
ALTER TABLE board_items DROP CONSTRAINT IF EXISTS uq_board_items_container_item;
ALTER TABLE board_items DROP CONSTRAINT IF EXISTS board_items_container_kind_check;
DROP INDEX IF EXISTS idx_board_items_container;
ALTER TABLE board_items DROP COLUMN container_kind, DROP COLUMN container_id;
ALTER TABLE board_items ADD CONSTRAINT uq_board_items_folder_item UNIQUE(folder_id,item_id);
ALTER TABLE board_items DROP CONSTRAINT board_items_item_type_check;
ALTER TABLE board_items ADD CONSTRAINT board_items_item_type_check
  CHECK(item_type IN ('session','markdown','subfolder','asset','frame','custom_view'));
CREATE INDEX idx_board_items_folder_position ON board_items(folder_id,y,x);

-- Cache is a projection; the pre-start converter reconstructs it from canonical snapshots.
DELETE FROM board_yjs_catalog_cache;
ALTER TABLE board_yjs_catalog_cache DROP CONSTRAINT board_yjs_catalog_cache_pkey;
ALTER TABLE board_yjs_catalog_cache DROP COLUMN container_kind, DROP COLUMN container_id;
ALTER TABLE board_yjs_catalog_cache ADD PRIMARY KEY(folder_id);
ALTER TABLE session_page_bindings DROP COLUMN legacy_container_kind, DROP COLUMN legacy_container_id;
ALTER TABLE recurring_jobs DROP COLUMN container_kind, DROP COLUMN container_id;
ALTER TABLE planner_starred_task_order RENAME TO planner_starred_page_order;
ALTER FUNCTION planner_starred_task_identity_trim(TEXT) RENAME TO planner_starred_page_identity_trim;
DROP TABLE checklist_task_projection_outbox;
DROP TABLE tasks;

-- Rename only constraints/indexes on the relations whose domain changed.
DO $$ DECLARE c RECORD; new_name TEXT; BEGIN
  FOR c IN SELECT conrelid::regclass AS rel,conname FROM pg_constraint
    WHERE conrelid IN ('checklist_sections'::regclass,'checklist_items'::regclass,
      'folder_operations'::regclass,'board_items'::regclass,'session_page_bindings'::regclass,
      'worktrees'::regclass,'planner_starred_page_order'::regclass)
      AND conname ~ '(task|runbook)'
  LOOP
    new_name:=replace(replace(replace(replace(replace(replace(replace(replace(c.conname,
      'runbook_sections','checklist_sections'),'task_sections','checklist_sections'),
      'runbook_items','checklist_items'),'task_items','checklist_items'),
      'runbook_operations','folder_operations'),'task_operations','folder_operations'),
      'source_task_item','source_checklist_item'),'starred_task','starred_page');
    new_name:=replace(replace(replace(new_name,'owner_task','owner_folder'),'runbook_id','folder_id'),'task_id','folder_id');
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=c.rel AND conname=new_name) THEN
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',c.rel,c.conname);
    ELSE EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I',c.rel,c.conname,new_name); END IF;
  END LOOP;
  FOR c IN SELECT tablename,indexname FROM pg_indexes WHERE schemaname=current_schema()
    AND tablename IN ('checklist_sections','checklist_items','folder_operations','planner_starred_page_order')
    AND indexname ~ '(task|runbook)'
  LOOP
    new_name:=replace(replace(replace(replace(replace(replace(replace(c.indexname,
      'runbook_sections_runbook','checklist_sections_folder'),'task_sections_task','checklist_sections_folder'),
      'runbook_items','checklist_items'),'task_items','checklist_items'),
      'runbook_ops','folder_ops'),'task_ops','folder_ops'),'starred_task','starred_page');
    IF to_regclass(new_name) IS NOT NULL THEN EXECUTE format('DROP INDEX %I',c.indexname);
    ELSE EXECUTE format('ALTER INDEX %I RENAME TO %I',c.indexname,new_name); END IF;
  END LOOP;
END $$;

DO $$ DECLARE before RECORD; BEGIN
 SELECT * INTO before FROM folder_unification_counts;
 IF (SELECT count(*) FROM folders)<>before.folders+before.tasks
   OR (SELECT count(*) FROM checklist_sections)<>before.sections
   OR (SELECT count(*) FROM checklist_items)<>before.items
   OR (SELECT count(*) FROM folder_operations)<>before.operations
   OR (SELECT count(*) FROM board_items)<>before.board_items
 THEN RAISE EXCEPTION 'folder unification row count mismatch'; END IF;
END $$;

CREATE OR REPLACE FUNCTION board_seed_items(p_folder_id TEXT)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF NULLIF(BTRIM(p_folder_id), '') IS NULL THEN
        RAISE EXCEPTION 'board container id must not be empty';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('soulstream:board_items')::bigint);

    -- Reconcile primary membership against the folder owner.
    DELETE FROM board_items bi
    WHERE bi.item_type = 'session'
      AND bi.folder_id = p_folder_id
      AND (
          NOT EXISTS (
              SELECT 1 FROM sessions s
              WHERE s.session_id = bi.item_id
          )
          OR (
              bi.membership_kind = 'primary'
              AND NOT EXISTS (
                  SELECT 1 FROM sessions s
                  WHERE s.session_id = bi.item_id
                    AND s.folder_id = bi.folder_id
              )
          )
      );

    DELETE FROM board_items bi
    WHERE bi.item_type = 'subfolder' AND bi.membership_kind = 'primary'
      AND bi.folder_id = p_folder_id
      AND NOT EXISTS (
          SELECT 1 FROM folders f
          WHERE f.id = bi.item_id
            AND f.parent_folder_id = bi.folder_id
      );

    DELETE FROM board_items bi
    WHERE bi.item_type = 'markdown'
      AND bi.folder_id = p_folder_id
      AND NOT EXISTS (
          SELECT 1 FROM markdown_documents d
          WHERE d.id = bi.item_id
      );

    DELETE FROM board_items bi
    WHERE bi.item_type = 'asset'
      AND bi.folder_id = p_folder_id
      AND NOT EXISTS (
          SELECT 1 FROM file_assets fa
          WHERE fa.id = bi.item_id
      );

    DELETE FROM board_items bi
    WHERE bi.item_type = 'custom_view'
      AND bi.folder_id = p_folder_id
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
        WHERE s.folder_id = p_folder_id
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
        WHERE f.parent_folder_id = p_folder_id AND f.archived = FALSE
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

DROP FUNCTION IF EXISTS board_item_get_all();
CREATE OR REPLACE FUNCTION board_item_get_all()
RETURNS TABLE(
    id TEXT,
    folder_id TEXT,
    membership_kind TEXT,
    source_checklist_item_id TEXT,
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
        bi.source_checklist_item_id,
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

-- Renaming a document must preserve its persisted update journal.
ALTER TABLE board_yjs_updates DROP CONSTRAINT board_yjs_updates_document_name_fkey;
ALTER TABLE board_yjs_updates ADD CONSTRAINT board_yjs_updates_document_name_fkey
  FOREIGN KEY (document_name) REFERENCES board_yjs_documents(name)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Folder status is distinct from session status in the existing list/count joins.
CREATE OR REPLACE FUNCTION session_get_all(
    p_filters JSONB DEFAULT NULL,
    p_limit   INTEGER DEFAULT NULL,
    p_offset  INTEGER DEFAULT NULL
) RETURNS SETOF sessions LANGUAGE plpgsql STABLE AS $$
DECLARE
    q TEXT := 'SELECT s.* FROM sessions s LEFT JOIN folders f ON s.folder_id = f.id WHERE TRUE';
    v_feed_only BOOLEAN := FALSE;
BEGIN
    IF p_filters IS NOT NULL AND p_filters ? 'session_type' THEN
        q := q || ' AND session_type = ' || quote_literal(p_filters->>'session_type');
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'folder_id' THEN
        q := q || ' AND s.folder_id = ' || quote_literal(p_filters->>'folder_id');
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'node_id' THEN
        q := q || ' AND node_id = ' || quote_literal(p_filters->>'node_id');
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'review_state' THEN
        q := q || ' AND s.review_state = ' || quote_literal(p_filters->>'review_state');
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'updated_after' THEN
        q := q || ' AND s.updated_at >= ($1->>''updated_after'')::timestamptz';
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'backends' THEN
        q := q || ' AND COALESCE(' ||
            '(SELECT mapping.value->>''backend'' FROM jsonb_array_elements($1->''backend_catalog'') AS mapping(value) ' ||
            'WHERE mapping.value->>''kind'' = ''preset'' ' ||
            'AND mapping.value->>''node_id'' = s.node_id ' ||
            'AND mapping.value->>''model_preset'' = s.model_preset LIMIT 1), ' ||
            '(SELECT mapping.value->>''backend'' FROM jsonb_array_elements($1->''backend_catalog'') AS mapping(value) ' ||
            'WHERE mapping.value->>''kind'' = ''agent'' ' ||
            'AND mapping.value->>''node_id'' = s.node_id ' ||
            'AND mapping.value->>''agent_id'' = s.agent_id LIMIT 1)' ||
            ') IN (SELECT requested.backend FROM jsonb_array_elements_text($1->''backends'') AS requested(backend))';
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'search' THEN
        q := q || ' AND (' ||
            'COALESCE(s.display_name, '''') ILIKE ' ||
                quote_literal('%' || (p_filters->>'search') || '%') ||
            ' OR s.session_id ILIKE ' ||
                quote_literal('%' || (p_filters->>'search') || '%') ||
            ' OR COALESCE(s.node_id, '''') ILIKE ' ||
                quote_literal('%' || (p_filters->>'search') || '%') ||
            ' OR COALESCE(f.name, '''') ILIKE ' ||
                quote_literal('%' || (p_filters->>'search') || '%') ||
            ')';
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'status' THEN
        IF jsonb_typeof(p_filters->'status') = 'array' THEN
            q := q || ' AND s.status IN (' ||
                (SELECT string_agg(quote_literal(elem), ', ')
                 FROM jsonb_array_elements_text(p_filters->'status') AS elem) || ')';
        ELSE
            q := q || ' AND s.status = ' || quote_literal(p_filters->>'status');
        END IF;
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'feed_only' AND (p_filters->>'feed_only')::boolean THEN
        v_feed_only := TRUE;
        q := q || ' AND (s.folder_id IS NULL OR COALESCE(f.settings->>''excludeFromFeed'', ''false'') != ''true'')';
        q := q || ' AND COALESCE(session_type, ''claude'') != ''llm''';
    END IF;

    IF v_feed_only THEN
        q := q || ' ORDER BY COALESCE(' ||
            'CASE WHEN jsonb_typeof(s.last_message) = ''object'' ' ||
            'AND s.last_message->>''type'' IN (''user_message'', ''assistant_message'') ' ||
            'AND jsonb_typeof(s.last_message->''preview'') = ''string'' ' ||
            'AND btrim(s.last_message->>''preview'') <> '''' ' ||
            'THEN session_feed_try_timestamptz(s.last_message->>''timestamp'') END, ' ||
            's.created_at, s.updated_at) DESC, s.session_id DESC';
    ELSE
        q := q || ' ORDER BY s.updated_at DESC, s.session_id DESC';
    END IF;

    IF p_limit IS NOT NULL THEN
        q := q || ' LIMIT ' || p_limit;
    END IF;
    IF p_offset IS NOT NULL AND p_offset > 0 THEN
        q := q || ' OFFSET ' || p_offset;
    END IF;

    IF p_filters IS NOT NULL AND (p_filters ? 'updated_after' OR p_filters ? 'backends') THEN
        RETURN QUERY EXECUTE q USING p_filters;
    ELSE
        RETURN QUERY EXECUTE q;
    END IF;
END;
$$;

-- 4. session_count
CREATE OR REPLACE FUNCTION session_count(
    p_filters JSONB DEFAULT NULL
) RETURNS BIGINT LANGUAGE plpgsql STABLE AS $$
DECLARE
    q TEXT := 'SELECT COUNT(*) FROM sessions s LEFT JOIN folders f ON s.folder_id = f.id WHERE TRUE';
    result BIGINT;
BEGIN
    IF p_filters IS NOT NULL AND p_filters ? 'session_type' THEN
        q := q || ' AND session_type = ' || quote_literal(p_filters->>'session_type');
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'folder_id' THEN
        q := q || ' AND s.folder_id = ' || quote_literal(p_filters->>'folder_id');
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'node_id' THEN
        q := q || ' AND node_id = ' || quote_literal(p_filters->>'node_id');
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'review_state' THEN
        q := q || ' AND s.review_state = ' || quote_literal(p_filters->>'review_state');
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'updated_after' THEN
        q := q || ' AND s.updated_at >= ($1->>''updated_after'')::timestamptz';
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'backends' THEN
        q := q || ' AND COALESCE(' ||
            '(SELECT mapping.value->>''backend'' FROM jsonb_array_elements($1->''backend_catalog'') AS mapping(value) ' ||
            'WHERE mapping.value->>''kind'' = ''preset'' ' ||
            'AND mapping.value->>''node_id'' = s.node_id ' ||
            'AND mapping.value->>''model_preset'' = s.model_preset LIMIT 1), ' ||
            '(SELECT mapping.value->>''backend'' FROM jsonb_array_elements($1->''backend_catalog'') AS mapping(value) ' ||
            'WHERE mapping.value->>''kind'' = ''agent'' ' ||
            'AND mapping.value->>''node_id'' = s.node_id ' ||
            'AND mapping.value->>''agent_id'' = s.agent_id LIMIT 1)' ||
            ') IN (SELECT requested.backend FROM jsonb_array_elements_text($1->''backends'') AS requested(backend))';
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'search' THEN
        q := q || ' AND (' ||
            'COALESCE(s.display_name, '''') ILIKE ' ||
                quote_literal('%' || (p_filters->>'search') || '%') ||
            ' OR s.session_id ILIKE ' ||
                quote_literal('%' || (p_filters->>'search') || '%') ||
            ' OR COALESCE(s.node_id, '''') ILIKE ' ||
                quote_literal('%' || (p_filters->>'search') || '%') ||
            ' OR COALESCE(f.name, '''') ILIKE ' ||
                quote_literal('%' || (p_filters->>'search') || '%') ||
            ')';
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'status' THEN
        IF jsonb_typeof(p_filters->'status') = 'array' THEN
            q := q || ' AND s.status IN (' ||
                (SELECT string_agg(quote_literal(elem), ', ')
                 FROM jsonb_array_elements_text(p_filters->'status') AS elem) || ')';
        ELSE
            q := q || ' AND s.status = ' || quote_literal(p_filters->>'status');
        END IF;
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'feed_only' AND (p_filters->>'feed_only')::boolean THEN
        q := q || ' AND (s.folder_id IS NULL OR COALESCE(f.settings->>''excludeFromFeed'', ''false'') != ''true'')';
        q := q || ' AND COALESCE(session_type, ''claude'') != ''llm''';
    END IF;

    IF p_filters IS NOT NULL AND (p_filters ? 'updated_after' OR p_filters ? 'backends') THEN
        EXECUTE q INTO result USING p_filters;
    ELSE
        EXECUTE q INTO result;
    END IF;
    RETURN result;
END;
$$;

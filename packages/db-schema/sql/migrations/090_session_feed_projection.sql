-- 090: canonical session-feed projection and bounded recovery state.
--
-- The legacy three-argument session_update_last_message entry point remains in
-- place for a rolling deploy. New orchestrators use the event-id-aware function
-- below; old callers are restricted to already-canonical message types.

CREATE OR REPLACE FUNCTION session_feed_try_timestamptz(p_value TEXT)
RETURNS TIMESTAMPTZ LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF p_value IS NULL OR btrim(p_value) = '' THEN
        RETURN NULL;
    END IF;
    RETURN p_value::TIMESTAMPTZ;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$;

CREATE TABLE IF NOT EXISTS session_feed_state (
    session_id                TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
    attention_revision        INTEGER NOT NULL DEFAULT 0 CHECK (attention_revision >= 0),
    notification_watermark    INTEGER NOT NULL DEFAULT 0 CHECK (notification_watermark >= 0),
    notification_count        BIGINT NOT NULL DEFAULT 0 CHECK (notification_count >= 0),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS session_pending_attentions (
    session_id       TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    attention_id     TEXT NOT NULL,
    source_event_id  INTEGER NOT NULL CHECK (source_event_id > 0),
    projection       JSONB NOT NULL,
    requested_at     TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (session_id, attention_id),
    FOREIGN KEY (session_id, source_event_id)
        REFERENCES events(session_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_pending_attentions_order
    ON session_pending_attentions (session_id, source_event_id, attention_id);

CREATE TABLE IF NOT EXISTS session_feed_notices (
    session_id       TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    source_event_id  INTEGER NOT NULL CHECK (source_event_id > 0),
    projection       JSONB NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (session_id, source_event_id),
    FOREIGN KEY (session_id, source_event_id)
        REFERENCES events(session_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_feed_notices_recent
    ON session_feed_notices (session_id, source_event_id DESC);

CREATE OR REPLACE FUNCTION session_apply_last_chat_message(
    p_session_id   TEXT,
    p_event_id     INTEGER,
    p_last_message JSONB,
    p_created_at   TIMESTAMPTZ
) RETURNS TABLE(applied BOOLEAN, last_message JSONB) LANGUAGE plpgsql AS $$
DECLARE
    v_existing JSONB;
    v_existing_timestamp TIMESTAMPTZ;
    v_existing_event_id INTEGER := 0;
    v_canonical JSONB;
BEGIN
    IF p_event_id IS NULL OR p_event_id <= 0
       OR p_created_at IS NULL
       OR jsonb_typeof(p_last_message) IS DISTINCT FROM 'object'
       OR p_last_message->>'type' NOT IN ('user_message', 'assistant_message')
       OR jsonb_typeof(p_last_message->'preview') IS DISTINCT FROM 'string'
       OR btrim(p_last_message->>'preview') = '' THEN
        RAISE EXCEPTION 'invalid canonical last chat message';
    END IF;

    SELECT sessions.last_message
      INTO v_existing
      FROM sessions
     WHERE session_id = p_session_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Session not found: %', p_session_id;
    END IF;

    v_existing_timestamp := session_feed_try_timestamptz(v_existing->>'timestamp');
    IF COALESCE(v_existing->>'eventId', v_existing->>'event_id', '') ~ '^[1-9][0-9]{0,9}$' THEN
        BEGIN
            v_existing_event_id := COALESCE(
                (v_existing->>'eventId')::INTEGER,
                (v_existing->>'event_id')::INTEGER,
                0
            );
        EXCEPTION WHEN numeric_value_out_of_range THEN
            v_existing_event_id := 0;
        END;
    END IF;

    v_canonical := jsonb_build_object(
        'type', p_last_message->>'type',
        'eventId', p_event_id,
        'preview', substring(btrim(p_last_message->>'preview') FROM 1 FOR 200),
        'timestamp', p_created_at
    );

    IF v_existing_timestamp IS NULL
       OR (p_created_at, p_event_id) > (v_existing_timestamp, v_existing_event_id) THEN
        UPDATE sessions
           SET last_message = v_canonical,
               updated_at = GREATEST(updated_at, p_created_at)
         WHERE session_id = p_session_id;
        RETURN QUERY SELECT TRUE, v_canonical;
    ELSE
        RETURN QUERY SELECT FALSE, v_existing;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION session_update_last_message(
    p_session_id   TEXT,
    p_last_message TEXT,
    p_updated_at   TIMESTAMPTZ
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    v_message JSONB;
    v_existing_timestamp TIMESTAMPTZ;
BEGIN
    BEGIN
        v_message := p_last_message::JSONB;
    EXCEPTION WHEN OTHERS THEN
        RETURN;
    END;
    IF p_updated_at IS NULL
       OR jsonb_typeof(v_message) IS DISTINCT FROM 'object'
       OR v_message->>'type' NOT IN ('user_message', 'assistant_message')
       OR jsonb_typeof(v_message->'preview') IS DISTINCT FROM 'string'
       OR btrim(v_message->>'preview') = '' THEN
        RETURN;
    END IF;

    SELECT session_feed_try_timestamptz(last_message->>'timestamp')
      INTO v_existing_timestamp
      FROM sessions
     WHERE session_id = p_session_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    IF v_existing_timestamp IS NOT NULL AND p_updated_at <= v_existing_timestamp THEN
        RETURN;
    END IF;

    UPDATE sessions
       SET last_message = jsonb_build_object(
               'type', v_message->>'type',
               'preview', substring(btrim(v_message->>'preview') FROM 1 FOR 200),
               'timestamp', p_updated_at
           ),
           updated_at = GREATEST(updated_at, p_updated_at)
     WHERE session_id = p_session_id;
END;
$$;

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
            q := q || ' AND status IN (' ||
                (SELECT string_agg(quote_literal(elem), ', ')
                 FROM jsonb_array_elements_text(p_filters->'status') AS elem) || ')';
        ELSE
            q := q || ' AND status = ' || quote_literal(p_filters->>'status');
        END IF;
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'feed_only'
       AND (p_filters->>'feed_only')::boolean THEN
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

    RETURN QUERY EXECUTE q;
END;
$$;

-- Canonicalize existing last-message rows from durable events. A valid legacy
-- projection is retained only when there is no newer derivable event. This
-- statement intentionally never changes sessions.updated_at.
WITH valid_event_messages AS (
    SELECT
        e.session_id,
        e.id AS event_id,
        e.created_at,
        CASE
            WHEN e.event_type IN ('user_message', 'intervention_sent')
                THEN 'user_message'
            WHEN e.event_type = 'realtime_transcript' AND e.payload->>'role' = 'user'
                THEN 'user_message'
            ELSE 'assistant_message'
        END AS message_type,
        CASE
            WHEN e.event_type IN ('user_message', 'intervention_sent')
                THEN e.payload->>'text'
            WHEN e.event_type = 'assistant_message'
                THEN e.payload->>'content'
            ELSE e.payload->>'text'
        END AS message_text
    FROM events e
    WHERE jsonb_typeof(e.payload) = 'object'
      AND (
          (e.event_type IN ('user_message', 'intervention_sent')
              AND jsonb_typeof(e.payload->'text') = 'string')
          OR (e.event_type = 'assistant_message'
              AND jsonb_typeof(e.payload->'content') = 'string')
          OR (e.event_type = 'realtime_transcript'
              AND e.payload->'final' = 'true'::JSONB
              AND e.payload->>'role' IN ('user', 'assistant')
              AND jsonb_typeof(e.payload->'text') = 'string')
      )
), latest_event_messages AS (
    SELECT DISTINCT ON (session_id)
        session_id,
        created_at AS projection_timestamp,
        jsonb_build_object(
            'type', CASE
                WHEN message_type = 'assistant_message'
                     OR message_type = 'user_message' THEN message_type
                ELSE 'assistant_message'
            END,
            'eventId', event_id,
            'preview', substring(btrim(message_text) FROM 1 FOR 200),
            'timestamp', created_at
        ) AS projection
    FROM valid_event_messages
    WHERE btrim(message_text) <> ''
    ORDER BY session_id, created_at DESC, event_id DESC
), projected_sessions AS (
    SELECT
        s.session_id,
        CASE
            WHEN latest.projection IS NOT NULL
             AND (
                 NOT (
                     jsonb_typeof(s.last_message) = 'object'
                     AND s.last_message->>'type' IN ('user_message', 'assistant_message')
                     AND jsonb_typeof(s.last_message->'preview') = 'string'
                     AND btrim(s.last_message->>'preview') <> ''
                     AND session_feed_try_timestamptz(
                         s.last_message->>'timestamp'
                     ) IS NOT NULL
                 )
                 OR latest.projection_timestamp >= session_feed_try_timestamptz(
                     s.last_message->>'timestamp'
                 )
             ) THEN latest.projection
            WHEN jsonb_typeof(s.last_message) = 'object'
             AND s.last_message->>'type' IN ('user_message', 'assistant_message')
             AND jsonb_typeof(s.last_message->'preview') = 'string'
             AND btrim(s.last_message->>'preview') <> ''
             AND session_feed_try_timestamptz(s.last_message->>'timestamp') IS NOT NULL
                THEN s.last_message
            ELSE NULL
        END AS projection
    FROM sessions s
    LEFT JOIN latest_event_messages latest ON latest.session_id = s.session_id
)
UPDATE sessions s
   SET last_message = projected.projection
  FROM projected_sessions projected
 WHERE projected.session_id = s.session_id
   AND s.last_message IS DISTINCT FROM projected.projection;

-- Recover unresolved request identities. The compact backfill deliberately
-- omits arbitrary tool/question bodies and sets requiresDetail=true.
CREATE OR REPLACE FUNCTION session_feed_try_positive_seconds(p_value TEXT)
RETURNS DOUBLE PRECISION LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_seconds DOUBLE PRECISION;
BEGIN
    IF p_value IS NULL OR btrim(p_value) = '' THEN
        RETURN NULL;
    END IF;
    v_seconds := p_value::DOUBLE PRECISION;
    IF NOT (v_seconds > 0 AND v_seconds < 'Infinity'::DOUBLE PRECISION) THEN
        RETURN NULL;
    END IF;
    RETURN v_seconds;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION session_feed_try_expiry(
    p_created_at TIMESTAMPTZ,
    p_seconds DOUBLE PRECISION
) RETURNS TIMESTAMPTZ LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF p_created_at IS NULL OR p_seconds IS NULL THEN
        RETURN NULL;
    END IF;
    RETURN p_created_at + make_interval(secs => p_seconds);
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION session_feed_terminal_effect_accepted(
    p_session_id TEXT,
    p_event_id INTEGER
) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT NOT EXISTS (
        SELECT 1
        FROM event_ingress_receipts receipt
        WHERE receipt.session_id = p_session_id
          AND receipt.event_id = p_event_id
          AND jsonb_typeof(receipt.effect_application) = 'object'
          AND receipt.effect_application->>'applied' = 'false'
    )
$$;

WITH request_events AS (
    SELECT e.*, e.payload->>'request_id' AS request_id
    FROM events e
    WHERE e.event_type = 'input_request'
      AND jsonb_typeof(e.payload) = 'object'
      AND COALESCE(e.payload->>'request_id', '') <> ''
), unresolved AS (
    SELECT DISTINCT ON (request.session_id, request.request_id) request.*
    FROM request_events request
    WHERE NOT EXISTS (
        SELECT 1 FROM events resolved
        WHERE resolved.session_id = request.session_id
          AND resolved.id > request.id
          AND (
              (
                  resolved.event_type = 'session_ended'
                  AND session_feed_terminal_effect_accepted(
                      resolved.session_id, resolved.id
                  )
              )
              OR (
                  resolved.event_type IN (
                      'input_request_expired', 'input_request_responded'
                  )
                  AND resolved.payload->>'request_id' = request.request_id
              )
          )
    )
    ORDER BY request.session_id, request.request_id, request.id DESC
)
INSERT INTO session_pending_attentions (
    session_id, attention_id, source_event_id, projection, requested_at
)
SELECT
    session_id,
    'input_request:' || request_id,
    id,
    jsonb_strip_nulls(jsonb_build_object(
        'id', 'input_request:' || request_id,
        'sourceEventId', id,
        'sessionId', session_id,
        'kind', 'input_request',
        'requestedAt', created_at,
        'title', '입력 요청',
        'body', '응답이 필요합니다',
        'requestId', request_id,
        'toolUseId', payload->>'tool_use_id',
        'timeoutSec', timeout_value.seconds,
        'expiresAt', session_feed_try_expiry(created_at, timeout_value.seconds),
        'requiresDetail', TRUE
    )),
    created_at
FROM unresolved
CROSS JOIN LATERAL (
    SELECT session_feed_try_positive_seconds(
        unresolved.payload->>'timeout_sec'
    ) AS seconds
) timeout_value
ON CONFLICT (session_id, attention_id) DO NOTHING;

WITH request_events AS (
    SELECT e.*, COALESCE(
        e.payload->>'approval_id', e.payload->>'tool_use_id'
    ) AS approval_id
    FROM events e
    WHERE e.event_type = 'tool_approval_requested'
      AND jsonb_typeof(e.payload) = 'object'
      AND COALESCE(e.payload->>'approval_id', e.payload->>'tool_use_id', '') <> ''
), unresolved AS (
    SELECT DISTINCT ON (request.session_id, request.approval_id) request.*
    FROM request_events request
    WHERE NOT EXISTS (
        SELECT 1 FROM events resolved
        WHERE resolved.session_id = request.session_id
          AND resolved.id > request.id
          AND (
              (
                  resolved.event_type = 'session_ended'
                  AND session_feed_terminal_effect_accepted(
                      resolved.session_id, resolved.id
                  )
              )
              OR (
                  resolved.event_type = 'tool_approval_resolved'
                  AND COALESCE(
                      resolved.payload->>'approval_id',
                      resolved.payload->>'tool_use_id'
                  ) = request.approval_id
              )
          )
    )
    ORDER BY request.session_id, request.approval_id, request.id DESC
)
INSERT INTO session_pending_attentions (
    session_id, attention_id, source_event_id, projection, requested_at
)
SELECT
    session_id,
    'tool_approval:' || approval_id,
    id,
    jsonb_strip_nulls(jsonb_build_object(
        'id', 'tool_approval:' || approval_id,
        'sourceEventId', id,
        'sessionId', session_id,
        'kind', 'tool_approval',
        'requestedAt', created_at,
        'title', '도구 승인 요청',
        'body', substring(
            COALESCE(NULLIF(btrim(payload->>'tool_name'), ''), 'tool')
            FROM 1 FOR 200
        ),
        'approvalId', approval_id,
        'toolUseId', payload->>'tool_use_id',
        'toolName', substring(
            COALESCE(NULLIF(btrim(payload->>'tool_name'), ''), 'tool')
            FROM 1 FOR 200
        ),
        'requiresDetail', TRUE
    )),
    created_at
FROM unresolved
ON CONFLICT (session_id, attention_id) DO NOTHING;

WITH request_events AS (
    SELECT e.*, COALESCE(
        e.payload->>'tool_use_id', e.payload->>'notification_id'
    ) AS permission_id
    FROM events e
    WHERE e.event_type = 'claude_runtime_notification'
      AND jsonb_typeof(e.payload) = 'object'
      AND lower(COALESCE(
          e.payload->>'notification_type', e.payload->>'key', ''
      )) = 'permission'
      AND COALESCE(
          e.payload->>'tool_use_id', e.payload->>'notification_id', ''
      ) <> ''
      AND e.created_at + INTERVAL '10 minutes' > NOW()
), unresolved AS (
    SELECT DISTINCT ON (request.session_id, request.permission_id) request.*
    FROM request_events request
    WHERE NOT EXISTS (
        SELECT 1 FROM events resolved
        WHERE resolved.session_id = request.session_id
          AND resolved.id > request.id
          AND (
              (
                  resolved.event_type = 'session_ended'
                  AND session_feed_terminal_effect_accepted(
                      resolved.session_id, resolved.id
                  )
              )
              OR (
                  resolved.event_type IN ('tool_start', 'tool_result')
                  AND COALESCE(
                      resolved.payload->>'tool_use_id',
                      resolved.payload->>'toolUseId'
                  ) = request.permission_id
              )
          )
    )
    ORDER BY request.session_id, request.permission_id, request.id DESC
)
INSERT INTO session_pending_attentions (
    session_id, attention_id, source_event_id, projection, requested_at
)
SELECT
    session_id,
    'permission:' || permission_id,
    id,
    jsonb_strip_nulls(jsonb_build_object(
        'id', 'permission:' || permission_id,
        'sourceEventId', id,
        'sessionId', session_id,
        'kind', 'permission',
        'requestedAt', created_at,
        'title', '권한 요청',
        'body', substring(COALESCE(
            NULLIF(btrim(payload->>'message'), ''),
            NULLIF(btrim(payload->>'title'), ''),
            '권한 승인이 필요합니다'
        ) FROM 1 FOR 200),
        'toolUseId', payload->>'tool_use_id',
        'expiresAt', created_at + INTERVAL '10 minutes',
        'requiresDetail', TRUE
    )),
    created_at
FROM unresolved
ON CONFLICT (session_id, attention_id) DO NOTHING;

WITH request_events AS (
    SELECT e.*, COALESCE(
        e.payload->>'tool_use_id', e.payload->>'toolUseId', e.id::TEXT
    ) AS tool_use_id
    FROM events e
    WHERE e.event_type = 'claude_runtime_mode_state'
      AND jsonb_typeof(e.payload) = 'object'
      AND e.payload->>'mode' = 'plan'
      AND e.payload->'active' = 'false'::JSONB
      AND COALESCE(e.payload->>'tool_name', e.payload->>'toolName') = 'ExitPlanMode'
), unresolved AS (
    SELECT DISTINCT ON (request.session_id, request.tool_use_id) request.*
    FROM request_events request
    WHERE NOT EXISTS (
        SELECT 1 FROM events resolved
        WHERE resolved.session_id = request.session_id
          AND resolved.id > request.id
          AND (
              (
                  resolved.event_type = 'session_ended'
                  AND session_feed_terminal_effect_accepted(
                      resolved.session_id, resolved.id
                  )
              )
              OR (
                  resolved.event_type IN ('tool_start', 'tool_result')
                  AND COALESCE(
                      resolved.payload->>'tool_name',
                      resolved.payload->>'toolName'
                  ) = 'ExitPlanMode'
                  AND COALESCE(
                      resolved.payload->>'tool_use_id',
                      resolved.payload->>'toolUseId'
                  ) = request.tool_use_id
              )
              OR (
                  resolved.event_type = 'claude_runtime_mode_state'
                  AND resolved.payload->>'mode' = 'plan'
                  AND resolved.payload->'active' = 'true'::JSONB
                  AND COALESCE(
                      resolved.payload->>'tool_name',
                      resolved.payload->>'toolName'
                  ) = 'ExitPlanMode'
                  AND COALESCE(
                      resolved.payload->>'tool_use_id',
                      resolved.payload->>'toolUseId'
                  ) = request.tool_use_id
              )
          )
    )
    ORDER BY request.session_id, request.tool_use_id, request.id DESC
)
INSERT INTO session_pending_attentions (
    session_id, attention_id, source_event_id, projection, requested_at
)
SELECT
    session_id,
    'exit_plan_mode:' || tool_use_id,
    id,
    jsonb_build_object(
        'id', 'exit_plan_mode:' || tool_use_id,
        'sourceEventId', id,
        'sessionId', session_id,
        'kind', 'exit_plan_mode',
        'requestedAt', created_at,
        'title', '플랜 검토 요청',
        'body', 'ExitPlanMode',
        'toolUseId', tool_use_id,
        'requiresDetail', TRUE
    ),
    created_at
FROM unresolved
ON CONFLICT (session_id, attention_id) DO NOTHING;

INSERT INTO session_feed_state (session_id, attention_revision, updated_at)
SELECT session_id, MAX(source_event_id), MAX(requested_at)
FROM session_pending_attentions
GROUP BY session_id
ON CONFLICT (session_id) DO UPDATE
SET attention_revision = GREATEST(
        session_feed_state.attention_revision,
        EXCLUDED.attention_revision
    ),
    updated_at = GREATEST(session_feed_state.updated_at, EXCLUDED.updated_at);

-- Seed only the newest eight recoverable notices while retaining a total
-- watermark/count so clients know the hydrated journal is truncated.
WITH notice_candidates AS (
    SELECT
        e.session_id,
        e.id,
        e.created_at,
        ROW_NUMBER() OVER (
            PARTITION BY e.session_id ORDER BY e.id DESC
        ) AS notice_rank,
        COUNT(*) OVER (PARTITION BY e.session_id) AS notice_count,
        MAX(e.id) OVER (PARTITION BY e.session_id) AS notice_watermark,
        CASE
            WHEN e.event_type = 'session_ended' THEN 'terminal'
            WHEN e.event_type = 'error' THEN 'error'
            WHEN e.event_type = 'intervention_sent' THEN 'intervention'
            WHEN e.event_type = 'claude_runtime_notification' THEN 'runtime_notification'
            ELSE 'response_wait'
        END AS notice_kind,
        CASE
            WHEN e.event_type = 'session_ended'
                AND e.payload->>'status' = 'error' THEN '세션 오류'
            WHEN e.event_type = 'session_ended' THEN '세션 완료'
            WHEN e.event_type = 'error' THEN '세션 오류'
            WHEN e.event_type = 'intervention_sent' THEN '새 메시지'
            WHEN e.event_type = 'session_notification' THEN 'Soul Dashboard'
            WHEN e.event_type = 'claude_runtime_notification'
                THEN COALESCE(NULLIF(btrim(e.payload->>'title'), ''), '런타임 알림')
            WHEN e.event_type = 'tool_approval_requested' THEN '도구 승인 요청'
            WHEN e.event_type = 'claude_runtime_mode_state' THEN '플랜 검토 요청'
            ELSE '입력 요청'
        END AS title,
        CASE
            WHEN e.event_type = 'session_ended' THEN COALESCE(
                NULLIF(btrim(e.payload->>'last_assistant_text'), ''),
                NULLIF(btrim(e.payload->>'result'), ''),
                NULLIF(btrim(e.payload->>'message'), ''),
                CASE WHEN e.payload->>'status' = 'error'
                    THEN '세션 오류' ELSE '세션 완료' END)
            WHEN e.event_type = 'error' THEN COALESCE(
                NULLIF(btrim(e.payload->>'message'), ''), '세션 오류')
            WHEN e.event_type = 'intervention_sent' THEN COALESCE(
                NULLIF(btrim(e.payload->>'text'), ''), '새 메시지')
            WHEN e.event_type = 'session_notification' THEN COALESCE(
                NULLIF(btrim(e.payload->>'text'), ''), 'Soul Dashboard')
            WHEN e.event_type = 'claude_runtime_notification' THEN COALESCE(
                NULLIF(btrim(e.payload->>'message'), ''),
                NULLIF(btrim(e.payload->>'title'), ''), '런타임 알림')
            WHEN e.event_type = 'tool_approval_requested' THEN COALESCE(
                NULLIF(btrim(e.payload->>'tool_name'), ''), 'tool')
            WHEN e.event_type = 'claude_runtime_mode_state' THEN 'ExitPlanMode'
            ELSE '응답이 필요합니다'
        END AS body
    FROM events e
    WHERE jsonb_typeof(e.payload) = 'object'
      AND (
          e.event_type IN (
              'session_ended', 'error', 'intervention_sent', 'session_notification',
              'claude_runtime_notification', 'input_request',
              'tool_approval_requested'
          )
          OR (
              e.event_type = 'claude_runtime_mode_state'
              AND e.payload->>'mode' = 'plan'
              AND e.payload->'active' = 'false'::JSONB
              AND e.payload->>'tool_name' = 'ExitPlanMode'
          )
      )
      AND (
          e.event_type <> 'session_ended'
          OR session_feed_terminal_effect_accepted(e.session_id, e.id)
      )
), inserted_notices AS (
    INSERT INTO session_feed_notices (
        session_id, source_event_id, projection, created_at
    )
    SELECT
        session_id,
        id,
        jsonb_build_object(
            'id', session_id || ':' || id,
            'sourceEventId', id,
            'sessionId', session_id,
            'kind', notice_kind,
            'title', substring(title FROM 1 FOR 200),
            'body', substring(body FROM 1 FOR 200),
            'createdAt', created_at
        ),
        created_at
    FROM notice_candidates
    WHERE notice_rank <= 8
    ON CONFLICT (session_id, source_event_id) DO NOTHING
    RETURNING session_id
)
INSERT INTO session_feed_state (
    session_id, notification_watermark, notification_count, updated_at
)
SELECT
    session_id,
    MAX(notice_watermark),
    MAX(notice_count),
    MAX(created_at)
FROM notice_candidates
GROUP BY session_id
ON CONFLICT (session_id) DO UPDATE
SET notification_watermark = GREATEST(
        session_feed_state.notification_watermark,
        EXCLUDED.notification_watermark
    ),
    notification_count = GREATEST(
        session_feed_state.notification_count,
        EXCLUDED.notification_count
    ),
    updated_at = GREATEST(session_feed_state.updated_at, EXCLUDED.updated_at);

DROP FUNCTION session_feed_terminal_effect_accepted(TEXT, INTEGER);
DROP FUNCTION session_feed_try_expiry(TIMESTAMPTZ, DOUBLE PRECISION);
DROP FUNCTION session_feed_try_positive_seconds(TEXT);

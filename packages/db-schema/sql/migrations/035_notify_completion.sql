-- 035: 위임 세션 완료 통지 기본값을 세션 생성 시점에 영속

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS notify_completion BOOLEAN NOT NULL DEFAULT TRUE;

-- session_register 인자 시그니처 변경: 기존 overload를 반드시 제거한다.
DROP FUNCTION IF EXISTS session_register(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT);
DROP FUNCTION IF EXISTS session_register(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BOOLEAN);
CREATE OR REPLACE FUNCTION session_register(
    p_session_id        TEXT,
    p_node_id           TEXT,
    p_agent_id          TEXT,
    p_claude_session_id TEXT,
    p_session_type      TEXT,
    p_prompt            TEXT,
    p_client_id         TEXT,
    p_status            TEXT,
    p_created_at        TIMESTAMPTZ,
    p_updated_at        TIMESTAMPTZ,
    p_caller_session_id TEXT DEFAULT NULL,
    p_notify_completion BOOLEAN DEFAULT TRUE
) RETURNS void LANGUAGE sql AS $$
    INSERT INTO sessions (
        session_id, node_id, agent_id, claude_session_id,
        session_type, prompt, client_id, status,
        created_at, updated_at, caller_session_id, notify_completion
    ) VALUES (
        p_session_id, p_node_id, p_agent_id, p_claude_session_id,
        p_session_type, p_prompt, p_client_id, p_status,
        p_created_at, p_updated_at, p_caller_session_id, COALESCE(p_notify_completion, TRUE)
    );
$$;

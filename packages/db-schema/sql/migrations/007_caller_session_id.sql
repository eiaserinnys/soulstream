-- 007_caller_session_id.sql
-- caller_session_id 컬럼 추가 (에이전트 세션 완료 보고용)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS caller_session_id TEXT;

-- session_register 프로시저 재정의 (p_caller_session_id 파라미터 추가)
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
    p_caller_session_id TEXT DEFAULT NULL
) RETURNS void LANGUAGE sql AS $$
    INSERT INTO sessions (
        session_id, node_id, agent_id, claude_session_id,
        session_type, prompt, client_id, status,
        created_at, updated_at, caller_session_id
    ) VALUES (
        p_session_id, p_node_id, p_agent_id, p_claude_session_id,
        p_session_type, p_prompt, p_client_id, p_status,
        p_created_at, p_updated_at, p_caller_session_id
    );
$$;

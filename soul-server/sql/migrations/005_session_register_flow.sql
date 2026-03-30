-- Migration 005: session_set_claude_id 함수 추가
-- claude_session_id 최초 설정용 프로시저 (UPDATE WHERE claude_session_id IS NULL)
-- create_task()에서 pending INSERT 후 register_session()에서 이 함수로 claude_session_id를 설정한다.

CREATE OR REPLACE FUNCTION session_set_claude_id(
    p_session_id        TEXT,
    p_claude_session_id TEXT
) RETURNS void LANGUAGE sql AS $$
    UPDATE sessions
    SET claude_session_id = p_claude_session_id,
        updated_at = NOW()
    WHERE session_id = p_session_id
      AND claude_session_id IS NULL;
$$;

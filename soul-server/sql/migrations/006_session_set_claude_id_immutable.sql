-- Migration 006: session_set_claude_id 함수 불변성 강화
-- NULL → SET (최초 설정)
-- 같은 값 → no-op (idempotent, 컴팩션/재시작 재진입 허용)
-- 다른 값 → RAISE EXCEPTION (버그 탐지)

CREATE OR REPLACE FUNCTION session_set_claude_id(
    p_session_id        TEXT,
    p_claude_session_id TEXT
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    v_existing TEXT;
BEGIN
    SELECT claude_session_id INTO v_existing
    FROM sessions
    WHERE session_id = p_session_id;

    IF v_existing IS NULL THEN
        -- 최초 설정
        UPDATE sessions
        SET claude_session_id = p_claude_session_id,
            updated_at = NOW()
        WHERE session_id = p_session_id;
    ELSIF v_existing = p_claude_session_id THEN
        -- 이미 같은 값 → no-op (idempotent)
        NULL;
    ELSE
        RAISE EXCEPTION 'claude_session_id immutability violation: session_id=%, existing=%, new=%',
            p_session_id, v_existing, p_claude_session_id;
    END IF;
END;
$$;

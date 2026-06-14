-- Migration 002: shutdown_get_sessions, shutdown_clear_flags에 node_id 필터 추가
--
-- 배경: 다중 노드 환경에서 노드 A가 재시작될 때 노드 B의 세션까지 처리하던 문제 수정.
--       p_node_id DEFAULT NULL로 기존 호출 (인자 없음) 과의 하위 호환성 유지.

-- 13. shutdown_get_sessions — node_id 필터 추가
CREATE OR REPLACE FUNCTION shutdown_get_sessions(p_node_id TEXT DEFAULT NULL)
RETURNS SETOF sessions LANGUAGE sql STABLE AS $$
    SELECT * FROM sessions
    WHERE was_running_at_shutdown = TRUE
    AND (p_node_id IS NULL OR node_id = p_node_id);
$$;

-- 14. shutdown_clear_flags — node_id 필터 추가
CREATE OR REPLACE FUNCTION shutdown_clear_flags(p_node_id TEXT DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
    UPDATE sessions SET was_running_at_shutdown = FALSE
    WHERE was_running_at_shutdown = TRUE
    AND (p_node_id IS NULL OR node_id = p_node_id);
$$;

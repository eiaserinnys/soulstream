-- 삭제 후 operation 이력은 agent 종류를 보존하고 세션 참조를 NULL로 허용한다.
-- 새 agent 쓰기의 actor_session_id 검증은 page 경계에서 유지한다.
ALTER TABLE block_operations
DROP CONSTRAINT IF EXISTS block_operations_agent_actor_check;

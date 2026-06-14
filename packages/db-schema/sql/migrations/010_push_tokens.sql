-- 010_push_tokens.sql — Expo Push 토큰 저장 테이블 (orch-server가 사용).
--
-- soul-app 등 모바일 클라이언트가 디바이스별 Expo Push token을 등록하고,
-- 세션 'complete' / 'input_request' 이벤트 emit 시 해당 사용자(email)의 모든
-- 등록 디바이스에 fan-out push를 보낸다.
--
-- 사용자 식별: oauth JWT의 email (별도 user_id 컬럼 없음 — packages/soul-common
-- oauth_routes.py 참조). PK = (user_email, device_id) 멱등 upsert.

CREATE TABLE IF NOT EXISTS push_tokens (
    user_email TEXT NOT NULL,
    device_id TEXT NOT NULL,
    expo_token TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_email, device_id)
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_email ON push_tokens(user_email);

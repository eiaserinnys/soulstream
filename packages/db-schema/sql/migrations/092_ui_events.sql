-- 092: UI 사용 로그 원시 이벤트.
--
-- 웹 대시보드와 soul-app이 인증된 배치로 올리는 사용자 조작 기록이다.
-- 대상(target)에는 FK를 걸지 않는다 — 세션이나 업무가 지워져도
-- "그때 그것을 열었다"는 사실 자체는 남아야 하기 때문이다.
--
-- 인덱스는 둘만 둔다. 조회는 항상 user_email로 걸리므로 기기·대상 필터는
-- 술어로 충분하고, 개인 규모에서 쓰기 비용을 인덱스로 먼저 지불할 이유가 없다.
--
-- 재적용 가능: 전부 IF NOT EXISTS / ON CONFLICT DO NOTHING이다.

CREATE TABLE IF NOT EXISTS ui_events (
    event_id           UUID PRIMARY KEY,
    schema_version     TEXT NOT NULL,
    user_email         TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
    client_kind        TEXT NOT NULL CHECK (client_kind IN ('browser', 'soul-app')),
    install_id         TEXT NOT NULL CHECK (length(btrim(install_id)) > 0),
    client_session_key TEXT NOT NULL CHECK (length(btrim(client_session_key)) > 0),
    seq                BIGINT NOT NULL CHECK (seq > 0),
    app_version        TEXT NOT NULL,
    event_type         TEXT NOT NULL CHECK (event_type IN (
        'view_open',
        'search_submit', 'search_result', 'search_result_open',
        'notification_open',
        'compose_start', 'compose_submit', 'compose_result',
        'compose_abandon', 'compose_resume',
        'app_active', 'app_inactive',
        'action_start', 'action_end'
    )),
    target_kind        TEXT,
    target_id          TEXT,
    from_kind          TEXT,
    from_id            TEXT,
    entry              TEXT,
    flow_id            TEXT,
    attrs              JSONB NOT NULL DEFAULT '{}'::JSONB,
    occurred_at        TIMESTAMPTZ NOT NULL,
    received_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ui_events_attrs_object CHECK (jsonb_typeof(attrs) = 'object'),
    CONSTRAINT ui_events_target_pair CHECK ((target_kind IS NULL) = (target_id IS NULL)),
    CONSTRAINT ui_events_from_pair CHECK ((from_kind IS NULL) = (from_id IS NULL))
);

-- 조회 화면의 주 경로: 본인 행을 시간순으로.
CREATE INDEX IF NOT EXISTS idx_ui_events_user_time
    ON ui_events(user_email, occurred_at DESC);

-- 보존 정리 경로. 클라이언트 시계가 아니라 서버 수신 시각 기준이어야
-- 시계가 망가진 클라이언트의 행이 영구히 남지 않는다.
CREATE INDEX IF NOT EXISTS idx_ui_events_received
    ON ui_events(received_at);

-- 수집 설정. 091이 만든 system_settings를 그대로 쓴다 — 설정 테이블을 새로 만들지 않는다.
INSERT INTO system_settings (setting_key, value, version, updated_by)
VALUES (
    'ui_event_collection',
    '{"enabled":true,"flushIntervalMs":10000,"maxBatchSize":20,"maxQueueSize":500}'::JSONB,
    1,
    'migration:092_ui_events'
)
ON CONFLICT (setting_key) DO NOTHING;

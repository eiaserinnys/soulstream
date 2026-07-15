-- 자동 세션이 잘못 점유한 검수 대기 항목을 기존 종단 상태로 정리한다.
--
-- 대상:
--   1. 이미 종단 상태(completed/error/interrupted)인 needs_review 세션
--   2. 첫 caller_info가 명시적 비사용자 source인 세션
--   3. 첫 caller_info source가 browser지만 사용자 식별 정보가 전부 비어 있는 세션
--
-- 제외:
--   1. slack/soul-app 및 식별 가능한 browser 세션
--   2. caller_info 또는 source가 없는 세션(근거 없이 자동 세션으로 추정하지 않음)
--   3. running 및 needs_review가 아닌 세션
--
-- 본 스크립트는 추가형 수동 백필이다. 배포 과정에서 자동 실행하지 않는다.
-- 같은 세션에 재실행해도 needs_review 조건 때문에 다시 갱신하지 않는다.

BEGIN;

WITH initial_caller AS (
    SELECT
        sessions.session_id,
        caller_entry.caller_info,
        caller_entry.caller_info ->> 'source' AS source
    FROM sessions
    CROSS JOIN LATERAL (
        SELECT entry.value -> 'value' AS caller_info
        FROM jsonb_array_elements(
            CASE
                WHEN jsonb_typeof(sessions.metadata) = 'array' THEN sessions.metadata
                ELSE '[]'::jsonb
            END
        ) WITH ORDINALITY AS entry(value, ordinal)
        WHERE entry.value ->> 'type' = 'caller_info'
        ORDER BY entry.ordinal
        LIMIT 1
    ) AS caller_entry
    WHERE sessions.review_state = 'needs_review'
      AND sessions.status IN ('completed', 'error', 'interrupted')
), eligible AS (
    SELECT session_id
    FROM initial_caller
    WHERE source IN (
        'agent',
        'system',
        'api',
        'channel_observer',
        'execute-proxy',
        'llm'
    )
       OR (
            source = 'browser'
            AND NULLIF(BTRIM(caller_info ->> 'user_id'), '') IS NULL
            AND NULLIF(BTRIM(caller_info ->> 'email'), '') IS NULL
            AND NULLIF(BTRIM(caller_info ->> 'display_name'), '') IS NULL
       )
)
UPDATE sessions
SET review_required = FALSE,
    review_state = 'acknowledged',
    updated_at = NOW()
FROM eligible
WHERE sessions.session_id = eligible.session_id
  AND sessions.review_state = 'needs_review';

COMMIT;

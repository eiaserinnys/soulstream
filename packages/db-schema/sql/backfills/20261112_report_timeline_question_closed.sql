-- 답이나 철회로 이미 닫힌 옛 카드 질문 줄에 닫힘 이벤트를 더한다.
--
-- 대상:
--   event_type='report_timeline', payload status='question' 인 옛 줄 가운데
--   payload에 card_id가 있고 question_id 키가 없는 줄. 같은 card_id의 card_questions 중
--   asked_at이 줄 이벤트 created_at + 5초 이하인 가장 늦은 질문과 짝짓고,
--   그 질문이 답(answer)이나 철회(withdrawn_at)로 닫힌 경우만 남긴다.
--
-- 제외:
--   1. 질문이 아직 열려 있거나 짝짓는 질문이 없는 줄
--   2. PAS가 직접 올린 ask 장 줄(line_key report:...)처럼 card_id가 없는 줄
--   3. 카드가 완료나 취소로 끝나며 열린 채 남은 질문의 줄(질문 자체가 닫히지 않았다)
--   4. 같은 세션에 그 question_id를 담은 report_timeline_question_closed 이벤트가 이미 있는 줄
--
-- 본 스크립트는 추가형 수동 백필이다. 배포 과정에서 자동 실행하지 않는다.
-- 재실행해도 이미 남긴 question_id는 다시 넣지 않으므로 새 이벤트가 생기지 않는다.
-- 세션마다 옛 줄 이벤트 id 순으로 50개씩 묶어 이벤트 하나로 남긴다.

BEGIN;

WITH old_lines AS (
    SELECT events.id, events.session_id, events.created_at, events.payload
    FROM events
    WHERE events.event_type = 'report_timeline'
      AND events.payload ->> 'status' = 'question'
      AND NULLIF(events.payload ->> 'card_id', '') IS NOT NULL
      AND NOT (events.payload ? 'question_id')
), pairs AS (
    SELECT DISTINCT ON (old_lines.id)
        old_lines.id AS line_event_id,
        old_lines.session_id,
        COALESCE(old_lines.payload ->> 'line_key', '') AS line_key,
        COALESCE(old_lines.payload ->> 'detail', '') AS detail,
        card_questions.id AS question_id,
        CASE WHEN card_questions.withdrawn_at IS NOT NULL THEN 'withdrawn' ELSE 'answered' END AS status
    FROM old_lines
    JOIN card_questions
      ON card_questions.card_id = old_lines.payload ->> 'card_id'
     AND card_questions.asked_at <= old_lines.created_at + INTERVAL '5 seconds'
    WHERE card_questions.answer IS NOT NULL OR card_questions.withdrawn_at IS NOT NULL
    ORDER BY old_lines.id, card_questions.asked_at DESC
), pending AS (
    SELECT pairs.*
    FROM pairs
    WHERE NOT EXISTS (
        SELECT 1
        FROM events AS closed
        WHERE closed.session_id = pairs.session_id
          AND closed.event_type = 'report_timeline_question_closed'
          AND closed.payload -> 'closures' @> jsonb_build_array(jsonb_build_object('question_id', pairs.question_id))
    )
), batches AS (
    SELECT
        numbered.session_id,
        (numbered.line_number - 1) / 50 AS batch_index,
        jsonb_agg(
            jsonb_build_object(
                'question_id', numbered.question_id,
                'line_key', numbered.line_key,
                'detail', numbered.detail,
                'status', numbered.status
            )
            ORDER BY numbered.line_event_id
        ) AS closures
    FROM (
        SELECT
            pending.*,
            ROW_NUMBER() OVER (PARTITION BY pending.session_id ORDER BY pending.line_event_id) AS line_number
        FROM pending
    ) AS numbered
    GROUP BY numbered.session_id, (numbered.line_number - 1) / 50
)
SELECT event_append(
    batches.session_id,
    'report_timeline_question_closed',
    jsonb_build_object('type', 'report_timeline_question_closed', 'closures', batches.closures)::text,
    '',
    NOW(),
    NULL
)
FROM batches
ORDER BY batches.session_id, batches.batch_index;

COMMIT;

-- 034: parent_event_id 백필 UPDATE를 schema.sql에서 은퇴시킴 (2026-07-07)
--
-- 아래 UPDATE는 event_append가 parent_event_id 컬럼을 INSERT에 포함하지 않던
-- 결함(2026-05-02 발견)의 1회성 보정이었다. schema.sql에 남아 있어 매 배포마다
-- 실행됐는데, events 테이블이 290만 행으로 커지면서 후보 0건 확인에만
-- 풀스캔 ~7.5초(부하 시 그 이상)를 소모했다.
--
-- 은퇴 근거: 2026-07-07 프로덕션에서 백필 후보 행 0건 확인. event_append는
-- 수정 이후 parent_event_id를 직접 채우므로 새 후보는 생기지 않는다.
--
-- 아직 백필되지 않은 환경(2026-05-02 이전 데이터가 있고 그 후 schema.sql을
-- 한 번도 적용하지 않은 DB)에서는 이 파일의 UPDATE를 수동으로 1회 실행하면 된다.
--
-- 원문 (schema.sql에서 제거된 블록):
--
-- 백필: parent_event_id 컬럼이 NULL이지만 payload에 정수 형식 값이 있는 기존 이벤트 채우기
-- 멱등: parent_event_id가 이미 채워진 행은 WHERE 조건으로 건너뜀
-- 길이 + INT 범위 가드: payload.parent_event_id에 tool_use_id/UUID/timestamp 같은
-- 비정상 값이 섞여 있어 (1) 비정수 문자열, (2) INT 범위 초과 정수 모두 백필 대상 아님.
-- ^\d{1,10}$로 BIGINT 캐스트 overflow 차단, BIGINT 범위 비교로 INT 한계 검증.
-- FK 가드: 같은 session_id에 해당 id의 행이 실제로 존재해야만 백필. 레거시 데이터에는
-- payload.parent_event_id가 정수이지만 부모 이벤트 행 자체가 사라진 케이스가 있어
-- (events_parent_fk 위반으로 startup 실패) NULL로 둔다 — event_append의 v_parent 가드와 일관.
UPDATE events e
SET parent_event_id = (e.payload->>'parent_event_id')::INTEGER
WHERE e.parent_event_id IS NULL
  AND e.payload->>'parent_event_id' ~ '^\d{1,10}$'
  AND (e.payload->>'parent_event_id')::BIGINT BETWEEN 1 AND 2147483647
  AND EXISTS (
    SELECT 1 FROM events p
    WHERE p.session_id = e.session_id
      AND p.id = (e.payload->>'parent_event_id')::INTEGER
  );

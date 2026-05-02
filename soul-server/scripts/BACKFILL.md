# 뷰포트 API: `parent_event_id` + `subtree_height` 백필 절차

이 문서는 Phase 3 뷰포트 API(설계: `.local/artifacts/analysis/20260417-0757-viewport-api-design.md`)
구현의 Phase 1 데이터 모델 이관 절차를 기록한다.

대상 컬럼 2종:

- `events.parent_event_id INTEGER` — `payload->>'parent_event_id'`에서 정본 컬럼으로 승격
- `events.subtree_height INTEGER NOT NULL DEFAULT 1` — DFS 알고리즘으로 세션별 재계산

## 실행 순서

반드시 다음 순서를 **엄격히** 지킨다 (🔵 에지 #9).

1. **단계 1 — DDL 적용**
   - `soul-server/sql/schema.sql`의 멱등 DDL 재실행.
   - 이 단계에서 추가되는 것:
     - `events.parent_event_id INTEGER` + FK `events_parent_fk` (session_id, parent_event_id) → events(session_id, id) ON DELETE CASCADE
     - `events.subtree_height INTEGER NOT NULL DEFAULT 1`
     - `idx_events_parent (session_id, parent_event_id)`
     - `idx_events_created_at (session_id, created_at DESC, id DESC)` — Phase 2 `/messages` 페이지네이션용

   적용 방법 (PostgreSQL):

   ```bash
   psql "$DATABASE_URL" -f soul-server/sql/schema.sql
   ```

   모든 ALTER/CREATE는 `IF NOT EXISTS` 또는 `pg_constraint` 확인 패턴으로 멱등하다.

2. **단계 2 — payload.parent_event_id → 컬럼 이관**
   - `backfill_subtree_height.py`의 `migrate_parent_column()`이 수행.
   - 스크립트 실행 시 단계 3 직전에 자동으로 실행된다.

   SQL 동등물:

   ```sql
   UPDATE events
   SET parent_event_id = (payload->>'parent_event_id')::integer
   WHERE parent_event_id IS NULL
     AND payload->>'parent_event_id' ~ '^\d+$';
   ```

   **정수 형식 필터 사유**: 일부 레거시 이벤트(tool_start/tool_result/subagent_*)가
   같은 키에 tool_use_id (`toolu_...`) 또는 UUID를 저장하고 있다. 의미가 다른 키이므로
   정수 형식이 아닌 값은 백필 대상이 아니며 정본 컬럼은 NULL로 남겨둔다.
   필터 없이 캐스트하면 `InvalidTextRepresentationError`로 백필이 실패한다 (2026-05-02 사고).

3. **단계 3 — Python DFS로 `subtree_height` 재계산**
   - `backfill_subtree_height.py`의 `backfill_session()`이 세션별로 수행.
   - 재귀가 아닌 **반복(iterative) DFS**로 구현되어 수천 깊이의 체인에서도 recursion limit 초과가 없다.

실행:

```bash
TEST_DATABASE_URL=postgresql://USER:PW@HOST:PORT/DBNAME \
    python scripts/backfill_subtree_height.py
```

또는 프로덕션:

```bash
DATABASE_URL=postgresql://USER:PW@HOST:PORT/DBNAME \
    python scripts/backfill_subtree_height.py
```

먼저 영향 범위만 확인하려면 `--dry-run`:

```bash
DATABASE_URL=... python scripts/backfill_subtree_height.py --dry-run
```

## 검증 쿼리

```sql
-- 1) 컬럼이 존재하는지
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'events'
  AND column_name IN ('parent_event_id', 'subtree_height');

-- 2) 이관된 행 수 (unmigrated_int=0이면 이관 완료, non_integer는 의미가 다른 키라 컬럼 NULL이 정상)
SELECT
    COUNT(*) FILTER (WHERE parent_event_id IS NULL
                       AND payload->>'parent_event_id' ~ '^\d+$') AS unmigrated_int,
    COUNT(*) FILTER (WHERE parent_event_id IS NULL
                       AND payload->>'parent_event_id' IS NOT NULL
                       AND payload->>'parent_event_id' !~ '^\d+$') AS non_integer_legacy,
    COUNT(*) FILTER (WHERE parent_event_id IS NOT NULL) AS migrated_rows
FROM events;

-- 3) subtree_height가 자식을 가진 루트에서 > 1인지 확인 (핵심 검증)
SELECT COUNT(*) FROM events WHERE subtree_height > 1;
-- 기대값: 0 초과 (자식이 있는 이벤트가 존재한다면 반드시 양수).

-- 4) 루트들의 subtree_height 합 == 세션 내 이벤트 수 (불변식)
SELECT
    session_id,
    SUM(subtree_height) FILTER (WHERE parent_event_id IS NULL) AS sum_root_heights,
    COUNT(*) AS total_events,
    SUM(subtree_height) FILTER (WHERE parent_event_id IS NULL) = COUNT(*) AS ok
FROM events
GROUP BY session_id
HAVING SUM(subtree_height) FILTER (WHERE parent_event_id IS NULL) != COUNT(*);
-- 기대값: 빈 결과. 행이 나오면 불변식 위반 세션.
```

## 롤백 절차

```sql
-- 컬럼 및 관련 인덱스/제약 전부 제거
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_parent_fk;
DROP INDEX IF EXISTS idx_events_parent;
DROP INDEX IF EXISTS idx_events_created_at;
ALTER TABLE events DROP COLUMN IF EXISTS subtree_height;
ALTER TABLE events DROP COLUMN IF EXISTS parent_event_id;
```

롤백 후 애플리케이션이 정상 동작하려면 소스 변경(Phase 1 커밋)도 함께 되돌려야 한다.
`payload.parent_event_id`를 읽는 코드 경로는 승격 전과 동일하게 남아 있어야 한다.

## 주의사항

- 스크립트는 `TEST_DATABASE_URL` 우선, 없으면 `DATABASE_URL`을 사용한다.
- 테스트 DB 파괴 방지를 위해 **`TEST_DATABASE_URL`에 `test` 문자열이 포함되어야 한다**
  (`conftest.py`의 `ensure_test_db` 가드).
- 프로덕션에서 실행 시 다음을 반드시 먼저 확인:
  1. 전체 events 레코드 수(`SELECT COUNT(*) FROM events`).
  2. 현재 연결된 DB가 실제 프로덕션인지.
  3. 백업 스냅샷 존재.

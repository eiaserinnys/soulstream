# Task 읽기 호환 수명 계약

Runbook에서 Task로 전환하는 동안 구 이름은 읽기 경계에서만 허용한다. 새 쓰기와 producer의 정본은 항상 Task다. 이 문서가 MCP·HTTP·wire·container·Y.Doc·DB view 호환층의 제거 조건 정본이다.

## 유지 표면

- MCP: `get_runbook`, `list_runbooks`, `list_runbook_operations`
- HTTP: `GET /api/runbooks/my-turn`, `GET /api/runbooks/:runbook_id`
- wire: `runbook_updated` 소비 후 `task_updated`로 정규화
- container·Y.Doc: 저장된 `runbook` 값을 읽을 때 `task`로 정규화
- DB: `runbooks`, `runbook_sections`, `runbook_items`, `runbook_operations` 읽기 전용 view

구 mutation과 producer는 허용하지 않는다. 내부 업무 단계 번호나 개발 브랜치 순서는 호환 수명이 경과했다는 증거가 아니다.

## 제거 게이트

다음 조건을 모두 충족한 별도 후속 변경에서만 호환층을 제거한다.

1. `041_retire_task_tree.sql` 다음에 `042_runbook_to_task.sql`이 프로덕션에 적용되고, 같은 전환 창에서 Task 계약 코드가 프로덕션에 배포되어야 한다.
2. 전환 배포를 기록한 뒤 호환층을 유지한 채 최소 한 번의 production release 경계를 완전히 지나야 한다.
3. 그 관측 기간의 구 표면 사용량을 사후 검증해야 한다. 별도 사용자 승인으로 비영(非零) 허용 기준을 정하지 않았다면 기준은 0이다.
4. MCP·HTTP legacy read 요청, `runbook_updated` 수신, 구 container·Y.Doc 값 발견, DB compatibility view 조회를 배포 기록에 함께 남겨야 한다.
5. 제거 범위와 관측 증거에 대한 별도 사용자 승인을 받은 후속 PR이어야 한다.

## 관측 계획

호환 제거 판단은 지침 전환이 배포된 뒤 한 번의 full release boundary가 지난 시점에 다시 한다. 그때 `tool_start` 이벤트에서 `get_runbook`, `list_runbooks`, `list_runbook_operations`를 재계수하고, 보존 HTTP 로그와 세션 이벤트에서 `/api/runbooks`와 `runbook_updated`를 함께 확인한다.

운영 PostgreSQL에는 현재 `pg_stat_statements`가 없다. 이번 변경은 운영 설정을 바꾸지 않는다. DB view 네 개의 대체 증거는 다음 소비자 inventory로 남긴다.

- 제품 SQL: `orch-server-ts`, `soul-server-ts`, `packages/soul-common`의 실행 쿼리
- 배치·마이그레이션: `packages/db-schema/scripts`, Haniel soulstream hook
- 외부 SQL: 운영에 등록된 서비스와 수동 운영 런북

각 범위에서 `runbooks`, `runbook_sections`, `runbook_items`, `runbook_operations` 조회가 없음을 같은 기준 커밋에서 검색하고, 결과와 관측 기간을 분석 캐시에 기록한다. inventory가 닫히지 않으면 view 제거 승인을 요청하지 않는다.

## Y.Doc 이관 게이트

`migrate:ydoc-runbook-residue`는 기본이 읽기 전용 dry-run이다. apply는 Haniel release manifest의 migration 단계가 orch Board Y.Doc 호스트를 중지한 뒤 `--apply --quiesced --orch-health-url=http://127.0.0.1:5200/api/health`를 함께 지정하여 실행한다. 로컬 health endpoint가 `ECONNREFUSED`가 아니거나 timeout·원격 네트워크 오류처럼 중지를 증명할 수 없는 상태면 DB 연결 전에 거부한다. 라이브 host API를 경유하는 apply 경로는 제공하지 않는다.

Haniel release manifest 명령은 비-shell spawn 계약이므로 bare `pnpm`·`tsx`를 금지하고, `node`와 저장소 안의 실제 JavaScript 진입점을 직접 지정한다.

Y.Doc migrate·verify 명령은 중앙 `release-manifest.json`에만 존재하고 worker·standalone manifest에는 싣지 않는다. 배포 래퍼와 이관 스크립트의 `SOULSTREAM_NODE_ID=eiaserinnys` 가드는 중앙 경로의 이중 방어로 유지한다. 중앙 실행 감사 이력은 Haniel의 release backup 디렉터리 `board-yjs-runbook-migration.jsonl`에 SQL migration ledger와 분리하여 누적한다.

충돌 승인 정본은 `orch-server-ts/scripts/ydoc-runbook-collision-approvals.json`이다. 빈 배열이면 중앙 배포도 read-only dry-run 보고만 남기고 성공한다. 18개 승인 hash를 모두 채운 커밋이 배포될 때만 apply와 엄격 post-start 검증을 실행한다. 1~17개처럼 부분 승인된 파일은 배포 전에 거부한다.

quiesced preflight를 통과한 도구는 snapshot과 pending update를 격리 재합성하고 Yjs 구조 변환·재직렬화를 거쳐 정본 snapshot을 쓴다. 모든 문서는 dry-run의 전체 콘텐츠 hash·계획 fingerprint·opaque ID allowlist를 write 전에 다시 검증한다. 전체 대상 문서의 source/canonical row를 한 PostgreSQL 트랜잭션 안에서 잠가 revision을 재검사하며, 모든 snapshot 교체·legacy 문서 제거·SQL 투영 동기화를 전부 커밋하거나 전부 롤백한다. 의미가 달라졌으면 새 dry-run 승인을 요구한다.

Y.Doc apply 실패는 Haniel 배포 실패로 전파된다. 트랜잭션이 원상태로 롤백된 뒤 기존 roll-forward 및 previous-release recovery 계약이 서비스를 복구한다. 별도의 Y.Doc 복구 명령이나 SQL migration ledger 행은 만들지 않는다.

문서명 충돌 18건 중 콘텐츠가 동등하지 않은 문서는 자동 삭제하지 않는다. dry-run이 산출한 collision content hash를 사용자가 별도 JSON 목록으로 승인한 경우에만 canonical `board:task:` 문서를 유지하고 legacy shadow를 제거한다. 해당 `runbook:` board item ID 18개는 고정 allowlist로 보존하며, source에만 있는 opaque ID가 있으면 승인 hash와 무관하게 거부한다.

이관 뒤 `verify:ydoc-runbook-residue`가 snapshot과 pending update를 재합성해 다음을 모두 0으로 확인해야 한다.

- `board:runbook:` 문서명
- `item_type=runbook`
- `source_runbook_item_id`와 `sourceRunbookItemId`
- SQL 투영의 runbook item·source key와 `runbook_ref`
- 각 Y.Doc board item과 `board_yjs_catalog_cache`·`board_items`의 ID·container·type·source·좌표·metadata

Phase 번호만을 근거로 이 파일이나 호환 구현을 삭제하는 변경은 계약 위반이다. 잔존 감사와 계약 테스트는 이 문서 및 모든 호환 경계 파일의 존재를 강제한다.

## 배포 순서

1. 사용자에게 배포·migration 전환 창을 승인받고 mutation을 동결한다.
2. 프로덕션 DB snapshot과 v1 Task Tree 외부 백업 검증 결과를 확보한다.
3. `041_retire_task_tree.sql`을 적용하고 백업 정합을 확인한다.
4. `042_runbook_to_task.sql`을 적용하고 migration verifier로 식별자·상태·연결·집계 보존을 확인한다.
5. Task 계약 코드를 배포한 뒤 canonical Task read와 호환 read를 smoke test한다. 이 시점까지 에이전트 지침은 구 쓰기를 시도하지 않도록 mutation 동결 상태를 유지한다.
6. atom과 디스크의 work-plan 계열 정본을 Task MCP와 `container.kind=task`로 일괄 전환한다.
7. 통제된 Task mutation 한 건을 검증한 뒤 mutation 동결을 해제하고 전환 release와 시각을 기록한다.

## Rollback 경계

- 첫 Task mutation을 받아들이기 전 실패: mutation 동결을 유지한 채 전환 전 DB snapshot, 이전 코드, 이전 에이전트 지침을 한 묶음으로 복구한다.
- 첫 Task mutation을 받아들인 뒤 실패: read-only Runbook view 위에서 이전 코드만 되돌리는 것은 금지한다. 기본 복구는 Task 계약의 roll-forward다.
- 사용자 승인으로 전체 rollback이 필요하면 mutation을 다시 동결하고, 전환 후 Task write를 재생·대조할 계획과 함께 DB snapshot·코드·에이전트 지침을 같은 창에서 복구한다. 데이터 대조 없이 부분 rollback하지 않는다.

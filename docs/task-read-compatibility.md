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

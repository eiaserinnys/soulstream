# Task와 Page 정본 불변식

Task는 Page를 대체하지 않는다. Task는 업무 상태와 체크리스트를 소유하고, Page는 업무 본문과 문맥을 소유한다. 두 모델의 연결 정본은 `tasks.task_page_id`다.

## 필수 불변식

1. 모든 Task는 정확히 하나의 `task_page_id`를 가진다. 이 값은 존재하는 `pages.id`를 가리키며 `ON DELETE RESTRICT`로 보호한다.
2. 하나의 Page를 둘 이상의 Task가 정체성으로 공유하지 않는다. `uq_tasks_task_page_id`가 이를 고정한다.
3. `task_ref` block은 탐색·표시를 위한 투영이다. Task 정체성의 정본으로 역산하지 않는다.
4. checklist의 정본은 Task item이다. Page 쪽 checklist block은 `checklist_task_projection_outbox`가 전달하는 투영이며, 실패 시 재시도하되 Task item을 되쓰지 않는다.
5. Task 본문·상위 문맥·mount와 backlink는 Page Y.Doc과 `block_links`가 소유한다. Page Y.Doc, mount, session page context를 Task 정리 작업에 포함하지 않는다.
6. Board Y.Doc의 정본 표기는 `board:task:{taskId}`, `item_type=task`, `source_task_item_id`다. `runbook` 표기는 읽기 호환 입력일 뿐 새 쓰기에서 만들지 않는다.

## 2026-08-05 운영 기준선

- Task 121개 중 `task_page_id` 보유: 121개
- `task_ref` block: 120개
- `runbook_ref` block: 0개

`task_ref` 개수는 Task 개수와 같아야 하는 불변식이 아니다. `tasks.task_page_id`와 외래키·유일 인덱스가 정체성을 판정한다.

## 변경 시 검증

- Task 생성·복구 뒤 `tasks.task_page_id IS NULL`이 0인지 확인한다.
- Page 삭제 전에 Task identity·folder project identity 사용 여부를 모두 확인한다.
- checklist 변경 뒤 outbox의 source hash와 processed hash가 수렴하는지 확인한다.
- Y.Doc 이관 뒤 snapshot과 pending update를 합쳐 구 문서명·구 item type·구 source key가 모두 0인지 확인한다.
- apply는 orch Board Y.Doc 호스트가 중지된 사용자 승인 운영 창에서만 실행한다. 로컬 health endpoint가 `ECONNREFUSED`가 아니면 DB 연결 전에 거부한다.
- 이관 계획의 전체 콘텐츠 hash·opaque ID allowlist를 write 전에 검증하고, source/canonical revision을 row lock 아래 커밋 직전 재검사한다.
- SQL 투영의 `board_items`, `board_yjs_catalog_cache`, `blocks`가 같은 Task 표기를 갖는지 확인하고, 모든 board item의 ID·container·type·source·좌표·metadata를 Y.Doc과 대조한다.

검증 도구는 `pnpm --dir orch-server-ts verify:ydoc-runbook-residue`다.

# 폴더와 체크리스트 저장 경로

업무를 별도 컨테이너로 저장하지 않는다. `folders.id`가 폴더, 체크리스트, 보드, 세션, worktree의 공통 소속이다. 체크리스트 표시를 꺼도 저장된 섹션과 항목은 유지하며 수정할 수 있다.

| 경로 | 소유자 | 저장과 알림 |
| --- | --- | --- |
| HTTP `/api/folders` 및 `/:id` | `orch-server-ts/src/folders/folder_workspace_routes.ts` | camelCase 요청과 응답. 생성과 수정은 identity service로 전달한다. |
| Host `/api/folders/host/:operation` | `folder_control_plane_host_route.ts` | snake_case 입력을 검증하고 같은 service를 호출한다. `list_child_folders(folder_id:null)`은 최상위를 조회한다. |
| 폴더 생성·이동·이름·보관·상태 | `folder_project_identity_service.ts`, `folder_project_identity_repository.ts` | 폴더, project page, board subfolder, 감사 작업을 한 트랜잭션에 저장한다. 보관은 숨김이며 내용과 부모 관계를 보존한다. |
| 부모 mount | `folder_parent_mounts.ts` | identity 트랜잭션에서 부모 page에 자식 page mount를 만든다. 이동하면 옛 mount를 제거하고 새 부모에 생성한다. 최상위에는 mount가 없다. 사용자 작성 하위 블록은 보존한다. |
| 체크리스트 | `src/checklist/checklist_control_plane_service.ts`, `src/checklist/control_plane/checklist_mutation_core.ts` | `checklist_sections.folder_id`와 `checklist_items.section_id`를 사용한다. 감사는 `folder_operations`에 통합한다. |
| 보드 여섯 종류 | `src/board-yjs/board_yjs_repository.ts` | session, markdown, subfolder, asset, frame, custom_view 모두 `folder_id` 하나로 소속한다. 문서명은 `board-folder:<id>`. |
| 오늘·별표·폴더 상세 | `src/planner/planner_repository.ts` | 폴더와 project page를 조합한다. 별표 순서는 `planner_starred_page_order`가 저장한다. 시스템 폴더 claude와 llm은 제외한다. |
| 구독 갱신 | folder service → `folder_updated` | `{folderId}`로 한 폴더를 갱신한다. 폴더 헤더 변경은 catalog도 갱신한다. page mount 변경은 부모 page 구독자에게 알린다. |

## 한 번의 배포 이관

`packages/db-schema/sql/migrations/108_unify_folders.sql`이 기존 업무 id를 폴더 id로 보존하고 체크리스트, 감사, 세션 소속, binding, 반복 실행, worktree 참조를 옮긴다. 보드의 중복 scope 열과 checklist projection outbox는 제거한다.

당시 중앙 `deploy/release-manifest.json`은 `orch-server-ts/scripts/apply-folder-storage.mjs`를 실행했다. SQL 적용 직후 `folder_storage_documents` 하위 단계에서 `folder_storage_migration_cli`가 Y.Doc 이름과 참조를 변환하고 투영과 부모 mount를 갱신했다. 세 노드 배포와 문서 변환을 확인한 뒤 이 일회성 연결과 변환기는 제거했다.

현재 중앙 배포는 `release-executor.mjs apply`로 SQL migration만 적용하며 필수 하위 단계는 없다. migration 108과 manifest 기록은 적용 이력으로 남는다.

사용자가 체크리스트 항목을 완료·취소하면 mutation owner가 `checklist_handoff.ts`를 호출한다. 기존 세션 전달 저장소에 durable_next_turn을 기록한 뒤 기존 router와 bridge로 알린다. HTTP와 host 모두 같은 경로이며 idempotent 재전송에는 중복 알림이 없다.

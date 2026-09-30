# 폴더와 카드 저장 경로

업무를 별도 컨테이너로 저장하지 않는다. `folders.id`가 폴더, 카드, 보드, 세션, worktree의 공통 소속이다. `cards`는 섹션을 거치지 않는 별도 객체다. 표시 토글(`checklist_enabled`)을 꺼도 저장된 카드는 유지한다. 토글 제거는 P1 마지막 단계다.

| 경로 | 소유자 | 저장과 알림 |
| --- | --- | --- |
| HTTP `/api/folders` 및 `/:id` | `orch-server-ts/src/folders/folder_workspace_routes.ts` | camelCase 요청과 응답. 생성과 수정은 identity service로 전달한다. |
| Host `/api/folders/host/:operation` | `folder_control_plane_host_route.ts` | snake_case 입력을 검증하고 같은 service를 호출한다. `list_child_folders(folder_id:null)`은 최상위를 조회한다. |
| 폴더 생성·이동·이름·보관·상태 | `folder_project_identity_service.ts`, `folder_project_identity_repository.ts` | 폴더, project page, board subfolder, 감사 작업을 한 트랜잭션에 저장한다. 보관은 숨김이며 내용과 부모 관계를 보존한다. |
| 부모 mount | `folder_parent_mounts.ts` | identity 트랜잭션에서 부모 page에 자식 page mount를 만든다. 이동하면 옛 mount를 제거하고 새 부모에 생성한다. 최상위에는 mount가 없다. 사용자 작성 하위 블록은 보존한다. |
| 부모 보드 identity 적용 | `src/board-yjs/board_yjs_service.ts`, `board_yjs_folder_identity.ts` | 이전 부모와 새 부모의 보드 문서를 identity 잠금과 문서 mutation gate 아래에서 갱신한다. 두 부모가 모두 null인 최상위 생성과 수정은 identity 잠금 아래에서 `persist([])`로 저장한다. 최상위로 이동할 때는 이전 부모 보드를 gate 아래에서 제거한다. 문서 mutation gate는 빈 이름 목록을 허용하지 않는다. |
| 카드 HTTP와 저장 | `src/cards/card_routes.ts`, `card_operations.ts`, `card_control_plane_service.ts`, `control_plane/card_mutation_core.ts` | `/api/cards`와 `/:id`의 상태·이동·대기열·보고·질문 답 경로. `cards.folder_id`가 소속이며 `folder_operations`가 감사 정본이다. request는 생성 후 고정, brief는 수정 가능, 보고는 추가만 한다. |
| 세션과 카드 연결 | `sessions.card_id` | ON DELETE SET NULL. 카드 상세 세션 목록과 세션 DTO cardId가 같은 열을 읽는다. 보드와 페이지 바인딩에 카드 연결 복제는 없다. |
| 보드 여섯 종류 | `src/board-yjs/board_yjs_repository.ts` | session, markdown, subfolder, asset, frame, custom_view 모두 `folder_id` 하나로 소속한다. 문서명은 `board-folder:<id>`. |
| 오늘·별표·폴더 상세 | `src/planner/planner_repository.ts` | 오늘은 attention(review, blocked question/no_report), running, queued 카드 목록을 포함한다. 대기열 순서는 queue_position_key의 C 정렬이다. 폴더 상세는 cards를 읽고 섹션은 없다. 폴더와 project page를 조합한다. 별표 순서는 `planner_starred_page_order`가 저장한다. 시스템 폴더 claude와 llm은 제외한다. |
| 구독 갱신 | card/folder service → `card_updated` / `folder_updated` | 카드 변경은 `{cardId,folderId}`, 폴더 변경은 `{folderId}`로 해당 객체를 재조회한다. 폴더 헤더 변경은 catalog도 갱신한다. page mount 변경은 부모 page 구독자에게 알린다. |

## 한 번의 배포 이관

`packages/db-schema/sql/migrations/108_unify_folders.sql`이 기존 업무 id를 폴더 id로 보존하고 체크리스트, 감사, 세션 소속, binding, 반복 실행, worktree 참조를 옮긴다. 보드의 중복 scope 열과 checklist projection outbox는 제거한다.

당시 중앙 `deploy/release-manifest.json`은 `orch-server-ts/scripts/apply-folder-storage.mjs`를 실행했다. SQL 적용 직후 `folder_storage_documents` 하위 단계에서 `folder_storage_migration_cli`가 Y.Doc 이름과 참조를 변환하고 투영과 부모 mount를 갱신했다. 세 노드 배포와 문서 변환을 확인한 뒤 이 일회성 연결과 변환기는 제거했다.

현재 중앙 배포는 `release-executor.mjs apply`로 SQL migration만 적용하며 필수 하위 단계는 없다. migration 108과 manifest 기록은 적용 이력으로 남는다.

## 카드 이관 109

`109_cards.sql`은 정의 밖 지식 카드 드리프트(`tree_nodes`, 기존 uuid형 `cards`, 전용 트리거 함수)를 제거한다. 백업은 `.local/artifacts/cards-p1-rehearsal/legacy-knowledge-cards.dump`에 별도 보존한다.

체크리스트 항목 id와 요청 원문, 담당, 생성·갱신·완료 출처를 유지해 `cards`로 이름을 바꾼다. 항목 담당이 없을 때만 섹션 담당을 복사한다. 폴더 안 순서는 섹션 순서 다음 항목 순서로 평탄화하고, 섹션 제목은 폐기한다. 두 옛 연결의 합집합을 `sessions.card_id`에 채운 뒤 연결 열과 섹션을 삭제한다. 같은 세션의 연결 카드가 다르면 트랜잭션을 거부한다.

상태는 pending→todo, in_progress→running, completed→done으로 옮긴다. review와 cancelled는 유지한다. 에이전트의 상태 변경은 running→review 또는 running→blocked(question)만 허용하며, review는 보고가 있어야 하고 done은 사용자만 만든다. 열린 질문이 남아 있으면 blocked(question)를 유지한다.

`system_settings.card_dispatch`는 기본 `{"nodeConcurrency":{"default":2}}`를 시드한다. 기존 checklist handoff 경로는 제거한다. 모든 P1 단계를 머지한 뒤 한 번에 배포한다.

## 카드 실행과 세션 연결

| 경로 | 구현 | 계약 |
| --- | --- | --- |
| 대기열 진입·재정렬 | `orch-server-ts/src/cards/card_control_plane_service.ts` → `card_dispatcher.ts` | 커밋된 mutation만 실행을 깨운다. `pickNextCard`는 C 정렬 대기열에서 자리가 있는 첫 카드를 고른다. human과 담당 없는 카드는 queued로 두고 사유를 적는다. |
| 실행 상한 | `card_dispatch_settings.ts`, `card_dispatch_settings_routes.ts` | GET/PUT `/api/settings/card-dispatch`, `{nodeConcurrency:{default:n,[nodeId]:n},expectedVersion}`. 정수 n≥0, CAS 충돌 409. 응답은 `{settings:{key,nodeConcurrency,version,updatedAt,updatedBy}}`. |
| 실행 세션 구분 | `card_dispatch_repository.ts` | `folder_operations`의 system `dispatch_card` 감사 행에 session_id/node_id를 기록한다. 세션의 카드 연결 정본은 `sessions.card_id`이며 감사 행은 디스패처 생성 출처만 나타낸다. 수동 세션은 상한에서 제외한다. |
| 세션 생성 | `card_dispatch_runtime.ts` → `session/recurring_session_creation.ts` → `SessionCommandRouter.createSession` | 기존 노드 생성/ACK/관측 경로를 재사용한다. 명령의 선택 필드 `cardId`는 camelCase다. 첫 프롬프트는 `card_prompt.ts`가 요청·경과·반려·실행 목록·대기열·카드 규칙을 조립한다. 답변 이력은 경과에 포함한다. |
| 등록 저장 | `control_plane/repositories/session_mutation_repository.ts`의 registerSession/registerSessionWithWorktree | 선택 `cardId`를 기존 등록 트랜잭션에서 `sessions.card_id`에 저장한다. 디스패처에 별도 연결 UPDATE는 없다. wire 정본은 `packages/wire-schema/src/upstream.schema.json`의 CreateSession.cardId다. |
| 종료·한도 | 커밋된 `node_session_session_updated` → `CardDispatcher.sessionEnded` | running만 blocked(no_report)로 옮긴다. `session_limit_termination.ts`의 기존 ResumeAfterLimit 신호(limit_hit)를 공유한다. review/question/done은 유지한다. 반복 작업 스케줄러의 기존 tick에서 1분마다 한도 카드의 프리셋을 확인한다. |
| 질문·답 | POST `/api/cards/:id/questions` → askQuestion / POST `/api/cards/:id/questions/:qid/answer` | 질문 본문 `{text,options?,idempotencyKey}`, trusted service bearer와 agent session header, 성공 201. 답변은 기존 intervene 계약으로 유휴 재개/실행 중 개입. 완료 세션이면 queued로 돌린다. |
| 반려 | 사람의 review→running, reason 필수 | 기존 세션이면 반려 사유 메시지, 완료 세션이면 queued. 새 세션의 첫 프롬프트에도 반려 사유를 넣는다. |
| 카드 알림 | `push/push_notifier.ts`의 notifyCard → 기존 sendToUser | 질문은 카드 제목·질문, review는 `검수 요청: {제목}`. 기존 토큰 fan-out/invalid token 제거/폴더 알림 제외를 재사용한다. orch에 Slack DM 발송 경로는 없다. |
| 표시 | `planner/planner_repository.ts`, `card_updated` | attention은 review와 blocked(question/no_report), running, queued는 전역 대기열 순서를 따른다. 카드 상세 및 세션 DTO는 같은 sessions.card_id를 읽는다. 웹·앱 소비 구현은 d/e다. |

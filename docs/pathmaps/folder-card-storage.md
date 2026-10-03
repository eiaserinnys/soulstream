# 폴더와 카드 저장 경로

`folders.id`가 폴더, 카드, 보드, 세션, worktree의 공통 소속이다. 카드는 섹션 없이 폴더에 직접 속한다. 폴더 상세의 카드 영역은 항상 보이며, 카드가 없을 때는 제목과 추가 동작만 표시한다.

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
| 세션 트리와 담당 카드 이동 | `src/session/session_board_move_service.ts` → `src/board-yjs/board_yjs_move_repository.ts` | 루트와 모든 자식을 함께 이동한다. `sessions.folder_id`와 `cards.assignee_session_id`로 연결된 카드의 `folder_id`는 DB가 정본이다. `sessions.card_id`로 소속된 카드를 담당 카드로 간주하지 않는다. |
| 같은 폴더 이동 생략 | `src/board-yjs/board_yjs_move.ts:readSessionMoveNoop` | 기존 이동의 문서 mutation gate 안에서 DB의 세션·담당 카드 폴더, 대상 live Y.Doc의 primary 항목·명시 좌표, 기존 DB/cache 합집합의 다른 폴더 primary 부재를 확인한다. 모두 같으면 문서 복제·인코딩·병합·전체 투영·이동 저장과 이동 자체 알림을 생략하고 기존 성공 DTO를 반환한다. 하나라도 다르면 기존 이동을 수행한다. 호출자가 성공 뒤 내는 catalog 알림은 유지한다. |
| 오늘·별표·폴더 상세 | `src/planner/planner_repository.ts` | 오늘은 attention(review, blocked 전체: question/no_report/limit), running, queued 카드 목록을 포함한다. 대기열 순서는 queue_position_key의 C 정렬이다. 폴더 상세는 cards를 읽고 섹션은 없다. 폴더와 project page를 조합한다. 별표 순서는 `planner_starred_page_order`가 저장한다. 시스템 폴더 claude와 llm은 제외한다. |
| 구독 갱신 | card/folder service → `card_updated` / `folder_updated` | 카드 변경은 `{cardId,folderId}`, 폴더 변경은 `{folderId}`로 해당 객체를 재조회한다. 폴더 헤더 변경은 catalog도 갱신한다. page mount 변경은 부모 page 구독자에게 알린다. |

## 한 번의 배포 이관

`packages/db-schema/sql/migrations/108_unify_folders.sql`이 기존 폴더 id를 보존하고 체크리스트, 감사, 세션 소속, binding, 반복 실행, worktree 참조를 옮긴다. 보드의 중복 scope 열과 checklist projection outbox는 제거한다. `110_drop_checklist_enabled.sql`은 이전 표시 토글 열을 삭제한다.

당시 중앙 `deploy/release-manifest.json`은 `orch-server-ts/scripts/apply-folder-storage.mjs`를 실행했다. SQL 적용 직후 `folder_storage_documents` 하위 단계에서 `folder_storage_migration_cli`가 Y.Doc 이름과 참조를 변환하고 투영과 부모 mount를 갱신했다. 세 노드 배포와 문서 변환을 확인한 뒤 이 일회성 연결과 변환기는 제거했다.

현재 중앙 배포는 `release-executor.mjs apply`로 SQL migration만 적용하며 필수 하위 단계는 없다. migration 108과 manifest 기록은 적용 이력으로 남는다.

## 카드 이관 109

`109_cards.sql`은 정의 밖 지식 카드 드리프트(`tree_nodes`, 기존 uuid형 `cards`, 전용 트리거 함수)를 제거한다. 백업은 `.local/artifacts/cards-p1-rehearsal/legacy-knowledge-cards.dump`에 별도 보존한다.

체크리스트 항목 id와 요청 원문, 담당, 생성·갱신·완료 출처를 유지해 `cards`로 이름을 바꾼다. 항목 담당이 없을 때만 섹션 담당을 복사한다. 폴더 안 순서는 섹션 순서 다음 항목 순서로 평탄화하고, 섹션 제목은 폐기한다. 두 옛 연결의 합집합을 `sessions.card_id`에 채운 뒤 연결 열과 섹션을 삭제한다. 같은 세션의 연결 카드가 다르면 트랜잭션을 거부한다.

상태는 pending→todo, in_progress→running, completed→done으로 옮긴다. review와 cancelled는 유지한다. 현재 담당 세션의 수동 상태 기록은 모든 상태 사이에서 허용하며 보고·질문·사유·보관 여부를 선행 조건으로 두지 않는다. 프로세스 실행 승인과 수동 상태 기록은 별개다.

`system_settings.card_dispatch`는 기본 `{"nodeConcurrency":{"default":2}}`를 시드한다. 기존 checklist handoff 경로는 제거한다. 모든 P1 단계를 머지한 뒤 한 번에 배포한다.

## 카드 실행과 세션 연결

| 경로 | 구현 | 계약 |
| --- | --- | --- |
| 대기열 진입·재정렬 | `orch-server-ts/src/cards/card_control_plane_service.ts` → `card_dispatcher.ts` | 커밋된 mutation만 실행을 깨운다. `pickNextCard`는 C 정렬 대기열에서 자리가 있는 첫 카드를 고른다. human과 담당 없는 카드는 queued로 두고 사유를 적는다. |
| 실행 상한 | `card_dispatch_settings.ts`, `card_dispatch_settings_routes.ts` | GET/PUT `/api/settings/card-dispatch`, `{nodeConcurrency:{default:n,[nodeId]:n},expectedVersion}`. 정수 n≥0, CAS 충돌 409. 응답은 `{settings:{key,nodeConcurrency,version,updatedAt,updatedBy}}`. |
| 실행 세션 구분 | `card_dispatch_repository.ts` | `folder_operations`의 system `dispatch_card` 감사 행에 session_id/node_id를 기록한다. 세션의 카드 연결 정본은 `sessions.card_id`이며 감사 행은 디스패처 생성 출처만 나타낸다. 수동 세션은 상한에서 제외한다. |
| 세션 생성 | `card_dispatch_runtime.ts` → `session/recurring_session_creation.ts` → `SessionCommandRouter.createSession` | 기존 노드 생성/ACK/관측 경로를 재사용한다. 명령의 선택 필드 `cardId`는 camelCase다. 첫 프롬프트는 `card_prompt.ts`가 요청·경과·반려·실행 목록·대기열·카드 규칙을 조립한다. 답변 이력은 경과에 포함한다. |
| 등록 저장 | `control_plane/repositories/session_mutation_repository.ts`의 registerSession/registerSessionWithWorktree | 선택 `cardId`를 기존 등록 트랜잭션에서 `sessions.card_id`에 저장한다. 디스패처에 별도 연결 UPDATE는 없다. wire 정본은 `packages/wire-schema/src/upstream.schema.json`의 CreateSession.cardId다. |
| 종료·한도 | 커밋된 `node_session_session_updated` → `CardDispatcher.sessionEnded` | 턴 종료만으로 no_report 막힘을 기록하지 않는다. running 담당 세션의 limit_hit 종료만 기존 경로에서 blocked(limit)로 기록한다. review/question/done은 유지한다. 반복 작업 스케줄러의 기존 tick에서 1분마다 한도 카드의 프리셋을 확인한다. |
| 질문·답 | POST `/api/cards/:id/questions` → askQuestion / POST `/api/cards/:id/questions/:qid/answer` | 질문 본문 `{text,options?,idempotencyKey}`, trusted service bearer와 agent session header, 성공 201. 답변은 기존 intervene 계약으로 유휴 재개/실행 중 개입. 완료 세션이면 queued로 돌린다. |
| 반려 | 사람의 review→running, reason 필수 | 기존 세션이면 반려 사유 메시지, 완료 세션이면 queued. 새 세션의 첫 프롬프트에도 반려 사유를 넣는다. |
| 카드 알림 | `push/push_notifier.ts`의 notifyCard → 기존 sendToUser | 질문은 카드 제목·질문, review는 `검수 요청: {제목}`. 기존 토큰 fan-out/invalid token 제거/폴더 알림 제외를 재사용한다. orch에 Slack DM 발송 경로는 없다. |
| 표시 | `planner/planner_repository.ts`, `card_updated` | attention은 review와 blocked 전체(question/no_report/limit), running, queued는 전역 대기열 순서를 따른다. 카드 상세 및 세션 DTO는 같은 sessions.card_id를 읽는다. 웹·앱 소비 구현은 d/e다. |

## 한 세션 한 카드 (115)

| 경로 | 구현 | 계약 |
| :-- | :-- | :-- |
| 담당 유일성 | `card_assignee.ts`, `card_control_plane_service.ts`, `uq_cards_assignee_session` | 보관되지 않은 카드 중 완료·취소를 포함해 세션당 한 장이다. 생성·담당 변경·보관 해제·claim·자동 착수는 기존 담당 카드 ID를 담은 422 `INVALID_CARD_REQUEST`로 중복을 거부한다. 경합은 부분 유일 인덱스가 최종 보증하며 같은 오류로 번역한다. |
| 담당 확정 | `card_assignee.ts:claimableCardSessions` | agent 담당이고 담당 세션이 비어 있을 때, 같은 카드·에이전트에 소속되며 caller가 같은 카드 소속이 아닌 세션만 수동 착수·상태 변경·reply에서 claim한다. 원래 작업과 한 트랜잭션이고 감사 payload에 `claimed_assignee=true`가 남는다. 자동배정 영수증·버전 검증은 기존 경로를 유지한다. |
| 새 업무 생성 | `mcp-contract/src/card_tools.ts` → `mcp/card_handlers.ts` → `card_operations.ts` → `createCard` | 선택 `brief`와 호출자 `idempotency_key`를 받는다. agent 세션이 assignee 키를 생략하면 그 세션의 agent/node/model preset을 읽는다. 명시한 assignee(null 포함)는 그대로 두고, 사용자·외부 LLM의 기본값은 유지한다. 새 업무는 assignee를 생략하고 queue=true로 만든다. |
| A/S | `assigned_card_context.ts`, `card_change_notification.ts`, `card_prompt.ts` | 보관 제외 담당 현황에 완료·취소도 나온다. 완료 카드 사용자 커멘트는 담당 세션에 전달하고 상태를 자동으로 바꾸지 않는다. 완료로의 상태 변경 알림은 계속 억제한다. |
| 상태 시점 | `cards.status_changed_at`, service `patch` | 실제 상태가 바뀔 때만 DB NOW()를 기록한다. brief·동일 상태 재기록·담당 변경은 시점을 유지한다. 상태 리마인더는 이 시점을 소비한다. |

`115_single_card_assignee.sql`은 기존 상태 시점을 updated_at으로 한 번만 채운다. 다중 담당은 created_at DESC, id의 C 정렬 DESC로 마지막 생성 카드만 남긴다. 사용자 지정 한 줄 예외는 세션 `41ecc1b4`의 카드 `dcf30b19`를 우선하며 해당 담당 관계가 없거나 보관이면 일반 규칙으로 돌아간다. 다른 진행 중 카드를 우선하는 규칙은 없다.

해제 카드마다 `release_card_assignee` 감사 행에 이전 담당과 남긴 카드, 적용 규칙을 남긴다. 해제는 assignee_kind·assignee_session_id·version만 바꾸고 상태·내용·updated_at·완료 출처·보고·질문·커멘트는 보존한다. 보관 카드는 정리와 인덱스 모두에서 제외한다. migration 재실행과 schema.sql 재적용은 상태 시점을 다시 채우지 않는다.


## 담당 세션 상태 리마인더

| 경로 | 구현 | 계약 |
| :-- | :-- | :-- |
| 뿌리·트리 조회 | `card_dispatch_repository.ts` → `card_status_reminder_repository.ts` | 뿌리는 assignee_session_id, 비어 있으면 claimableCardSessions의 첫 행이다. caller_session_id 후손을 재귀 조회하며 다른 보관되지 않은 카드 담당 세션과 그 아래를 제외한다. initializing·running만 활동 중이다. |
| 진행 중 안내 | 커밋된 세션 갱신 → `CardDispatcher.sessionEnded` → `card_status_reminder.ts` | 담당 뿌리가 completed 또는 한도 외 error로 끝났고 후손이 돌고 있으며 카드가 running이 아니면 진행 중 여부를 확인하도록 안내한다. 자식 종료만으로 보내지 않는다. |
| 멈춤 안내 | 담당 뿌리 종료와 기존 60초 `CardDispatcher.tick` | running 카드의 트리가 모두 멈췄고 뿌리 종료 영수증이 상태 시점보다 뒤이면 막힘·검수·재개를 안내한다. interrupted와 limit_hit 뿌리는 깨우지 않는다. 자동배정 설정과 무관하게 tick에서 확인하며 최대 2건을 보낸다. |
| 미완료 통지 판정 | `session_deliveries`, `session_delivery_relation_consumptions`, `event_ingress_receipts` | 트리로 향하는 pending 전달이 30분 미만이면 보류한다. 완료 통지 대상 후손의 relation이 장부와 소비 기록 양쪽에 없고 종료 커밋이 5분 미만이면 보류한다. 30분·5분은 고장 판단 상한이며 정상 경로에 기다리는 시간을 더하지 않는다. |
| 전달·중복 억제 | `CardDispatcherOptions.deliveryExists` → `SessionDeliveryRepository.get`, 기존 sendMessage → `sendCardChangeOnce` | ID는 `card-reminder:{cardId}:{kind}:{상태 시점의 epoch 마이크로초}:{rootSessionId}`다. 어느 상태든 같은 전달 행이 있으면 재전송하지 않는다. 수신자는 뿌리, actorKind와 caller_info.source는 system이다. pending 행 재전송은 기존 전달 경로가 담당한다. |

판정과 전송은 기존 디스패처 enqueue 체인에서 카드 mutation과 순서를 맞춘다. 실패는 warn으로 남기고 다음 tick과 기존 전달 처리에 맡긴다. 리마인더는 카드 상태를 바꾸지 않으며 새 타이머·표·재시도 계층을 만들지 않는다. brief 갱신·같은 상태 재기록·디스패처 재시작에도 같은 상태 시점의 리마인더가 반복되지 않는다.

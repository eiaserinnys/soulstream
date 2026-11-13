/**
 * 세션 상태를 쓰는 곳의 전수 목록과 상태 글자 허용 목록.
 *
 * 시험은 orch-server-ts/src 아래의 SQL 함수 호출과 직접 UPDATE/INSERT를
 * 훑어 이 목록과 정확히 같은지 본다. 새 쓰기 경로가 생기면 시험이 깨진다.
 */
export interface SessionSqlWriter {
  name: string;
  writesStatus: boolean;
  definition: string;
  callSites: Array<{ file: string; line: number }>;
  note: string;
}

export interface SessionDirectWrite {
  file: string;
  line: number;
  statement: "UPDATE" | "INSERT";
  writesStatus: boolean;
  note: string;
}

export const SESSION_SQL_WRITERS: SessionSqlWriter[] = [
  {
    name: "session_register",
    writesStatus: true,
    definition: "packages/db-schema/sql/schema.sql:1356",
    callSites: [],
    note: "정의만 있고 orch 호출은 없다. 실제 등록은 preset 변형을 쓴다.",
  },
  {
    name: "session_register_with_model_preset",
    writesStatus: true,
    definition: "packages/db-schema/sql/schema.sql:1386",
    callSites: [
      { file: "src/control_plane/repositories/session_mutation_repository.ts", line: 130 },
      { file: "src/control_plane/repositories/session_mutation_repository.ts", line: 236 },
    ],
    note: "등록 입력의 상태와 검수 칸을 그대로 INSERT한다.",
  },
  {
    name: "session_update",
    writesStatus: true,
    definition: "packages/db-schema/sql/schema.sql:1518",
    callSites: [
      { file: "src/control_plane/repositories/session_mutation_repository.ts", line: 284 },
    ],
    note: "허용 열에 status가 있어 범용 갱신으로 상태를 쓸 수 있다.",
  },
  {
    name: "session_acknowledge_review",
    writesStatus: false,
    definition: "packages/db-schema/sql/schema.sql:1425",
    callSites: [
      { file: "src/runtime/live_session_review_repository.ts", line: 23 },
      { file: "src/control_plane/repositories/session_mutation_repository.ts", line: 326 },
    ],
    note: "review_state만 쓴다.",
  },
  {
    name: "session_record_execution_registration",
    writesStatus: true,
    definition: "packages/db-schema/sql/schema.sql:1579",
    callSites: [
      { file: "src/node/event_session_effect_applier.ts", line: 163 },
    ],
    note: "워크트리 게이트 뒤 실행 등록과 상태를 쓴다.",
  },
  {
    name: "session_apply_running_transition",
    writesStatus: true,
    definition: "packages/db-schema/sql/schema.sql:4232",
    callSites: [
      { file: "src/node/event_session_effect_applier.ts", line: 74 },
    ],
    note: "워크트리 게이트 뒤 상태와 검수 칸을 쓴다.",
  },
  {
    name: "session_apply_terminal_transition",
    writesStatus: true,
    definition: "packages/db-schema/sql/schema.sql:1720",
    callSites: [
      { file: "src/node/event_session_effect_applier.ts", line: 221 },
    ],
    note: "종료 상태, 사유, 검수 칸, 종료 리비전을 쓴다.",
  },
];

export const SESSION_DIRECT_WRITES: SessionDirectWrite[] = [
  {
    file: "src/control_plane/repositories/node_startup_reconciliation.ts",
    line: 31,
    statement: "UPDATE",
    writesStatus: true,
    note: "시작 정리에서 사라진 세션을 interrupted로 쓴다.",
  },
  {
    file: "src/control_plane/repositories/node_startup_reconciliation.ts",
    line: 68,
    statement: "UPDATE",
    writesStatus: true,
    note: "시작 정리에서 살아 있는 세션을 running으로 되살린다.",
  },
  {
    file: "src/control_plane/repositories/session_mutation_repository.ts",
    line: 359,
    statement: "UPDATE",
    writesStatus: true,
    note: "노드 끊김 정리에서 interrupted와 검수 칸을 쓴다.",
  },
  {
    file: "src/control_plane/repositories/session_mutation_repository.ts",
    line: 144,
    statement: "UPDATE",
    writesStatus: false,
    note: "card_id만 쓴다.",
  },
  {
    file: "src/control_plane/repositories/session_mutation_repository.ts",
    line: 250,
    statement: "UPDATE",
    writesStatus: false,
    note: "worktree_id와 card_id만 쓴다.",
  },
  {
    file: "src/control_plane/repositories/session_mutation_repository.ts",
    line: 341,
    statement: "UPDATE",
    writesStatus: false,
    note: "모델 선택 칸만 쓴다.",
  },
  {
    file: "src/runtime/live_provider_factory.ts",
    line: 632,
    statement: "UPDATE",
    writesStatus: false,
    note: "node_id, display_name, folder_id만 쓴다.",
  },
  {
    file: "src/node/event_feed_projection_applier.ts",
    line: 49,
    statement: "UPDATE",
    writesStatus: false,
    note: "last_event_id, last_read_event_id, updated_at만 쓴다.",
  },
  {
    file: "src/control_plane/repositories/session_card_replacement.ts",
    line: 44,
    statement: "UPDATE",
    writesStatus: false,
    note: "caller_session_id만 쓴다.",
  },
];

const literalAlternative = "initializing|running|completed|error|interrupted";

/**
 * TypeScript에서 상태 글자를 직접 비교하는 식. 양쪽 방향을 모두 잡는다.
 */
export const SESSION_STATUS_LITERAL_COMPARE_PATTERN = String.raw`(?:===|!==|==|!=)\s*["'](?:${literalAlternative})["']|["'](?:${literalAlternative})["']\s*(?:===|!==|==|!=)`;

/**
 * 목록이나 포함 검사에 상태 글자를 넣는 식. 한 줄짜리 배열도 잡는다.
 */
export const SESSION_STATUS_LITERAL_LIST_PATTERN = String.raw`\b(?:includes|has)\(\s*["'](?:${literalAlternative})["']\s*\)|\[[^\]\n]*["'](?:${literalAlternative})["'][^\]\n]*\]`;

/**
 * SQL 문자열 조건에서 status와 세션 상태 글자가 함께 나오는 줄. 쓰기 대입도
 * 포함해 일부러 넓게 잡는다.
 */
export const SESSION_STATUS_LITERAL_SQL_PATTERN = String.raw`\b(?:[A-Za-z_][A-Za-z0-9_]*\.)?status\s*(?:=|<>|!=|IS\s+DISTINCT\s+FROM)\s*'(?:${literalAlternative})'|\b(?:[A-Za-z_][A-Za-z0-9_]*\.)?status\s+(?:NOT\s+)?IN\s*\([^)\n]*'(?:${literalAlternative})'|\bstatus\s*=\s*ANY\s*\(\s*ARRAY\[[^\]\n]*'(?:${literalAlternative})'`;

export interface SessionStatusLiteralFile {
  file: string;
  comparisons: number;
  lists: number;
  sql: number;
  note: string;
}

/** 새 줄이 생기면 시험이 깨진다. 다른 뜻이면 note에 적는다. */
export const SESSION_STATUS_LITERAL_ALLOWLIST: SessionStatusLiteralFile[] = [
  { file: "src/cards/card_capacity.ts", comparisons: 0, lists: 0, sql: 4, note: "카드 흐름이 카드 상태나 연결 세션 상태를 읽는다." },
  { file: "src/cards/card_change_delivery.ts", comparisons: 1, lists: 0, sql: 0, note: "카드 흐름이 카드 상태나 연결 세션 상태를 읽는다." },
  { file: "src/cards/card_change_notification.ts", comparisons: 2, lists: 0, sql: 0, note: "카드 흐름이 카드 상태나 연결 세션 상태를 읽는다." },
  { file: "src/cards/card_dispatch_repository.ts", comparisons: 0, lists: 0, sql: 3, note: "카드 흐름이 카드 상태나 연결 세션 상태를 읽는다." },
  { file: "src/cards/card_dispatch_runtime.ts", comparisons: 4, lists: 0, sql: 0, note: "카드 흐름이 카드 상태나 연결 세션 상태를 읽는다." },
  { file: "src/cards/card_dispatcher.ts", comparisons: 5, lists: 0, sql: 0, note: "카드 흐름이 카드 상태나 연결 세션 상태를 읽는다." },
  { file: "src/cards/card_execution_service.ts", comparisons: 4, lists: 2, sql: 0, note: "카드 흐름이 카드 상태나 연결 세션 상태를 읽는다." },
  { file: "src/cards/card_orchestration_coordinator.ts", comparisons: 1, lists: 1, sql: 0, note: "카드 흐름이 카드 상태나 연결 세션 상태를 읽는다." },
  { file: "src/cards/card_orchestration_repository.ts", comparisons: 1, lists: 0, sql: 0, note: "카드 흐름이 카드 상태나 연결 세션 상태를 읽는다." },
  { file: "src/cards/card_orchestration_workers.ts", comparisons: 0, lists: 1, sql: 0, note: "카드 흐름이 카드 상태나 연결 세션 상태를 읽는다." },
  { file: "src/cards/card_status_reminder_repository.ts", comparisons: 0, lists: 0, sql: 4, note: "카드 흐름이 카드 상태나 연결 세션 상태를 읽는다." },
  { file: "src/cards/card_status_reminder.ts", comparisons: 1, lists: 1, sql: 0, note: "카드 흐름이 카드 상태나 연결 세션 상태를 읽는다." },
  { file: "src/cards/card_work_dispatch_service.ts", comparisons: 1, lists: 1, sql: 0, note: "카드 흐름이 카드 상태나 연결 세션 상태를 읽는다." },
  { file: "src/cards/card_work_error_delivery.ts", comparisons: 1, lists: 0, sql: 2, note: "카드 흐름이 카드 상태나 연결 세션 상태를 읽는다." },
  { file: "src/cards/card_work_lifecycle.ts", comparisons: 0, lists: 0, sql: 2, note: "카드 흐름이 카드 상태나 연결 세션 상태를 읽는다." },
  { file: "src/cards/control_plane/card_repository.ts", comparisons: 5, lists: 0, sql: 0, note: "카드 흐름이 카드 상태나 연결 세션 상태를 읽는다." },
  { file: "src/cards/state/card_decision_facts.ts", comparisons: 0, lists: 2, sql: 0, note: "카드 결정 기계의 카드 상태 글자." },
  { file: "src/cards/state/card_decision_guards.ts", comparisons: 0, lists: 1, sql: 0, note: "카드 결정 기계의 카드 상태 글자." },
  { file: "src/cards/state/card_machine_promises.ts", comparisons: 1, lists: 1, sql: 0, note: "카드 결정 기계의 카드 상태 글자." },
  { file: "src/cards/state/card_machine_world.ts", comparisons: 0, lists: 1, sql: 0, note: "카드 결정 기계의 카드 상태 글자." },
  { file: "src/cards/state/card_remaining_evidence.ts", comparisons: 0, lists: 1, sql: 0, note: "카드 결정 기계의 카드 상태 글자." },
  { file: "src/cards/state/card_server_evidence.ts", comparisons: 0, lists: 1, sql: 0, note: "카드 결정 기계의 카드 상태 글자." },
  { file: "src/cards/supervised_card_context.ts", comparisons: 0, lists: 3, sql: 2, note: "카드 흐름이 카드 상태나 연결 세션 상태를 읽는다." },
  { file: "src/control_plane/repositories/claude_background_task_generation_repository.ts", comparisons: 0, lists: 0, sql: 4, note: "백그라운드 작업 생성 상태." },
  { file: "src/control_plane/repositories/claude_background_task_repository.ts", comparisons: 0, lists: 0, sql: 5, note: "백그라운드 작업 상태." },
  { file: "src/control_plane/repositories/node_startup_reconciliation.ts", comparisons: 0, lists: 0, sql: 7, note: "세션 상태를 읽고 쓴다." },
  { file: "src/control_plane/repositories/session_delivery_repository.ts", comparisons: 0, lists: 0, sql: 1, note: "전달 원본 세션의 종료 여부." },
  { file: "src/control_plane/repositories/session_mutation_repository.ts", comparisons: 0, lists: 0, sql: 3, note: "세션 상태를 읽고 쓴다." },
  { file: "src/control_plane/repositories/session_read_repository.ts", comparisons: 0, lists: 0, sql: 2, note: "세션 상태 읽기 조회." },
  { file: "src/control_plane/repositories/worktree_repository.ts", comparisons: 2, lists: 0, sql: 3, note: "워크트리의 활성 세션 판정." },
  { file: "src/conversation/conversation_events.ts", comparisons: 2, lists: 0, sql: 0, note: "대화 사건 종류와 수신 상태." },
  { file: "src/conversation/conversation_execution.ts", comparisons: 1, lists: 0, sql: 0, note: "대화 사건 종류와 수신 상태." },
  { file: "src/conversation/conversation_history.ts", comparisons: 0, lists: 1, sql: 0, note: "대화 사건 종류와 수신 상태." },
  { file: "src/conversation/conversation_messages.ts", comparisons: 0, lists: 1, sql: 0, note: "대화 사건 종류와 수신 상태." },
  { file: "src/conversation/conversation_projection.ts", comparisons: 1, lists: 0, sql: 0, note: "대화 사건 종류와 수신 상태." },
  { file: "src/conversation/conversation_service.ts", comparisons: 1, lists: 0, sql: 0, note: "대화 사건 종류와 수신 상태." },
  { file: "src/execute/execute_proxy_routes.ts", comparisons: 1, lists: 0, sql: 0, note: "실행 프록시 프레임 종류." },
  { file: "src/folders/folder_operations.ts", comparisons: 0, lists: 1, sql: 0, note: "폴더 운영 상태." },
  { file: "src/mcp/session_consumption_boundary.ts", comparisons: 0, lists: 1, sql: 0, note: "세션 종료 여부를 읽는다." },
  { file: "src/model/model_preset_availability.ts", comparisons: 1, lists: 0, sql: 0, note: "모델 공급자 상태." },
  { file: "src/node/control_ws_route.ts", comparisons: 1, lists: 0, sql: 0, note: "노드 제어 프레임 상태." },
  { file: "src/node/event_feed_projection_applier.ts", comparisons: 2, lists: 0, sql: 0, note: "사건 피드 표시 제목과 사건 종류." },
  { file: "src/node/event_ingress_repository.ts", comparisons: 0, lists: 0, sql: 2, note: "이벤트 수신 상태." },
  { file: "src/node/event_session_gate.ts", comparisons: 0, lists: 0, sql: 1, note: "워크트리 점유 확인의 활성 세션 목록." },
  { file: "src/node/node_claude_auth_helpers.ts", comparisons: 1, lists: 0, sql: 0, note: "노드 응답 상태." },
  { file: "src/node/pending_commands.ts", comparisons: 1, lists: 0, sql: 0, note: "노드 응답 상태." },
  { file: "src/persistent-context/persistent_context_candidates.ts", comparisons: 0, lists: 2, sql: 2, note: "카드 상태." },
  { file: "src/planner/planner_repository.ts", comparisons: 0, lists: 0, sql: 1, note: "카드 상태." },
  { file: "src/production.ts", comparisons: 6, lists: 0, sql: 0, note: "세션 종료 판정과 노드 응답 상태." },
  { file: "src/push/expo_push_provider.ts", comparisons: 1, lists: 0, sql: 0, note: "푸시 티켓 상태." },
  { file: "src/recurring-jobs/run_lifecycle.ts", comparisons: 1, lists: 0, sql: 0, note: "정기 작업 실행 상태." },
  { file: "src/recurring-jobs/service.ts", comparisons: 2, lists: 0, sql: 0, note: "정기 작업 실행 상태와 세션 종료 판정." },
  { file: "src/runtime/live_cogito_search_provider.ts", comparisons: 1, lists: 0, sql: 0, note: "검색 메타데이터 상태." },
  { file: "src/runtime/live_db_catalog_repository.ts", comparisons: 0, lists: 0, sql: 4, note: "세션 상태 읽기 조회." },
  { file: "src/runtime/live_execute_proxy_route_provider.ts", comparisons: 3, lists: 0, sql: 0, note: "세션 종료 판정과 실행 프레임 종류." },
  { file: "src/runtime/session_event_hub.ts", comparisons: 1, lists: 0, sql: 0, note: "사건 종류." },
  { file: "src/schedule/resume_after_limit_continuity.ts", comparisons: 2, lists: 0, sql: 1, note: "한도 종료 사건 판정." },
  { file: "src/schedule/resume_dispatch_decision.ts", comparisons: 2, lists: 0, sql: 0, note: "한도 재개 판정." },
  { file: "src/schedule/schedule_repository.ts", comparisons: 1, lists: 0, sql: 1, note: "정기 작업 상태." },
  { file: "src/session/child_session_check_repository.ts", comparisons: 0, lists: 0, sql: 1, note: "세션 상태 읽기." },
  { file: "src/session/recurring_session_creation.ts", comparisons: 1, lists: 0, sql: 0, note: "노드 응답 상태." },
  { file: "src/session/session_action_command_errors.ts", comparisons: 1, lists: 0, sql: 0, note: "노드 응답 상태." },
  { file: "src/session/session_background_schedule_errors.ts", comparisons: 1, lists: 0, sql: 0, note: "노드 응답 상태." },
  { file: "src/session/session_command_routes.ts", comparisons: 2, lists: 0, sql: 0, note: "노드 응답 상태." },
  { file: "src/session/session_conversation_projection.ts", comparisons: 1, lists: 1, sql: 0, note: "대화 사건 종류." },
  { file: "src/session/session_delete.ts", comparisons: 1, lists: 1, sql: 0, note: "활성 세션 판정과 노드 응답 상태." },
  { file: "src/session/session_feed_state_repository.ts", comparisons: 0, lists: 1, sql: 0, note: "피드 상태 종류." },
  { file: "src/session/session_limit_termination.ts", comparisons: 1, lists: 0, sql: 0, note: "한도 종료 판정." },
  { file: "src/session/session_resume_after_limit_routes.ts", comparisons: 0, lists: 1, sql: 0, note: "재개 사건 종류." },
  { file: "src/session/session_snapshot_service.ts", comparisons: 2, lists: 0, sql: 0, note: "세션 상태 비교." },
  { file: "src/turn-summary/session_story_repository.ts", comparisons: 0, lists: 0, sql: 2, note: "세션 종료 읽기." },
  { file: "src/turn-summary/turn_summary_completion_evidence.ts", comparisons: 1, lists: 0, sql: 0, note: "요약 완료 증거의 세션 종료 상태." },
  { file: "src/turn-summary/turn_summary_pipeline.ts", comparisons: 1, lists: 0, sql: 0, note: "요약 완료 증거의 세션 종료 상태." },
  { file: "src/turn-summary/turn_summary_repository.ts", comparisons: 1, lists: 1, sql: 0, note: "사건 종류와 작업 상태." },
  { file: "src/ui-events/ui_event_contract.ts", comparisons: 0, lists: 1, sql: 0, note: "UI 사건 상태." },
  { file: "src/usage/provider_limit_rejection.ts", comparisons: 2, lists: 0, sql: 0, note: "공급자 오류·사용 상태." },
  { file: "src/usage/provider_usage_wire.ts", comparisons: 1, lists: 0, sql: 0, note: "공급자 오류·사용 상태." },
  { file: "src/usage/session_statistics_normalizer.ts", comparisons: 0, lists: 1, sql: 0, note: "공급자 오류·사용 상태." },
  { file: "src/usage/session_statistics_usage_candidates.ts", comparisons: 2, lists: 0, sql: 0, note: "공급자 오류·사용 상태." },
  { file: "src/usage/usage_summary_service.ts", comparisons: 3, lists: 0, sql: 0, note: "공급자 오류·사용 상태." },
];

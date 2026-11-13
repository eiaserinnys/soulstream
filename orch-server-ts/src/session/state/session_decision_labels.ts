import type {
  SessionDecisionCommand,
  SessionFactValue,
} from "./session_decision_facts.js";
import type {
  SessionReviewState,
  SessionStateValue,
  SessionStatusLeaf,
} from "./session_state_value.js";

export const SESSION_COMMAND_LABELS: Record<SessionDecisionCommand, string> = {
  register: "세션 줄을 만든다",
  execution_registration: "실행 등록을 기록한다",
  running_transition: "실행 중 전환을 기록한다",
  terminal_transition: "종료 전환을 기록한다",
  node_disconnect_cleanup: "노드 끊김을 정리한다",
  startup_reconcile_missing: "시작 정리에서 사라진 세션을 멈춘다",
  startup_reconcile_restore: "시작 정리에서 살아 있는 세션을 되살린다",
  stale_registration: "옛 실행 등록 사건을 막는다",
  session_update_status: "범용 갱신으로 상태를 쓴다",
  acknowledge_review: "검수를 확인한다",
  delete: "세션을 지운다",
  resume_dispatch: "한도 재개 예약을 판정한다",
};

export const SESSION_COMMAND_RULES: Record<SessionDecisionCommand, string> = {
  register:
    "같은 세션 줄이 없을 때 새 줄을 만든다. 상태와 검수 칸은 등록 입력이 정하며, 만든 뒤에는 initializing이다.",
  execution_registration:
    "세션 줄을 잠그고 실행 등록을 적는다. 워크트리가 있으면 준비 상태와 다른 활성 세션 점유를 먼저 본다. 종료 재개면 기대한 종료 리비전이 같을 때만 running으로 되살리고 종료 칸을 지운다. 재개가 아니면 종료 상태가 아닌 줄만 running으로 옮기며 종료 사유와 설명은 지우되 종료 리비전은 남긴다.",
  running_transition:
    "실행 등록과 같은 워크트리 게이트와 종료 재개 규칙을 쓴다. 등록 id는 쓰지 않고 상태와 검수 칸만 고친다.",
  terminal_transition:
    "기대한 종료 사건 번호가 양수일 때만 쓴다. 이미 완료나 오류로 끝난 줄, 종료 리비전이 기록된 중단 줄은 건드리지 않는다. 기존 종료 리비전이 없거나 새 사건 번호보다 작을 때만 종료 상태와 사유, 검수 칸, 마지막 발화를 적는다.",
  node_disconnect_cleanup:
    "노드가 실행 중이던 세션을 끊김으로 정리한다. 이 노드의 initializing이나 running 줄만 interrupted로 옮기고 종료 사유를 killed, 검수 칸을 review_required에 따라 정한다. 종료 리비전 칸은 건드리지 않는다.",
  startup_reconcile_missing:
    "시작 시점에 잡아 둔 대상과 지금 줄이 같고, 노드의 실행 목록에 없으며, 아직 활성인 줄만 interrupted로 옮긴다. 줄과 대상의 종료 칸과 실행 id가 다르면 건드리지 않는다. 종료 리비전 칸은 건드리지 않는다.",
  startup_reconcile_restore:
    "끊김 종료가 리비전 없이 기록된 줄을 노드가 실행 중이라고 보고하고 워크트리가 준비됐을 때만 running으로 되살린다. 종료 칸을 지우고 검수 칸을 not_required로 둔다.",
  stale_registration:
    "세션 줄이 없으면 예외를 던진다. 사건의 실행 등록 id가 세션의 현재 등록과 다르면 사건을 적용하지 않고 dead-letter로 보낸다. 저장 상태는 바꾸지 않는다.",
  session_update_status:
    "session_update의 허용 열에 status가 있어 상태를 그대로 쓸 수 있다. 다른 상태 칸과 종료 칸은 건드리지 않는다. 종료 세션을 running으로 되살리는 길이 열려 있는 알려진 구멍이다.",
  acknowledge_review:
    "잠근 줄의 review_required와 review_state를 읽어 not_found, not_required, already_acknowledged, not_pending, acknowledged 가운데 하나를 낸다. needs_review일 때만 acknowledged로 쓴다.",
  delete:
    "노드가 붙어 있으면 상태와 무관하게 노드에 삭제를 보낸다. 노드가 거절하면 409, 응답을 기다리는 중이면 accepted, 노드가 못 지우거나 옛 판이면 활성 세션만 409로 막고 끝난 세션은 orch가 직접 지운다.",
  resume_dispatch:
    "예약에 적힌 종료 리비전, 노드의 지역 작업 상태, 세션 줄, 한도 창과 종료 사슬을 차례로 본다. 모두 통과할 때만 깨우고, 지역 작업이 바쁘면 미루며, 나머지는 예약을 닫는다. 저장 상태는 바꾸지 않는다.",
};

export const SESSION_REASON_LABELS: Record<string, string> = {
  session_exists: "같은 세션 줄이 이미 있다",
  session_missing: "세션 줄이 없다",
  worktree_blocked: "워크트리가 준비되지 않았거나 다른 활성 세션이 쓴다",
  terminal_resume_not_terminal: "종료 재개인데 세션이 종료 상태가 아니다",
  terminal_revision_changed: "기대한 종료 리비전과 다르다",
  terminal_without_resume: "종료 재개 표시 없이 종료 세션을 실행 중으로 바꾸려 한다",
  status_fence: "이미 완료나 오류로 끝났거나, 중단 종료가 리비전과 함께 기록됐다",
  revision_not_newer: "새 종료 사건 번호가 기존 기록보다 새롭지 않다",
  invalid_terminal_event: "종료 사건 번호가 양수가 아니다",
  other_node: "다른 노드의 세션이다",
  not_active: "초기화 중이거나 실행 중인 세션이 아니다",
  target_missing: "시작 시점에 잡아 둔 대상과 지금 줄이 다르다",
  reported_running: "노드가 아직 실행 중이라고 보고했다",
  not_disconnected: "끊김 종료가 리비전 없이 기록된 세션이 아니다",
  not_reported: "노드의 실행 목록에 없다",
  registration_mismatch: "사건의 실행 등록이 세션의 현재 등록과 다르다",
  review_not_required: "검수가 필요 없는 세션이다",
  already_acknowledged: "이미 검수를 확인했다",
  review_not_pending: "검수 대기 상태가 아니다",
  session_not_found: "세션을 찾을 수 없다",
  node_rejected: "노드가 삭제를 거절했다",
  node_delete_pending: "노드의 삭제 응답을 기다리는 중이다",
  requires_stop: "실행 중인 세션은 멈춘 뒤 지워야 한다",
  node_connecting: "노드 연결을 기다리는 중이다",
  invalid_original_revision: "예약에 기록한 종료 리비전을 읽을 수 없다",
  local_task_busy: "노드의 지역 작업이 아직 바쁘다",
  session_already_awake: "세션이 이미 실행 중이거나 초기화 중이다",
  current_session_not_limit_hit: "현재 세션이 한도 종료가 아니다",
  missing_current_revision: "현재 세션의 종료 리비전이 없다",
  limit_window_or_terminal_chain_changed: "한도 창이나 종료 사슬이 예약과 다르다",
  registered: "세션 줄을 만들었다",
  active_registration: "실행 등록을 기록하고 실행 중으로 옮겼다",
  terminal_resume: "종료 세션을 실행 등록으로 재개했다",
  terminal_recorded: "종료를 기록했다",
  disconnect_cleanup: "노드 끊김을 중단 종료로 기록했다",
  startup_interrupted: "시작 정리에서 사라진 세션을 중단 종료로 기록했다",
  startup_restored: "시작 정리에서 세션을 실행 중으로 되살렸다",
  registration_current: "실행 등록이 현재와 같아 사건을 받는다",
  status_written: "범용 갱신으로 상태를 썼다",
  review_acknowledged: "검수를 확인했다",
  deleted: "세션 줄을 지웠다",
  fire: "한도 재개를 실행한다",
};

export const SESSION_STATUS_LABELS: Record<SessionStatusLeaf, string> = {
  none: "줄 없음",
  initializing: "초기화 중",
  running: "실행 중",
  completed: "완료",
  error: "오류",
  interrupted: "중단",
};

export const SESSION_REVIEW_LABELS: Record<SessionReviewState, string> = {
  not_required: "검수 불필요",
  needs_review: "검수 대기",
  acknowledged: "검수 확인",
};

export const SESSION_FACT_LABELS: Record<
  string,
  Record<string, string> | undefined
> = {
  resume: {
    fresh: "새 실행",
    terminal_match: "종료 재개, 리비전 일치",
    terminal_mismatch: "종료 재개, 리비전 불일치",
  },
  worktreeReady: { true: "준비됨", false: "준비 안 됨" },
  worktree: {
    none: "워크트리 없음",
    ready: "준비됨",
    not_ready: "준비 안 됨",
    setup_required: "설치 필요",
  },
  worktreeBusy: { true: "다른 활성 세션 점유", false: "점유 없음" },
  revision: {
    none: "기록 없음",
    less: "기존보다 새로움",
    equal: "기존과 같음",
    greater: "기존보다 오래됨",
  },
  eventId: { positive: "양수", non_positive: "양수 아님" },
  nodeOwns: { true: "이 노드", false: "다른 노드" },
  targetMatches: { true: "대상과 일치", false: "대상과 다름" },
  inRunningList: { true: "노드 보고에 있음", false: "노드 보고에 없음" },
  registration: {
    not_provided: "사건에 없음",
    matches: "현재와 같음",
    stale: "현재와 다름",
  },
  reviewRequired: { true: "검수 필요", false: "검수 불필요" },
  path: {
    deleted: "노드가 지움",
    rejected: "노드가 거절",
    timeout: "응답 대기",
    declined: "노드가 못 지움",
    unavailable: "노드 연결 없음",
  },
  originalRevision: { true: "읽을 수 있음", false: "읽을 수 없음" },
  localTaskBusy: { true: "바쁨", false: "한가함" },
  termination: {
    limit_recorded: "한도 종료, 리비전 있음",
    limit_missing_revision: "한도 종료, 리비전 없음",
    other: "한도 종료 아님",
  },
  chainContinued: { true: "이어짐", false: "끊김" },
  reviewNext: {
    not_required: "검수 불필요로 씀",
    needs_review: "검수 대기로 씀",
    acknowledged: "검수 확인으로 씀",
  },
  target: { completed: "완료", error: "오류", interrupted: "중단" },
};

export function stateValueLabel(value: SessionStateValue): string {
  const parts = [SESSION_STATUS_LABELS[value.status]];
  if (value.termination === "recorded") parts.push("종료 기록 있음");
  if (value.review !== "not_required") {
    parts.push(SESSION_REVIEW_LABELS[value.review]);
  }
  if (value.reservation === "reserved") parts.push("한도 예약 있음");
  return parts.join(" · ");
}

export function factValueLabel(key: string, value: SessionFactValue): string {
  const label = SESSION_FACT_LABELS[key]?.[String(value)];
  if (label) return label;
  if (value === true) return "예";
  if (value === false) return "아니오";
  return String(value);
}

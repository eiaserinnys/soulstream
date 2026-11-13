import type { NodeBarrierKind, NodeBarrierState, NodeStopDisposition } from "./node_barrier_machine.js";
import type { NodeExecutionPhase } from "./node_execution_machine.js";
import type { NodeCleanupIntent } from "./node_response_decision.js";
import type {
  NodeCentralSession,
  NodeRegistrationMatch,
  NodeResponseCall,
  NodeResponseCell,
  NodeResponseRoute,
  NodeTerminationProjection,
  NodeWireReason,
} from "./node_response_machine.js";
import type { NodeRequestDisposition, NodeRequestKind } from "./node_request_machine.js";

export const NODE_PHASE_LABELS: Readonly<Record<NodeExecutionPhase, string>> = {
  retained_releasing: "종료 뒤 러너 해제 중",
  retained_claude_background: "종료 뒤 클로드 백그라운드 작업 보유",
  retained_codex_command: "종료 뒤 코덱스 남은 명령 보유",
  stopping: "멈추는 중",
  hydrated_active: "러너 없이 올린 활성 task",
  starting: "러너를 띄우는 중",
  replaying: "러너의 남은 기록을 올리는 중",
  terminating: "종료를 올리는 중",
  registering: "실행 등록 응답을 기다리는 중",
  running: "러너가 턴을 도는 중",
  idle: "주인 없음",
};

export const NODE_CALL_LABELS: Readonly<Record<NodeResponseCall, string>> = {
  execution_registration: "실행 등록",
  startup_recovery_adopt: "시동 복구 잇기",
  attached_runner_adopt: "붙은 러너 잇기",
  resume: "재개",
  resume_compensation_terminal: "재개 보정 종료",
  first_message: "첫 메시지",
  termination: "종료",
};

export const NODE_ROUTE_LABELS: Readonly<Record<NodeResponseRoute, string>> = {
  transport_retryable: "전송 거절(다시 될 수 있음)",
  transport_quarantine: "전송 거절(영구라 격리)",
  dead_letter: "응답 안의 dead letter",
  applied_false: "applied=false와 거절 사유",
  no_response: "응답 없음",
};

export const NODE_REASON_LABELS: Readonly<Record<NodeWireReason, string>> = {
  already_terminal: "already_terminal",
  session_missing: "session_missing",
  owner_node_changed: "owner_node_changed",
  worktree_busy: "worktree_busy",
  worktree_not_ready: "worktree_not_ready",
  none: "사유 없음",
};

export const NODE_REGISTRATION_LABELS: Readonly<Record<NodeRegistrationMatch, string>> = {
  same: "우리 등록",
  different: "낡은 등록",
};

export const NODE_TERMINATION_LABELS: Readonly<Record<NodeTerminationProjection, string>> = {
  same: "우리 종료와 같음",
  different: "다른 종료",
  absent: "없음",
};

export const NODE_CENTRAL_LABELS: Readonly<Record<NodeCentralSession, string>> = {
  present: "있음",
  absent: "없음",
  unknown: "모름",
};

export const NODE_CELL_LABELS: Readonly<Record<NodeResponseCell, string>> = {
  applied: "적용됨",
  retryable: "다시 될 수 있는 거절",
  no_retry: "다시 될 까닭이 없는 거절",
  permanent: "영구 거절",
  quarantine: "격리",
};

export const NODE_INTENT_LABELS: Readonly<Record<NodeCleanupIntent, string>> = {
  retry_later: "나중에 다시 시도",
  resubmit_same_termination: "같은 종료를 다시 올림",
  abandon_attempt: "이 시도를 그만둠",
  mark_central_error: "중앙 상태를 오류로 덮음(거절된 그 등록과 실행 명령에만)",
  reap_runner: "러너 거둠",
  close_settlement_pending: "완료 정산 미결 닫기",
  retire_rejected_registration: "거절된 그 러너 등록 은퇴",
  release_local_ownership: "로컬 소유 정리",
};

export const NODE_REQUEST_LABELS: Readonly<Record<NodeRequestKind, string>> = {
  stop: "멈춤",
  intervene: "지시",
  delete: "삭제",
  resume: "재개",
};

export const NODE_REQUEST_DISPOSITION_LABELS: Readonly<
  Record<NodeRequestDisposition, string>
> = {
  reject_not_running: "실행 중이 아니라고 거절",
  terminate_without_runner: "러너 없이 종료 기록을 만듦",
  interrupt_and_terminate: "러너에 멈춤 명령 후 멈춤으로 종료",
  join_stop: "앞선 멈춤에 붙음",
  queue_and_restart: "대기 줄에 넣고 다시 띄움",
  hold_until_started: "시동이 끝날 때까지 붙듦",
  deliver_or_queue: "엔진에 넣어 보고 안 되면 대기 줄",
  delete_row: "줄을 지움",
  terminate_without_runner_then_delete: "종료 기록을 만든 뒤 지움",
  stop_then_delete: "멈춘 뒤 지움",
  start_execution: "새 실행 시작",
  join_start: "진행 중인 시동에 붙음",
  start_on_retained_runner: "보유한 러너로 새 실행 시작",
  reject_runner_attached: "러너가 붙어 있어 거절",
  wait_then_start: "앞 일이 끝난 뒤 시작",
};

export const NODE_BARRIER_STATE_LABELS: Readonly<Record<NodeBarrierState, string>> = {
  none: "장벽 없음",
  execution_start: "실행 시작 장벽",
  intervention_handoff: "지시 넘기기 장벽",
  stop_waiting_handoff: "넘기기를 기다리는 멈춤",
  stop: "멈춤 장벽",
};

export const NODE_BARRIER_KIND_LABELS: Readonly<Record<NodeBarrierKind, string>> = {
  execution_start: "실행 시작",
  intervention_handoff: "지시 넘기기",
  stop: "멈춤",
};

export const NODE_STOP_DISPOSITION_LABELS: Readonly<Record<NodeStopDisposition, string>> = {
  stop_now: "곧바로 멈춤",
  stop_after_handoff: "넘기기가 끝난 뒤 보통 멈춤 길로",
  already_stopping: "이미 멈추는 중",
};

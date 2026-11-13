/**
 * 세션 명령의 유한 사실 목록과 표에 오르는 사실 조합.
 *
 * 저장 영역(status, termination, review, reservation)은 사실이 아니다. 여기
 * 적은 값은 지금 SQL 함수와 TypeScript 판정 함수가 실제로 가르는 것만 담는다.
 * 쓰기만 하는 값(다음 검수 상태, 종료 목표 상태)은 명령이 나르는 값이라
 * 사실 목록에서 빼고 표의 조건 일관성에만 쓴다.
 */
const flag = [false, true] as const;

export const SESSION_RESUME_VALUES = [
  "fresh",
  "terminal_match",
  "terminal_mismatch",
] as const;
export type SessionResume = (typeof SESSION_RESUME_VALUES)[number];

export const SESSION_TERMINAL_TARGETS = [
  "completed",
  "error",
  "interrupted",
] as const;
export type SessionTerminalTarget = (typeof SESSION_TERMINAL_TARGETS)[number];

export const SESSION_REVISION_VALUES = [
  "none",
  "less",
  "equal",
  "greater",
] as const;
export type SessionRevision = (typeof SESSION_REVISION_VALUES)[number];

export const SESSION_REGISTRATION_VALUES = [
  "not_provided",
  "matches",
  "stale",
] as const;

export const SESSION_DELETE_PATHS = [
  "deleted",
  "rejected",
  "timeout",
  "declined",
  "unavailable",
] as const;
export type SessionDeletePath = (typeof SESSION_DELETE_PATHS)[number];

export const SESSION_LIMIT_TERMINATION_VALUES = [
  "limit_recorded",
  "limit_missing_revision",
  "other",
] as const;

export const SESSION_FACT_VALUES = {
  register: {},
  execution_registration: { resume: SESSION_RESUME_VALUES, worktreeReady: flag },
  running_transition: { resume: SESSION_RESUME_VALUES, worktreeReady: flag },
  terminal_transition: { revision: SESSION_REVISION_VALUES },
  node_disconnect_cleanup: { nodeOwns: flag },
  startup_reconcile_missing: { targetMatches: flag, inRunningList: flag },
  startup_reconcile_restore: { inRunningList: flag, worktreeReady: flag },
  stale_registration: { registration: SESSION_REGISTRATION_VALUES },
  session_update_status: {},
  acknowledge_review: { reviewRequired: flag },
  delete: { path: SESSION_DELETE_PATHS },
  resume_dispatch: {
    originalRevision: flag,
    localTaskBusy: flag,
    termination: SESSION_LIMIT_TERMINATION_VALUES,
    chainContinued: flag,
  },
} as const;

export type SessionDecisionCommand = keyof typeof SESSION_FACT_VALUES;
export type SessionFactValue = string | boolean;
export type FiniteFacts = Partial<Record<string, SessionFactValue>>;

export const SESSION_COMMANDS = Object.keys(
  SESSION_FACT_VALUES,
) as SessionDecisionCommand[];

export interface SessionCommand {
  type: SessionDecisionCommand;
  reviewNext?: "not_required" | "needs_review" | "acknowledged";
  target?: SessionTerminalTarget;
}

export interface SessionDecisionEvent {
  type: SessionDecisionCommand;
  command: SessionCommand;
  facts: FiniteFacts;
}

/** 표의 한 줄이 쓰는 대표 명령 값. payload 변화는 별도 시험이 확인한다. */
export const SESSION_TABLE_COMMAND: Record<
  SessionDecisionCommand,
  SessionCommand
> = {
  register: { type: "register", reviewNext: "not_required" },
  execution_registration: {
    type: "execution_registration",
    reviewNext: "needs_review",
  },
  running_transition: { type: "running_transition", reviewNext: "needs_review" },
  terminal_transition: {
    type: "terminal_transition",
    reviewNext: "needs_review",
    target: "completed",
  },
  node_disconnect_cleanup: {
    type: "node_disconnect_cleanup",
    reviewNext: "needs_review",
  },
  startup_reconcile_missing: {
    type: "startup_reconcile_missing",
    reviewNext: "needs_review",
  },
  startup_reconcile_restore: { type: "startup_reconcile_restore" },
  stale_registration: { type: "stale_registration" },
  session_update_status: { type: "session_update_status" },
  acknowledge_review: { type: "acknowledge_review" },
  delete: { type: "delete" },
  resume_dispatch: { type: "resume_dispatch" },
};

export function* enumerateSessionFacts(
  command: SessionDecisionCommand,
): Generator<FiniteFacts> {
  const entries = Object.entries(SESSION_FACT_VALUES[command]) as Array<
    [string, readonly SessionFactValue[]]
  >;
  function* walk(index: number, row: FiniteFacts): Generator<FiniteFacts> {
    if (index === entries.length) {
      yield row;
      return;
    }
    const [key, values] = entries[index]!;
    for (const value of values) yield* walk(index + 1, { ...row, [key]: value });
  }
  yield* walk(0, {});
}

/** 명령이 나르는 값 가운데 판정에 쓰이는 사실만 꺼낸다. */
export function deriveSessionFacts(command: SessionCommand): FiniteFacts {
  const facts: FiniteFacts = {};
  if (command.reviewNext !== undefined) facts.reviewNext = command.reviewNext;
  if (command.target !== undefined) facts.target = command.target;
  return facts;
}

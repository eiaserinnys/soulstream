import {
  deriveSessionFacts,
  enumerateSessionFacts,
  SESSION_COMMANDS,
  SESSION_TABLE_COMMAND,
  type FiniteFacts,
  type SessionCommand,
  type SessionDecisionCommand,
} from "./session_decision_facts.js";
import { decideSessionTransition, type SessionDecision } from "./session_decision.js";
import type { SessionStateValue } from "./session_state_value.js";

export interface SessionDecisionRow {
  state: SessionStateValue;
  command: SessionCommand;
  facts: FiniteFacts;
  decision: SessionDecision;
}

function state(
  status: SessionStateValue["status"],
  termination: SessionStateValue["termination"] = "none",
  review: SessionStateValue["review"] = "not_required",
): SessionStateValue {
  return { status, termination, review, reservation: "none", verdict: "ready" };
}

/**
 * 지금 코드가 실제로 구분하는 저장 상태 값. 예약 있는 세계는 아직 없다.
 * 새 실행 경로는 종료 상태가 아닌 줄의 종료 리비전을 지우지 않으므로
 * initializing과 running에도 종료 리비전이 기록된 줄이 존재한다
 * (schema.sql session_record_execution_registration의 fresh 분기).
 */
export const SESSION_TABLE_STATES: readonly SessionStateValue[] = [
  state("none"),
  state("initializing"),
  state("initializing", "recorded"),
  state("running", "none", "acknowledged"),
  state("running", "recorded"),
  state("completed", "recorded", "needs_review"),
  state("error", "recorded", "needs_review"),
  state("interrupted", "none", "needs_review"),
  state("interrupted", "recorded", "needs_review"),
];

/**
 * 검수 확인은 review_required와 review_state를 함께 읽으므로, 검수 칸의 나머지
 * 조합을 대표하는 줄을 더 둔다.
 */
export const SESSION_ACKNOWLEDGE_STATES: readonly SessionStateValue[] = [
  state("none"),
  state("initializing"),
  state("running", "none", "not_required"),
  state("running", "none", "acknowledged"),
  state("completed", "recorded", "not_required"),
  state("completed", "recorded", "needs_review"),
  state("completed", "recorded", "acknowledged"),
];

/**
 * 독립적으로 기록된 사실 사이의 모순만 거른다. 저장 상태 값과 사실이 같은
 * 사건을 가리키는 경우(종료 리비전 없음과 비교 결과 없음)는 모순이다.
 */
export function sessionFactsConsistent(
  value: SessionStateValue,
  command: SessionDecisionCommand,
  facts: FiniteFacts,
): boolean {
  if (command === "terminal_transition") {
    const revisionConsistent = value.termination === "none"
      ? facts.revision === "none"
      : facts.revision !== "none";
    if (!revisionConsistent) return false;
    // 양수가 아닌 사건 번호는 SQL이 줄을 읽기 전에 예외를 던지는 한 칸이다.
    if (facts.eventId === "non_positive") {
      return value.status === "none" && facts.revision === "none";
    }
    return true;
  }
  if (
    command === "execution_registration" || command === "running_transition"
  ) {
    // 잇기는 expected_terminal_event_id를 보내지 않으므로 새 실행일 때만 성립한다.
    if (facts.adopt === true && facts.resume !== "fresh") return false;
    // 줄이 없으면 워크트리도 점유도 없다.
    if (value.status === "none") {
      return facts.worktree === "none" && facts.worktreeBusy === false;
    }
    // 같은 워크트리에 다른 활성 세션이 있을 수 있는 줄은 종료 상태뿐이다
    // (uq_sessions_active_worktree).
    if (facts.worktreeBusy === true) {
      return facts.worktree === "ready" && TERMINAL_STATUSES.has(value.status);
    }
    return true;
  }
  if (command === "startup_reconcile_missing" && facts.targetMatches === true) {
    return value.status === "initializing" || value.status === "running";
  }
  if (command === "resume_dispatch") {
    if (facts.originalRevision !== true) {
      return facts.localTaskBusy !== true
        && facts.termination === "other"
        && facts.chainContinued === true;
    }
    if (facts.localTaskBusy === true) {
      return facts.termination === "other" && facts.chainContinued === true;
    }
    if (facts.termination !== "limit_recorded") {
      return facts.chainContinued === true;
    }
  }
  return true;
}

const TERMINAL_STATUSES = new Set(["completed", "error", "interrupted"]);

/** 소유 노드 사실을 읽는 명령. 이 명령들은 owner=mismatch를 대표 한 칸으로 둔다. */
const OWNER_COMMANDS = new Set<SessionDecisionCommand>([
  "execution_registration",
  "running_transition",
  "terminal_transition",
]);

/**
 * owner=mismatch는 상태 값마다 대표 한 칸만 둔다. 다른 사실은 그 상태에서
 * 모순이 없는 대표값을 쓴다. 소유 노드 거절이 세션 없음 다음으로 먼저라
 * 나머지 사실은 판정을 바꾸지 않는다.
 */
function representativeMismatchFacts(
  value: SessionStateValue,
  command: SessionDecisionCommand,
): FiniteFacts {
  if (command === "terminal_transition") {
    return value.termination === "none"
      ? { revision: "none", eventId: "positive", owner: "mismatch" }
      : { revision: "less", eventId: "positive", owner: "mismatch" };
  }
  const terminal = value.termination === "recorded";
  const facts: FiniteFacts = {
    resume: terminal ? "terminal_match" : "fresh",
    worktree: value.status === "none" ? "none" : "ready",
    worktreeBusy: false,
    owner: "mismatch",
  };
  if (command === "running_transition") facts.adopt = false;
  return facts;
}

let cached: SessionDecisionRow[] | null = null;

/**
 * 명령 × 저장 상태 값 × 일관된 사실 조합의 결정표. 빈 칸은 없다.
 */
export function sessionDecisionTable(): SessionDecisionRow[] {
  if (cached) return cached;
  const rows: SessionDecisionRow[] = [];
  for (const command of SESSION_COMMANDS) {
    const states =
      command === "acknowledge_review"
        ? SESSION_ACKNOWLEDGE_STATES
        : SESSION_TABLE_STATES;
    const payload = SESSION_TABLE_COMMAND[command];
    for (const value of states) {
      for (const facts of enumerateSessionFacts(command)) {
        if (facts.owner === "mismatch") continue;
        if (!sessionFactsConsistent(value, command, facts)) continue;
        rows.push({
          state: value,
          command: payload,
          facts: { ...deriveSessionFacts(payload), ...facts },
          decision: decideSessionTransition(value, payload, facts),
        });
      }
      if (OWNER_COMMANDS.has(command)) {
        const facts = representativeMismatchFacts(value, command);
        rows.push({
          state: value,
          command: payload,
          facts: { ...deriveSessionFacts(payload), ...facts },
          decision: decideSessionTransition(value, payload, facts),
        });
      }
    }
  }
  cached = rows;
  return rows;
}

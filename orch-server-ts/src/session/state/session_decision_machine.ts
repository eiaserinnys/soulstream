import { and, setup } from "xstate";

import {
  SESSION_COMMANDS,
  type SessionDecisionCommand,
  type SessionDecisionEvent,
} from "./session_decision_facts.js";
import {
  sessionApplied,
  sessionDecisionGuards,
  sessionNoops,
  sessionRejections,
} from "./session_decision_guards.js";
import {
  SESSION_COMMAND_LABELS,
  SESSION_COMMAND_RULES,
  SESSION_REASON_LABELS,
} from "./session_decision_labels.js";
import { sessionEffects } from "./session_decision_effects.js";

const leaf = (id: string, description: string) => ({ id, description });

const APPLY_REASONS: Partial<Record<SessionDecisionCommand, string>> = {
  register: "registered",
  terminal_transition: "terminal_recorded",
  node_disconnect_cleanup: "disconnect_cleanup",
  startup_reconcile_missing: "startup_interrupted",
  startup_reconcile_restore: "startup_restored",
  stale_registration: "registration_current",
  session_update_status: "status_written",
  acknowledge_review: "review_acknowledged",
  delete: "deleted",
  resume_dispatch: "fire",
};

function meta(command: SessionDecisionCommand, reason: string) {
  return {
    command,
    reason,
    label: `${SESSION_COMMAND_LABELS[command]}: ${
      SESSION_REASON_LABELS[reason] ?? reason
    }`,
    rule: SESSION_COMMAND_RULES[command],
  };
}

function decision(
  command: SessionDecisionCommand,
  kind: "apply" | "noop" | "reject",
  reason: string,
  guard: string | any,
) {
  return {
    guard,
    actions: { type: kind, params: { reason } },
    description: meta(command, reason).label,
    meta: meta(command, reason),
  };
}

/**
 * 판정 가드의 평가 순서. 명시하지 않은 명령은 거절 다음 무시 순서다.
 * 한도 재개는 예약이 살아 있는 한 지역 작업 바쁨을 먼저 보고, 그 다음에
 * 세션 줄을 본다(제품 판정 함수와 같은 순서).
 */
const GUARD_ORDER: Partial<Record<SessionDecisionCommand, string[]>> = {
  resume_dispatch: [
    "revision",
    "busy",
    "missing",
    "awake",
    "notLimit",
    "missingRevision",
    "chain",
  ],
};

function orderedGuards(command: SessionDecisionCommand) {
  const entries = [
    ...sessionRejections[command].map((entry) => ({
      kind: "reject" as const,
      entry,
    })),
    ...sessionNoops[command].map((entry) => ({
      kind: "noop" as const,
      entry,
    })),
  ];
  const order = GUARD_ORDER[command];
  if (!order) return entries;
  return [...entries].sort(
    (left, right) =>
      order.indexOf(left.entry.guard.split(".").at(-1)!)
      - order.indexOf(right.entry.guard.split(".").at(-1)!),
  );
}

const verdict: Record<string, any[]> = {};
sessionDecisionGuards["apply.execution_registration.terminal_resume"] = and([
  sessionApplied("execution_registration"),
  ({ event }: { event: SessionDecisionEvent }) =>
    event.facts.resume === "terminal_match",
]);
sessionDecisionGuards["apply.running_transition.terminal_resume"] = and([
  sessionApplied("running_transition"),
  ({ event }: { event: SessionDecisionEvent }) =>
    event.facts.resume === "terminal_match",
]);

for (const command of SESSION_COMMANDS) {
  verdict[command] = [
    ...orderedGuards(command).map(({ kind, entry }) =>
      decision(command, kind, entry.reason, entry.guard),
    ),
    ...(command === "execution_registration"
      || command === "running_transition"
      ? [
        decision(
          command,
          "apply",
          "terminal_resume",
          `apply.${command}.terminal_resume`,
        ),
        decision(
          command,
          "apply",
          "active_registration",
          sessionApplied(command),
        ),
      ]
      : [
        decision(
          command,
          "apply",
          APPLY_REASONS[command] ?? "applied",
          sessionApplied(command),
        ),
      ]),
  ];
}

const actions = Object.fromEntries(
  ["apply", "noop", "reject", "write"].map((name) => [name, () => {}]),
);

/** 배우를 만들지 않는다. transition()이 기호 액션만 돌려준다. */
export const sessionDecisionMachine = setup({
  types: { events: {} as SessionDecisionEvent },
  guards: sessionDecisionGuards,
  actions,
}).createMachine({
  id: "sessionState",
  type: "parallel",
  description: "세션 줄과 한도 재개 예약의 판정과 쓰기를 정한다",
  states: {
    status: {
      id: "sessionStatus",
      description: "세션 상태",
      initial: "none",
      on: sessionEffects.status,
      states: {
        none: leaf("s_none", "세션 줄이 없음"),
        initializing: leaf("s_initializing", "초기화 중"),
        running: leaf("s_running", "실행 중"),
        completed: leaf("s_completed", "완료"),
        error: leaf("s_error", "오류"),
        interrupted: leaf("s_interrupted", "중단"),
      },
    },
    termination: {
      id: "sessionTermination",
      description: "종료 리비전 기록",
      initial: "none",
      on: sessionEffects.termination,
      states: {
        none: leaf("t_none", "종료 기록 없음"),
        recorded: leaf("t_recorded", "종료 리비전 기록 있음"),
      },
    },
    review: {
      id: "sessionReview",
      description: "검수 상태",
      initial: "not_required",
      on: sessionEffects.review,
      states: {
        not_required: leaf("r_not_required", "검수 불필요"),
        needs_review: leaf("r_needs_review", "검수 대기"),
        acknowledged: leaf("r_acknowledged", "검수 확인"),
      },
    },
    reservation: {
      id: "sessionReservation",
      description: "한도 재개 예약",
      initial: "none",
      on: sessionEffects.reservation,
      states: {
        none: leaf("res_none", "예약 없음"),
        reserved: leaf("res_reserved", "예약 있음"),
      },
    },
    verdict: {
      id: "sessionVerdict",
      description: "명령 판정",
      initial: "ready",
      states: {
        ready: { id: "sessionVerdictReady", description: "판정 준비", on: verdict },
      },
    },
  },
});

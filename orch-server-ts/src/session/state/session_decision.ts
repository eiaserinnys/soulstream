import { transition } from "xstate";

import {
  deriveSessionFacts,
  type FiniteFacts,
  type SessionCommand,
} from "./session_decision_facts.js";
import { sessionDecisionMachine } from "./session_decision_machine.js";
import type { SessionStateValue } from "./session_state_value.js";

export interface SessionDecisionAction {
  type: string;
  params?: {
    reason?: string;
    region?: string;
    command?: string;
  };
}

export interface SessionDecision {
  kind: "apply" | "noop" | "reject";
  next: SessionStateValue;
  reason: string;
  actions: SessionDecisionAction[];
}

/**
 * 저장 상태 값과 명령, 사실을 한 번의 전이로 넘긴다. 마지막 판정 액션 하나가
 * 적용, 무시, 거절을 가르며, 같은 전이에서 나온 영역 쓰기 액션은 기호일 뿐
 * 실행되지 않는다.
 */
export function decideSessionTransition(
  value: SessionStateValue,
  command: SessionCommand,
  facts: FiniteFacts = {},
): SessionDecision {
  const merged = { ...deriveSessionFacts(command), ...facts };
  const snapshot = sessionDecisionMachine.resolveState({
    value: value as any,
    context: {},
  });
  const [next, actions] = transition(sessionDecisionMachine, snapshot, {
    type: command.type,
    command,
    facts: merged,
  });
  const selected = actions as SessionDecisionAction[];
  const verdict = selected.find((action) =>
    action.type === "apply" || action.type === "noop" || action.type === "reject"
  );
  if (!verdict) {
    throw new Error(
      `판정 액션이 없다: ${command.type} ${JSON.stringify(value)}`,
    );
  }
  return {
    kind: verdict.type as SessionDecision["kind"],
    next: next.value as SessionStateValue,
    reason: String(verdict.params?.reason ?? verdict.type),
    actions: selected,
  };
}

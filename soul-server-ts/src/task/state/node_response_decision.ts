import { transition } from "xstate";

import {
  nodeResponseMachine,
  type NodeResponseCall,
  type NodeResponseCell,
  type NodeResponseFacts,
  type NodeWireReason,
} from "./node_response_machine.js";

/** 칸이 하는 정리의 의도다. 이 배열의 순서가 출력 순서다. */
export const NODE_CLEANUP_INTENTS = [
  "retry_later",
  "resubmit_same_termination",
  "abandon_attempt",
  "mark_central_error",
  "reap_runner",
  "close_settlement_pending",
  "retire_rejected_registration",
  "release_local_ownership",
] as const;
export type NodeCleanupIntent = (typeof NODE_CLEANUP_INTENTS)[number];

export type NodeResponseDecision =
  | { cell: "applied"; reason: null; intents: [] }
  | {
    cell: Exclude<NodeResponseCell, "applied">;
    /** 다시 될 까닭이 없는 거절의 사유다. 다른 칸은 null이다. */
    reason: NodeWireReason | null;
    intents: NodeCleanupIntent[];
  };

/** 러너를 들고 응답을 기다리는 호출이다. 거절되면 그 러너의 거둠이 문제가 된다. */
const RUNNER_BEARING_CALLS: readonly NodeResponseCall[] = [
  "execution_registration",
  "startup_recovery_adopt",
  "attached_runner_adopt",
];

/** 잇기 호출이다. 점유 거절의 오류 종료는 이 둘에만 건다. */
const ADOPT_CALLS: readonly NodeResponseCall[] = [
  "startup_recovery_adopt",
  "attached_runner_adopt",
];

/** 응답을 받은 칸을 기계 정의에서 낸다. 칸이 없으면 빈 칸이므로 던진다. */
export function decideNodeResponseCell(facts: NodeResponseFacts): NodeResponseCell {
  const snapshot = nodeResponseMachine.resolveState({
    value: "decide",
    context: {},
  });
  const [next] = transition(nodeResponseMachine, snapshot, {
    type: "RESPOND",
    ...facts,
  });
  if (next.value === "decide") {
    throw new Error(`node response cell missing: ${JSON.stringify(facts)}`);
  }
  return next.value as NodeResponseCell;
}

/**
 * 거절의 사유다. 종료 거절에 사유가 없고 다른 종료가 이미 있으면 already_terminal로 친다.
 */
function noRetryReason(facts: NodeResponseFacts): NodeWireReason {
  if (facts.reason === "none") return "already_terminal";
  return facts.reason;
}

function cleanupIntents(
  cell: Exclude<NodeResponseCell, "applied">,
  facts: NodeResponseFacts,
): NodeCleanupIntent[] {
  const intents = new Set<NodeCleanupIntent>();
  const termination = facts.call === "termination";
  const runnerBearing = RUNNER_BEARING_CALLS.includes(facts.call);
  const stale = facts.registration === "different";

  if (cell === "retryable") {
    intents.add(termination ? "resubmit_same_termination" : "retry_later");
  } else if (termination) {
    // 같은 종료를 다시 올리는 의도는 내지 않는다.
    intents.add("close_settlement_pending");
    intents.add("retire_rejected_registration");
  } else {
    if (
      (cell === "permanent" || cell === "quarantine")
      && facts.reason !== "owner_node_changed"
      && !stale
    ) {
      // 거절된 그 등록과 그 실행 명령에만 거는 정리다.
      intents.add("mark_central_error");
    }
    if (
      cell === "no_retry"
      && facts.reason === "worktree_busy"
      && ADOPT_CALLS.includes(facts.call)
      && facts.centralSession === "present"
      && facts.termination === "absent"
      && !stale
    ) {
      // 다른 세션이 워크트리를 쥐어 잇지 못한 세션은 오류 종료로 닫는다(M:408-412). orch는 기록된
      // 끝남보다 점유를 먼저 보므로, 중앙 세션 줄에 끝남이 기록돼 있으면(termination: different)
      // 종료를 다시 올리지 않고 러너만 거둔다(M:406-407). 중앙 줄을 읽기 전에는 올리지 않는다.
      intents.add("mark_central_error");
    }
    if (runnerBearing) {
      if (!facts.retained && !stale) intents.add("reap_runner");
    } else {
      intents.add("abandon_attempt");
    }
  }
  if (facts.centralSession === "absent") {
    // 중앙 세션 없음이 확인되면 어느 칸이든 로컬 소유를 정리한다.
    // 받아 줄 세션이 없으므로 다시 시도하는 의도는 함께 내지 않는다.
    // 종료는 같은 종료를 다시 올리지 않는 대신 완료 정산 미결을 닫는다.
    intents.delete("retry_later");
    intents.delete("resubmit_same_termination");
    if (termination) intents.add("close_settlement_pending");
    intents.add("release_local_ownership");
  }
  return NODE_CLEANUP_INTENTS.filter((intent) => intents.has(intent));
}

/** 응답을 받은 칸과 그 칸이 할 정리의 의도를 낸다. */
export function decideNodeResponse(facts: NodeResponseFacts): NodeResponseDecision {
  const cell = decideNodeResponseCell(facts);
  if (cell === "applied") return { cell, reason: null, intents: [] };
  return {
    cell,
    reason: cell === "no_retry" ? noRetryReason(facts) : null,
    intents: cleanupIntents(cell, facts),
  };
}

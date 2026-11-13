import { transition } from "xstate";

import type { NodeExecutionPhase } from "./node_execution_machine.js";
import {
  NODE_REQUEST_EVENTS,
  nodeRequestMachine,
  type NodeRequestDisposition,
  type NodeRequestKind,
} from "./node_request_machine.js";

interface VerdictAction {
  type: "verdict";
  params: { disposition: NodeRequestDisposition };
}

/** 실행 상태에 바깥 요청이 왔을 때의 처분을 기계 정의에서 낸다. 처분이 없으면 던진다. */
export function decideNodeRequest(
  phase: NodeExecutionPhase,
  request: NodeRequestKind,
): NodeRequestDisposition {
  const snapshot = nodeRequestMachine.resolveState({ value: phase, context: {} });
  const [, actions] = transition(nodeRequestMachine, snapshot, {
    type: NODE_REQUEST_EVENTS[request],
  });
  const verdict = (actions as { type: string; params?: unknown }[]).find(
    (action) => action.type === "verdict",
  ) as VerdictAction | undefined;
  if (verdict === undefined) {
    throw new Error(`node request disposition missing: ${phase}/${request}`);
  }
  return verdict.params.disposition;
}

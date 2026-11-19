import type { NodeExecutionPhase } from "./node_execution_machine.js";
import {
  NODE_REQUEST_TABLE,
  type NodeRequestDisposition,
  type NodeRequestKind,
} from "./node_request_machine.js";

/** 실행 상태에 바깥 요청이 왔을 때의 처분을 표에서 낸다. 처분이 없으면 던진다. */
export function decideNodeRequest(
  phase: NodeExecutionPhase,
  request: NodeRequestKind,
): NodeRequestDisposition {
  const disposition = NODE_REQUEST_TABLE[phase]?.[request]?.disposition;
  if (disposition === undefined) {
    throw new Error(`node request disposition missing: ${phase}/${request}`);
  }
  return disposition;
}

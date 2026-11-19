import type { NodeExecutionPhase } from "./node_execution_machine.js";
import {
  NODE_REQUEST_TABLE,
  type NodeRequestDisposition,
  type NodeRequestKind,
} from "./node_request_machine.js";

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

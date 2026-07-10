export const ORCH_BOARD_YJS_HOST_NODE_ID = "orch";

export function isBoardYjsHostNode(nodeId: string, hostNodeId: string): boolean {
  return hostNodeId !== ORCH_BOARD_YJS_HOST_NODE_ID && nodeId === hostNodeId;
}

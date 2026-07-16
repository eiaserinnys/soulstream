import { useMemo } from "react";

import { useOrchestratorStore } from "../store/orchestrator-store";
import type { SessionNodeConnectivity } from "./session-node-connectivity";

export function useSessionNodeConnectivity(): {
  nodes: ReturnType<typeof useOrchestratorStore.getState>["nodes"];
  nodeConnectivity: SessionNodeConnectivity;
} {
  const nodes = useOrchestratorStore((state) => state.nodes);
  const connectionStatus = useOrchestratorStore((state) => state.connectionStatus);
  const nodeConnectivity = useMemo(() => ({
    ready: connectionStatus === "connected",
    connectedNodeIds: new Set(nodes.keys()),
  }), [connectionStatus, nodes]);
  return { nodes, nodeConnectivity };
}

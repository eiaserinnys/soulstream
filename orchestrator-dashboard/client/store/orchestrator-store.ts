/**
 * Zustand 스토어 -- 노드 상태 관리.
 *
 * 세션 데이터는 soul-ui의 useDashboardStore가 관리한다.
 * 이 스토어는 orchestrator 고유의 노드 상태만 담당한다.
 */

import { create } from "zustand";

/** Orchestrator 노드 정보 */
export interface OrchestratorNode {
  nodeId: string;
  host: string;
  port: number;
  status: "connected" | "disconnected";
  capabilities: Record<string, unknown>;
  connectedAt: number;
  sessionCount: number;
}

/** SSE로 수신하는 노드 변경 이벤트 */
export interface NodeChangeSSE {
  type: "node_connected" | "node_disconnected" | "node_updated";
  node: OrchestratorNode;
}

export interface OrchestratorState {
  nodes: Map<string, OrchestratorNode>;
  connectionStatus: "connecting" | "connected" | "error";
}

export interface OrchestratorActions {
  setNode(node: OrchestratorNode): void;
  removeNode(nodeId: string): void;
  setNodes(nodes: OrchestratorNode[]): void;
  setConnectionStatus(status: OrchestratorState["connectionStatus"]): void;
}

export const useOrchestratorStore = create<
  OrchestratorState & OrchestratorActions
>((set) => ({
  nodes: new Map(),
  connectionStatus: "connecting",

  setNode: (node) =>
    set((state) => {
      const next = new Map(state.nodes);
      next.set(node.nodeId, node);
      return { nodes: next };
    }),

  removeNode: (nodeId) =>
    set((state) => {
      const nextNodes = new Map(state.nodes);
      nextNodes.delete(nodeId);
      return { nodes: nextNodes };
    }),

  setNodes: (nodes) =>
    set(() => {
      const map = new Map<string, OrchestratorNode>();
      for (const n of nodes) map.set(n.nodeId, n);
      return { nodes: map };
    }),

  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
}));

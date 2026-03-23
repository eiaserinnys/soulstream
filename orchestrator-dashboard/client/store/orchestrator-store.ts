/**
 * Zustand 스토어 — 노드/세션 상태 + 선택 관리.
 */

import { create } from "zustand";
import type { OrchestratorNode, OrchestratorSession } from "./types";

export interface OrchestratorState {
  // 노드 데이터
  nodes: Map<string, OrchestratorNode>;
  // 노드별 세션 데이터
  sessions: Map<string, OrchestratorSession[]>;

  // UI 선택 상태
  selectedNodeId: string | null;
  selectedSessionId: string | null;

  // 연결 상태
  connectionStatus: "connecting" | "connected" | "error";
}

export interface OrchestratorActions {
  // 노드 CRUD
  setNode(node: OrchestratorNode): void;
  removeNode(nodeId: string): void;
  setNodes(nodes: OrchestratorNode[]): void;

  // 세션 업데이트
  setNodeSessions(nodeId: string, sessions: OrchestratorSession[]): void;

  // 선택
  selectNode(nodeId: string | null): void;
  selectSession(nodeId: string, sessionId: string): void;
  clearSelection(): void;

  // 연결 상태
  setConnectionStatus(status: OrchestratorState["connectionStatus"]): void;
}

export const useOrchestratorStore = create<
  OrchestratorState & OrchestratorActions
>((set) => ({
  nodes: new Map(),
  sessions: new Map(),
  selectedNodeId: null,
  selectedSessionId: null,
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
      const nextSessions = new Map(state.sessions);
      nextSessions.delete(nodeId);
      // 선택된 노드가 제거된 경우 해제
      const selectedNodeId =
        state.selectedNodeId === nodeId ? null : state.selectedNodeId;
      const selectedSessionId =
        state.selectedNodeId === nodeId ? null : state.selectedSessionId;
      return {
        nodes: nextNodes,
        sessions: nextSessions,
        selectedNodeId,
        selectedSessionId,
      };
    }),

  setNodes: (nodes) =>
    set(() => {
      const map = new Map<string, OrchestratorNode>();
      for (const n of nodes) map.set(n.nodeId, n);
      return { nodes: map };
    }),

  setNodeSessions: (nodeId, sessions) =>
    set((state) => {
      const next = new Map(state.sessions);
      next.set(nodeId, sessions);
      // 노드의 sessionCount도 업데이트
      const nextNodes = new Map(state.nodes);
      const node = nextNodes.get(nodeId);
      if (node) {
        nextNodes.set(nodeId, { ...node, sessionCount: sessions.length });
      }
      return { sessions: next, nodes: nextNodes };
    }),

  selectNode: (nodeId) =>
    set({ selectedNodeId: nodeId, selectedSessionId: null }),

  selectSession: (nodeId, sessionId) =>
    set({ selectedNodeId: nodeId, selectedSessionId: sessionId }),

  clearSelection: () =>
    set({ selectedNodeId: null, selectedSessionId: null }),

  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
}));

/** 전체 세션 수 */
export function totalSessionCount(sessions: Map<string, OrchestratorSession[]>): number {
  let count = 0;
  for (const list of sessions.values()) count += list.length;
  return count;
}

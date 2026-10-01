import { create } from 'zustand';
import { captureAuthScope, subscribeAuthScope } from '../lib/auth-scope';
import { normalizeNodeId } from '../lib/session-node-projection';

interface NodeConnectivityStore {
  scopeGeneration: string;
  ready: boolean;
  connectedNodeIds: ReadonlySet<string>;
  applySnapshot: (nodes: unknown) => void;
  upsert: (node: unknown) => void;
  remove: (payload: unknown) => void;
  markNotReady: () => void;
  reset: (scopeGeneration?: string) => void;
}

function nodeIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  return normalizeNodeId((payload as { nodeId?: unknown }).nodeId);
}

function initialState(scopeGeneration = captureAuthScope().generation) {
  return {
    scopeGeneration,
    ready: false,
    connectedNodeIds: new Set<string>() as ReadonlySet<string>,
  };
}

export const useNodeConnectivityStore = create<NodeConnectivityStore>((set) => ({
  ...initialState(),
  applySnapshot: (nodes) => set((state) => {
    if (!Array.isArray(nodes)) return state;
    const connectedNodeIds = new Set<string>();
    for (const node of nodes) {
      const nodeId = nodeIdFromPayload(node);
      if (nodeId) connectedNodeIds.add(nodeId);
    }
    return { ...state, ready: true, connectedNodeIds };
  }),
  upsert: (node) => set((state) => {
    if (!state.ready) return state;
    const nodeId = nodeIdFromPayload(node);
    if (!nodeId || state.connectedNodeIds.has(nodeId)) return state;
    return {
      ...state,
      connectedNodeIds: new Set([...state.connectedNodeIds, nodeId]),
    };
  }),
  remove: (payload) => set((state) => {
    if (!state.ready) return state;
    const nodeId = nodeIdFromPayload(payload);
    if (!nodeId || !state.connectedNodeIds.has(nodeId)) return state;
    const connectedNodeIds = new Set(state.connectedNodeIds);
    connectedNodeIds.delete(nodeId);
    return { ...state, connectedNodeIds };
  }),
  markNotReady: () => set((state) => (
    state.ready ? { ...state, ready: false } : state
  )),
  reset: (scopeGeneration = captureAuthScope().generation) => set({
    ...initialState(scopeGeneration),
  }),
}));

subscribeAuthScope((scope) => {
  useNodeConnectivityStore.getState().reset(scope.generation);
});

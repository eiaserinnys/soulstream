import { createContext, useContext, type PropsWithChildren } from "react";
import { useStore } from "zustand";
import { flattenTree } from "../lib/flatten-tree";
import {
  useDashboardStore,
  type ChatSessionStoreScope,
  type DashboardActions,
  type DashboardState,
} from "./dashboard-store";
import type { StoreApi } from "zustand/vanilla";

type ChatStore = DashboardState & DashboardActions;

const ChatStoreScopeContext = createContext<ChatSessionStoreScope | null>(null);

export function ChatStoreScopeProvider({
  scope,
  children,
}: PropsWithChildren<{ scope: ChatSessionStoreScope }>) {
  return (
    <ChatStoreScopeContext.Provider value={scope}>
      {children}
    </ChatStoreScopeContext.Provider>
  );
}

export function useChatStore<T>(selector: (state: ChatStore) => T): T {
  const scope = useContext(ChatStoreScopeContext);
  return useStore(scope?.store ?? useDashboardStore, selector);
}

export function useChatStoreApi(): StoreApi<ChatStore> {
  const scope = useContext(ChatStoreScopeContext);
  return scope?.store ?? useDashboardStore;
}

export function useChatFlattenTree(): ChatSessionStoreScope["flattenTree"] {
  const scope = useContext(ChatStoreScopeContext);
  return scope?.flattenTree ?? flattenTree;
}

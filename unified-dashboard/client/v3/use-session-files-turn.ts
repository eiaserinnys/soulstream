import { useEffect, useState } from "react";
import { useDashboardStore, type ChatSessionStoreScope } from "@seosoyoung/soul-ui";
import type { EventTreeNode } from "@seosoyoung/soul-ui/shared/tree-nodes";

function latestComplete(node: EventTreeNode | null): string | null {
  if (!node) return null;
  for (let i = node.children.length - 1; i >= 0; i--) {
    const found = latestComplete(node.children[i]);
    if (found) return found;
  }
  return node.type === "complete" ? node.id : null;
}
export function useSessionFilesTurn(sessionId: string, scope?: ChatSessionStoreScope) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const store = scope?.store ?? useDashboardStore;
    const current = () => {
      const state = store.getState();
      return state.activeSessionKey === sessionId ? latestComplete(state.tree) : null;
    };
    let previous = current();
    return store.subscribe(() => {
      const next = current();
      if (next && next !== previous) setRevision(value => value + 1);
      previous = next;
    });
  }, [sessionId, scope]);
  return revision;
}

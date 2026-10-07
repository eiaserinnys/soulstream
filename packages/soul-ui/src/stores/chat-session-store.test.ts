import { beforeEach, describe, expect, it } from "vitest";
import { createChatSessionStore, useDashboardStore } from "./dashboard-store";
import type { PendingChatSend } from "./dashboard-store-types";
import { flattenTree } from "../lib/flatten-tree";
import type { EventTreeNode, SoulSSEEvent } from "@shared/types";

const pending: PendingChatSend = {
  id: "pending-assigned",
  status: "sending",
  text: "담당 세션 메시지",
  messageText: "담당 세션 메시지",
  attachmentPaths: [],
  attachments: [],
  mode: "intervention",
};

function treeWithMessage(text: string): EventTreeNode {
  return {
    type: "session",
    id: "shared-node-id",
    content: "",
    completed: false,
    children: [{
      type: "user_message",
      id: "shared-message-id",
      content: text,
      completed: true,
      user: "director",
      children: [],
    }],
  } as EventTreeNode;
}

describe("createChatSessionStore", () => {
  beforeEach(() => {
    useDashboardStore.getState().reset();
    useDashboardStore.getState().setActiveSession("pas-session");
  });

  it("keeps assigned-session chat state and tree identity separate from PAS", () => {
    const scope = createChatSessionStore("assigned-session");

    expect(scope.store.getState().activeSessionKey).toBe("assigned-session");
    scope.store.getState().setFocusEventId(42);
    scope.store.setState({ tree: treeWithMessage("담당 세션 대화") });

    expect(scope.store.getState().focusEventSessionId).toBe("assigned-session");
    expect(useDashboardStore.getState().activeSessionKey).toBe("pas-session");
    expect(useDashboardStore.getState().focusEventId).toBeNull();
    expect(useDashboardStore.getState().tree).toBeNull();
  });

  it("supports an unassigned card without selecting a session in either store", () => {
    const scope = createChatSessionStore(null);

    expect(scope.store.getState().activeSessionKey).toBeNull();
    expect(useDashboardStore.getState().activeSessionKey).toBe("pas-session");
  });

  it("uses an instance-local flatten cache for colliding event ids", () => {
    const scope = createChatSessionStore("assigned-session");
    const pasMessage = flattenTree(treeWithMessage("PAS"))[0];

    scope.flattenTree(treeWithMessage("담당 세션"));

    expect(flattenTree(treeWithMessage("PAS"))[0]).toBe(pasMessage);
  });

  it("clears only the matching session-keyed composer pending cell on its event echo", () => {
    const scope = createChatSessionStore("assigned-session");
    useDashboardStore.getState().setPendingChatSend("pas-session", {
      ...pending,
      id: "pending-pas",
      messageText: "PAS 메시지",
    });
    useDashboardStore.getState().setPendingChatSend("assigned-session", pending);

    scope.store.getState().processEvent({
      type: "user_message",
      user: "director",
      text: "담당 세션 메시지",
      timestamp: 1_790_000_000,
    } as unknown as SoulSSEEvent, 10);

    expect(useDashboardStore.getState().pendingChatSends["assigned-session"]).toBeUndefined();
    expect(useDashboardStore.getState().pendingChatSends["pas-session"]?.id).toBe("pending-pas");
    expect(scope.store.getState().tree?.children[0]).toMatchObject({
      type: "user_message",
      content: "담당 세션 메시지",
    });
    expect(useDashboardStore.getState().tree).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import {
  resolveSessionIntentTabPress,
  revealAttentionDetail,
  reduceMobilePlannerEscape,
  selectMobilePlannerTab,
  shouldApplyRememberedChatTab,
  type MobilePlannerState,
  type MobilePlannerFolderOption,
} from "./mobile-planner-state";

describe("session intent tab press", () => {
  it("defers a chat tab press while the session intent is still being read", () => {
    expect(resolveSessionIntentTabPress("chat", true)).toEqual({
      deferChatTab: true,
      rememberChatTab: true,
      forgetChatTab: false,
    });
  });

  it("opens other tabs and forgets the chat tab press while the intent is pending", () => {
    for (const target of ["today", "projects", "task"] as const) {
      expect(resolveSessionIntentTabPress(target, true)).toEqual({
        deferChatTab: false,
        rememberChatTab: false,
        forgetChatTab: true,
      });
    }
  });

  it("leaves a chat tab press after the intent finished to the existing rule", () => {
    expect(resolveSessionIntentTabPress("chat", false)).toEqual({
      deferChatTab: false,
      rememberChatTab: false,
      forgetChatTab: true,
    });
  });

  it("moves to chat only when the open succeeded on mobile with a remembered press", () => {
    expect(shouldApplyRememberedChatTab({ opened: true, mobileMode: true, remembered: true })).toBe(true);
    expect(shouldApplyRememberedChatTab({ opened: false, mobileMode: true, remembered: true })).toBe(false);
    expect(shouldApplyRememberedChatTab({ opened: true, mobileMode: false, remembered: true })).toBe(false);
    expect(shouldApplyRememberedChatTab({ opened: true, mobileMode: true, remembered: false })).toBe(false);
  });
});

const tasks: MobilePlannerFolderOption[] = [
  {
    folderId: "task-a",
    runIds: ["run-2", "delegate-2a", "run-1"],
    latestRunId: "run-2",
  },
  {
    folderId: "task-b",
    runIds: [],
    latestRunId: null,
  },
];

describe("mobile planner tab selection", () => {
  it("opens the project list without inventing a task workspace", () => {
    expect(selectMobilePlannerTab(state({
      selectedFolderId: "task-a",
      selectedRunId: "run-2",
    }), "projects", tasks)).toEqual({
      activeTab: "projects",
      selectedFolderId: "task-a",
      selectedRunId: "run-2",
      workspaceOpen: false,
      chatOpen: false,
    });
  });

  it("selects the first task when the task tab opens without a current task", () => {
    expect(selectMobilePlannerTab(state(), "task", tasks)).toEqual({
      activeTab: "task",
      selectedFolderId: "task-a",
      selectedRunId: null,
      workspaceOpen: true,
      chatOpen: false,
    });
  });

  it("selects the latest run when the chat tab opens without a run", () => {
    expect(selectMobilePlannerTab(state({ selectedFolderId: "task-a" }), "chat", tasks)).toEqual({
      activeTab: "chat",
      selectedFolderId: "task-a",
      selectedRunId: "run-2",
      workspaceOpen: true,
      chatOpen: true,
    });
  });

  it("preserves the current task and run when returning to today", () => {
    expect(selectMobilePlannerTab(state({
      activeTab: "chat",
      selectedFolderId: "task-a",
      selectedRunId: "delegate-2a",
      workspaceOpen: true,
      chatOpen: true,
    }), "today", tasks)).toEqual({
      activeTab: "today",
      selectedFolderId: "task-a",
      selectedRunId: "delegate-2a",
      workspaceOpen: false,
      chatOpen: false,
    });
  });

  it("moves Escape from mobile chat to the task tab without clearing selection", () => {
    expect(reduceMobilePlannerEscape(state({
      activeTab: "chat",
      selectedFolderId: "task-a",
      selectedRunId: "run-2",
      workspaceOpen: true,
      chatOpen: true,
    }))).toEqual({
      activeTab: "task",
      selectedFolderId: "task-a",
      selectedRunId: "run-2",
      workspaceOpen: true,
      chatOpen: false,
    });
  });

  it("reveals a detail-required attention on the mobile chat surface without changing its run", () => {
    expect(revealAttentionDetail(state({
      activeTab: "today",
      selectedFolderId: null,
      selectedRunId: "standalone-run",
    }), true)).toEqual({
      activeTab: "chat",
      selectedFolderId: null,
      selectedRunId: "standalone-run",
      workspaceOpen: true,
      chatOpen: true,
    });
  });
});

function state(overrides: Partial<MobilePlannerState> = {}): MobilePlannerState {
  return {
    activeTab: "today",
    selectedFolderId: null,
    selectedRunId: null,
    workspaceOpen: false,
    chatOpen: false,
    ...overrides,
  };
}

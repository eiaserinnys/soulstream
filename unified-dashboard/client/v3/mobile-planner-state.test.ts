import { describe, expect, it } from "vitest";

import {
  revealAttentionDetail,
  reduceMobilePlannerEscape,
  selectMobilePlannerTab,
  type MobilePlannerState,
  type MobilePlannerTaskOption,
} from "./mobile-planner-state";

const tasks: MobilePlannerTaskOption[] = [
  {
    taskId: "task-a",
    runIds: ["run-2", "delegate-2a", "run-1"],
    latestRunId: "run-2",
  },
  {
    taskId: "task-b",
    runIds: [],
    latestRunId: null,
  },
];

describe("mobile planner tab selection", () => {
  it("opens the project list without inventing a task workspace", () => {
    expect(selectMobilePlannerTab(state({
      selectedTaskId: "task-a",
      selectedRunId: "run-2",
    }), "projects", tasks)).toEqual({
      activeTab: "projects",
      selectedTaskId: "task-a",
      selectedRunId: "run-2",
      workspaceOpen: false,
      chatOpen: false,
    });
  });

  it("selects the first task when the task tab opens without a current task", () => {
    expect(selectMobilePlannerTab(state(), "task", tasks)).toEqual({
      activeTab: "task",
      selectedTaskId: "task-a",
      selectedRunId: null,
      workspaceOpen: true,
      chatOpen: false,
    });
  });

  it("selects the latest run when the chat tab opens without a run", () => {
    expect(selectMobilePlannerTab(state({ selectedTaskId: "task-a" }), "chat", tasks)).toEqual({
      activeTab: "chat",
      selectedTaskId: "task-a",
      selectedRunId: "run-2",
      workspaceOpen: true,
      chatOpen: true,
    });
  });

  it("preserves the current task and run when returning to today", () => {
    expect(selectMobilePlannerTab(state({
      activeTab: "chat",
      selectedTaskId: "task-a",
      selectedRunId: "delegate-2a",
      workspaceOpen: true,
      chatOpen: true,
    }), "today", tasks)).toEqual({
      activeTab: "today",
      selectedTaskId: "task-a",
      selectedRunId: "delegate-2a",
      workspaceOpen: false,
      chatOpen: false,
    });
  });

  it("moves Escape from mobile chat to the task tab without clearing selection", () => {
    expect(reduceMobilePlannerEscape(state({
      activeTab: "chat",
      selectedTaskId: "task-a",
      selectedRunId: "run-2",
      workspaceOpen: true,
      chatOpen: true,
    }))).toEqual({
      activeTab: "task",
      selectedTaskId: "task-a",
      selectedRunId: "run-2",
      workspaceOpen: true,
      chatOpen: false,
    });
  });

  it("reveals a detail-required attention on the mobile chat surface without changing its run", () => {
    expect(revealAttentionDetail(state({
      activeTab: "today",
      selectedTaskId: null,
      selectedRunId: "standalone-run",
    }), true)).toEqual({
      activeTab: "chat",
      selectedTaskId: null,
      selectedRunId: "standalone-run",
      workspaceOpen: true,
      chatOpen: true,
    });
  });
});

function state(overrides: Partial<MobilePlannerState> = {}): MobilePlannerState {
  return {
    activeTab: "today",
    selectedTaskId: null,
    selectedRunId: null,
    workspaceOpen: false,
    chatOpen: false,
    ...overrides,
  };
}

export type MobilePlannerTab = "today" | "task" | "chat";

export interface MobilePlannerState {
  activeTab: MobilePlannerTab;
  selectedTaskId: string | null;
  selectedRunId: string | null;
  workspaceOpen: boolean;
  chatOpen: boolean;
}

export interface MobilePlannerTaskOption {
  taskId: string;
  runIds: readonly string[];
  latestRunId: string | null;
}

export function selectMobilePlannerTab(
  state: MobilePlannerState,
  target: MobilePlannerTab,
  tasks: readonly MobilePlannerTaskOption[],
): MobilePlannerState {
  if (target === "today") {
    return {
      ...state,
      activeTab: "today",
      workspaceOpen: false,
      chatOpen: false,
    };
  }

  const selectedTask = tasks.find((task) => task.taskId === state.selectedTaskId) ?? tasks[0] ?? null;
  if (!selectedTask) {
    return {
      ...state,
      activeTab: "today",
      selectedTaskId: null,
      selectedRunId: null,
      workspaceOpen: false,
      chatOpen: false,
    };
  }

  const taskChanged = selectedTask.taskId !== state.selectedTaskId;
  const selectedRunId = taskChanged || !selectedTask.runIds.includes(state.selectedRunId ?? "")
    ? null
    : state.selectedRunId;
  return {
    activeTab: target,
    selectedTaskId: selectedTask.taskId,
    selectedRunId: target === "chat" ? selectedRunId ?? selectedTask.latestRunId : selectedRunId,
    workspaceOpen: true,
    chatOpen: target === "chat",
  };
}

export function reduceMobilePlannerEscape(state: MobilePlannerState): MobilePlannerState {
  if (state.activeTab === "chat" && state.chatOpen) {
    return {
      ...state,
      activeTab: "task",
      workspaceOpen: true,
      chatOpen: false,
    };
  }
  if (state.activeTab === "task" && state.workspaceOpen) {
    return {
      ...state,
      activeTab: "today",
      workspaceOpen: false,
      chatOpen: false,
    };
  }
  return state;
}

export type MobilePlannerTab = "today" | "projects" | "task" | "chat";

export interface MobilePlannerState {
  activeTab: MobilePlannerTab;
  selectedFolderId: string | null;
  selectedRunId: string | null;
  workspaceOpen: boolean;
  chatOpen: boolean;
}

export interface MobilePlannerFolderOption {
  folderId: string;
  runIds: readonly string[];
  latestRunId: string | null;
}

export function selectMobilePlannerTab(
  state: MobilePlannerState,
  target: MobilePlannerTab,
  tasks: readonly MobilePlannerFolderOption[],
): MobilePlannerState {
  if (target === "today") {
    return {
      ...state,
      activeTab: "today",
      workspaceOpen: false,
      chatOpen: false,
    };
  }

  if (target === "projects") {
    return {
      ...state,
      activeTab: "projects",
      workspaceOpen: false,
      chatOpen: false,
    };
  }

  const selectedTask = tasks.find((task) => task.folderId === state.selectedFolderId) ?? tasks[0] ?? null;
  if (!selectedTask) {
    return {
      ...state,
      activeTab: "today",
      selectedFolderId: null,
      selectedRunId: null,
      workspaceOpen: false,
      chatOpen: false,
    };
  }

  const taskChanged = selectedTask.folderId !== state.selectedFolderId;
  const selectedRunId = taskChanged || !selectedTask.runIds.includes(state.selectedRunId ?? "")
    ? null
    : state.selectedRunId;
  return {
    activeTab: target,
    selectedFolderId: selectedTask.folderId,
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

/** Opens the detail chat without changing the attention's selected run. */
export function revealAttentionDetail(
  state: MobilePlannerState,
  mobileMode: boolean,
): MobilePlannerState {
  return {
    ...state,
    activeTab: mobileMode ? "chat" : state.activeTab,
    workspaceOpen: true,
    chatOpen: true,
  };
}

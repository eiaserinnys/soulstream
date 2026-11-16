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

  const selectedFolderEntry = tasks.find((task) => task.folderId === state.selectedFolderId) ?? tasks[0] ?? null;
  if (!selectedFolderEntry) {
    return {
      ...state,
      activeTab: "today",
      selectedFolderId: null,
      selectedRunId: null,
      workspaceOpen: false,
      chatOpen: false,
    };
  }

  const folderChanged = selectedFolderEntry.folderId !== state.selectedFolderId;
  const selectedRunId = folderChanged || !selectedFolderEntry.runIds.includes(state.selectedRunId ?? "")
    ? null
    : state.selectedRunId;
  return {
    activeTab: target,
    selectedFolderId: selectedFolderEntry.folderId,
    selectedRunId: target === "chat" ? selectedRunId ?? selectedFolderEntry.latestRunId : selectedRunId,
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

/**
 * `?session=` 지정을 아직 읽는 중인가에 따른 모바일 탭 누름의 처리.
 * 지정이 끝나기 전의 채팅 탭은 폴더와 실행을 새로 고르지 않고 누른 사실만 기억한다.
 * 처리 중 다른 탭을 누르면 기억을 버리고 그 탭은 지금처럼 연다.
 */
export function resolveSessionIntentTabPress(
  target: MobilePlannerTab,
  sessionIntentPending: boolean,
): { deferChatTab: boolean; rememberChatTab: boolean; forgetChatTab: boolean } {
  if (!sessionIntentPending) {
    return { deferChatTab: false, rememberChatTab: false, forgetChatTab: true };
  }
  if (target === "chat") {
    return { deferChatTab: true, rememberChatTab: true, forgetChatTab: false };
  }
  return { deferChatTab: false, rememberChatTab: false, forgetChatTab: true };
}

/** 지정 열기가 성공한 뒤, 처리 중에 누른 채팅 탭을 그대로 적용할지. */
export function shouldApplyRememberedChatTab(input: {
  opened: boolean;
  mobileMode: boolean;
  remembered: boolean;
}): boolean {
  return input.opened && input.mobileMode && input.remembered;
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

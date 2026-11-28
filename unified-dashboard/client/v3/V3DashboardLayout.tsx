import { useTranslation } from "react-i18next";
import {flushSync} from "react-dom";
import {useQueryClient} from "@tanstack/react-query";
import {useCardStore} from "@seosoyoung/soul-ui/cards/card-store";
import { registerConnectionRecovery } from "@seosoyoung/soul-ui/lib/orchestrator-connection";
import { SessionMenuProvider } from "./SessionMenuProvider";
import { CardWorkspace } from "./CardWorkspace";
import type { CardSessionSelection } from "./CardSessionHistory";
import { useCardNavigation } from "./card-navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AskQuestionBanner, DragHandle, FrameLoading, FrameNotice, LiquidGlassCanvas, LiquidGlassProvider, WallpaperLayer, fetchFolderSnapshot, initTheme, useAuth, useDashboardStore, useInitialCatalogLoad, useNotification, useReadPositionSync, useSessionProvider, useAgentPortraitSync, useGlassSurface, useUserPreferencesSync, type CatalogFolder, type InternalLinkTarget, type SessionSummary } from "@seosoyoung/soul-ui";
import { V3ErrorNotice } from "./V3ErrorNotice";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";
import { V3_CARD_GAP_PX, V3_CONTENT_MAX_WIDTH_PX, V3_OUTER_INSET_PX, V3_PANEL_GAP_PX } from "./v3-layout-metrics";
import { V3_MAIN_COLUMNS_OUTER_MARGIN_PX } from "./v3-main-columns";
import { useNodes } from "../hooks/useNodes";
import { ConfigModal } from "../components/ConfigModal";
import { V3SearchModal } from "./V3SearchModal";
import { orchestratorSessionProvider } from "../providers";
import { CardHome } from "./CardHome";
import { MobilePlannerTabs, useMobilePlannerMode } from "./MobilePlannerTabs";
import { MobileProjectList } from "./MobileProjectList";
import { FolderWorkspace } from "./FolderWorkspace";
import { FolderDetailPane } from "./FolderDetailPane";
import { FolderWorkspaceSections } from "./FolderWorkspaceSections";
import { FolderArchiveDialog } from "./FolderArchiveDialog";
import { ProjectDialog, type ProjectDialogTarget } from "./ProjectDialog";
import { saveProjectFormContext } from "./project-form-actions";
import { useFolderWorkspaceFolder } from "./use-folder-workspace-entry";
import { FolderParentMoveDialog } from "./FolderParentMoveDialog";
import { V3Navigation } from "./V3Navigation";
import { V3SessionPanel } from "./V3SessionPanel";
import { V3GlobalToolbar } from "./V3GlobalToolbar";
import { V3Toast } from "./V3Toast";
import { useV3PlannerActions } from "./use-v3-planner-actions";
import { useV3Notifications } from "./use-v3-notifications";
import { reduceMobilePlannerEscape, resolveSessionIntentTabPress, revealAttentionDetail, selectMobilePlannerTab, shouldApplyRememberedChatTab, type MobilePlannerState, type MobilePlannerTab } from "./mobile-planner-state";
import { useFolderStarChanges } from "./folder-star-store";
import { createPlannerDataDependencies, isPlannerFolder, starredFolderPage, type PlannerFolder } from "./planner-data";
import { fetchPageSessionDefaults, type PageSessionDefaults } from "./folder-workspace-page-api";
import { activateRunSession, resolveRunSessions } from "./folder-workspace-run-model";
import { buildMobileFolderOptions, errorText } from "./v3-dashboard-utils";
import { usePlannerCollections } from "./use-v3-planner-reads";
import { useProjectFolderController } from "./use-project-folder-controller";
import { invalidateV3, useV3PageInvalidationKey, useV3PlannerInvalidationKeys } from "./v3-live-invalidation-plane";
import { useFolderParentMoveController } from "./use-folder-parent-move-controller";
import { parseSessionSearchIntent } from "@soulstream/search-contract";
import { useV3LiveDataPlane } from "./use-v3-live-data-plane";
import { useV3DashboardMutations } from "./use-v3-dashboard-mutations";
import { useV3MutationProjection } from "./use-v3-mutation-projection";
import { useV3SessionPanelController } from "./use-v3-session-panel-controller";
import { useV3MainColumns } from "./use-v3-main-columns";
import { useSessionNodeConnectivity } from "./use-session-node-connectivity";
import { useProjectNavigationMutations } from "./use-project-navigation-mutations";
import { useFolderSessions } from "./use-folder-sessions";
import { InternalLinkViewers } from "./InternalLinkViewers";
import {
  useDashboardInternalLinks,
  useRegisterDashboardLinkOpeners,
} from "./DashboardInternalLinks";
import {
  consumeDashboardLinkIntent,
  readDashboardLinkIntent,
  runSessionIntentOpen,
  type DashboardLinkIntent,
} from "./dashboard-link-intent";
import "./v3-dashboard-styles";
export function V3DashboardLayout() {
  return <LiquidGlassProvider renderDefaultCanvas={false}><V3DashboardContent /></LiquidGlassProvider>;
}
function V3DashboardContent() {
  const { t } = useTranslation();
  const cardNavigation = useCardNavigation();
  const queryClient = useQueryClient();
  const api = useMemo(() => createPageApiClient(), []);
  const dataDependencies = useMemo(() => createPlannerDataDependencies(), []);
  const projectSelection = useProjectFolderController();
  const { resolution, selectedFolderId, selectedProject, clearProject } = projectSelection;
  const workspaceOpen = selectedFolderId !== null;
  const selectedProjectId = selectedProject?.id ?? null;
  const plannerInvalidationKeys = useV3PlannerInvalidationKeys();
  const projectContextInvalidationKey = useV3PageInvalidationKey([selectedProjectId]) + plannerInvalidationKeys.pageDetail;
  const [childFolderDialog, setChildFolderDialog] = useState<ProjectDialogTarget | null>(null);
  const [folderSettingsSaved, setFolderSettingsSaved] = useState(0);
  const [childArchiveTarget, setChildArchiveTarget] = useState<CatalogFolder | null>(null);
  const [acknowledgedReviewIds, setAcknowledgedReviewIds] = useState<ReadonlySet<string>>(() => new Set());
  const [configOpen, setConfigOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobilePlannerTab>("today");
  const [selectedFolderSnapshot, setSelectedFolderSnapshot] = useState<PlannerFolder | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const closeCardWorkspace = useCallback(() => {
    cardNavigation.close();
    setChatOpen(false);
    setMobileTab(selectedFolderId ? "projects" : "today");
  }, [cardNavigation.close, selectedFolderId]);
  const [markdownDocumentsRevision, setMarkdownDocumentsRevision] = useState(0);
  const [detailChatVisible, setDetailChatVisible] = useState(false);
  const [sessionDefaults, setSessionDefaults] = useState<PageSessionDefaults | null>(null);
  const { navigationWidth, sessionPanelWidth, resizeNavigation, resizeSessionPanel } = useV3MainColumns();
  const plannerSurfaceRef = useRef<HTMLDivElement>(null);
  const plannerScrollRef = useRef<HTMLDivElement>(null);
  const plannerWebglActive = useGlassSurface(plannerSurfaceRef, { enabled: true });
  useEffect(() => { initTheme(); }, []);
  const { user, refreshAuthStatus, isLoading: authLoading, isAuthenticated } = useAuth();
  const handleStreamConnectionError = useCallback(() => {
    void refreshAuthStatus().catch(() => undefined);
  }, [refreshAuthStatus]);
  const { toast, notify, notifyWriteFailure } = useV3Notifications(refreshAuthStatus);
  const { openTarget: openDashboardLink } = useDashboardInternalLinks();
  useUserPreferencesSync(user?.email ?? null);
  useAgentPortraitSync();
  const catalogLoadState = useInitialCatalogLoad(true);
  const catalogLoadError = catalogLoadState.status === "authentication"
    || catalogLoadState.status === "forbidden"
    || catalogLoadState.status === "error"
    ? t("sessions.listLoadFailed")
    : null;
  useReadPositionSync();
  useNotification(true);
  useNodes(handleStreamConnectionError);
  const mobileMode = useMobilePlannerMode();
  const catalog = useDashboardStore((state) => state.catalog);
  const catalogSessions = catalog?.sessionList ?? [];
  useEffect(() => {
    setAcknowledgedReviewIds((current) => {
      let next: Set<string> | null = null;
      for (const sessionId of current) {
        const session = catalogSessions.find((candidate) => candidate.agentSessionId === sessionId);
        if (!session || session.status !== "completed" || session.reviewState !== "needs_review") {
          next ??= new Set(current);
          next.delete(sessionId);
        }
      }
      return next ?? current;
    });
  }, [catalogSessions]);
  const activeSessionKey = useDashboardStore((state) => state.activeSessionKey);
  const activeSessionSummary = useDashboardStore((state) => state.activeSessionSummary);
  const setActiveSession = useDashboardStore((state) => state.setActiveSession);
  const setActiveSessionSummary = useDashboardStore((state) => state.setActiveSessionSummary);
  const setActiveTab = useDashboardStore((state) => state.setActiveTab);
  const { nodes, nodeConnectivity } = useSessionNodeConnectivity();
  const folderStarChanges = useFolderStarChanges();
  const {
    todayData,
    project,
    projects,
    starredFolders,
    starredFoldersHasMore,
    starredFoldersLoading,
    starredFoldersLoadingMore,
    starredFoldersReordering,
    subfoldersLoadingMore,
    loadMoreStarredFolders,
    reorderStarredFolders,
    loadMoreSubfolders,
    refreshFolder,
    waitForReads,
  } = usePlannerCollections({
    api,
    dependencies: dataDependencies,
    selectedProject,
    selectedFolderId,
    folderStarChanges,
    refreshKeys: plannerInvalidationKeys,
    notify,
  });
  useEffect(() => registerConnectionRecovery(async () => {
    flushSync(() => invalidateV3("replay"));
    await Promise.all([
      waitForReads(),
      queryClient.refetchQueries({queryKey: ["v3-review-queue"], type: "active"}, {cancelRefetch: false, throwOnError: true}),
      queryClient.refetchQueries({queryKey: ["sessions"], type: "active"}, {cancelRefetch: false, throwOnError: true}),
      ...(cardNavigation.cardId ? [useCardStore.getState().loadCard(cardNavigation.cardId)] : []),
    ]);
  }), [cardNavigation.cardId, queryClient, waitForReads]);

  const folderAggregate = project.data?.folder.id === selectedFolderId ? project.data : null;
  const folderSessions = useFolderSessions({
    dependencies: dataDependencies,
    folderId: selectedFolderId,
    initial: folderAggregate?.sessions ?? null,
    notify,
  });
  const currentFolderEntries = useMemo(
    () => starredFolders.filter(isPlannerFolder),
    [starredFolders],
  );
  const selectedFolder = catalog?.folders.find((folder) => folder.id === selectedFolderId) ?? null;
  const childFolders = useMemo(() => (catalog?.folders ?? []).filter(
    (folder) => !folder.archived && folder.parentFolderId === selectedFolderId,
  ), [catalog?.folders, selectedFolderId]);
  const knownWorkspaceFolder = currentFolderEntries.find((task) => task.folderId === selectedFolderId)
    ?? (selectedFolderSnapshot?.folderId === selectedFolderId ? selectedFolderSnapshot : null);
  const folderWorkspace = useFolderWorkspaceFolder({
    folder: selectedFolder,
    aggregate: folderAggregate,
    knownFolder: knownWorkspaceFolder,
  });
  const selectedFolderEntry = folderWorkspace.folder;
  const selectFolder = useCallback(async (folder: typeof selectedFolder, task?: PlannerFolder, preserveSession = false) => {
    if (!folder) return;
    cardNavigation.close();
    if (!preserveSession) {
      setChatOpen(false);
      setActiveSessionSummary(null);
      setActiveSession(null);
    }
    setSelectedFolderSnapshot(task ?? null);
    await projectSelection.openFolder(api, folder, projects, notify);
    if (mobileMode) setMobileTab("task");
  }, [api, cardNavigation.close, mobileMode, notify, projectSelection.openFolder, projects, setActiveSession, setActiveSessionSummary]);
  const sessionPanel = useV3SessionPanelController({
    api,
    catalog,
    currentFolderEntries,
    acknowledgedReviewIds,
    onSelectFolder: async (task) => {
      const known = catalog?.folders.find((folder) => folder.id === task.folderId);
      const snapshot = known ? null : await fetchFolderSnapshot(task.folderId);
      const folder = known ?? (snapshot ? { ...snapshot.folder, sortOrder: 0 } : null);
      if (!folder) throw new Error(t("sessions.sessionFolderMissing"));
      await selectFolder(folder, task, true);
    },
    onClearFolder: clearProject,
    setChatOpen,
    notify,
    openCard: cardNavigation.open,
    clearCard: cardNavigation.close,
  });
  const dashboardLinkOpeners = useMemo(() => ({
    session: (target: InternalLinkTarget) => {
      if (target.kind !== "session") return false;
      const eventId = target.eventId === undefined ? null : Number(target.eventId);
      const focusEventId = eventId !== null && Number.isSafeInteger(eventId) && eventId > 0 ? eventId : null;
      return sessionPanel.openSessionById(target.sessionId, focusEventId);
    },
    card: (target: InternalLinkTarget) => {
      if (target.kind !== "card") return false;
      cardNavigation.open(target.cardId);
      return true;
    },
    folder: (target: InternalLinkTarget) => {
      if (target.kind !== "folder") return false;
      const folder = catalog?.folders.find((candidate) => candidate.id === target.folderId);
      return folder ? selectFolder(folder).then(() => true) : false;
    },
    page: (target: InternalLinkTarget) => {
      if (target.kind !== "page") return false;
      const folder = catalog?.folders.find((candidate) => candidate.projectPageId === target.pageId);
      if (!folder) {
        notify(t("sessions.pageFolderMissing"));
        return false;
      }
      return selectFolder(folder).then(() => true);
    },
  }), [t, cardNavigation.open, catalog?.folders, notify, selectFolder, sessionPanel.openSessionById]);
  useRegisterDashboardLinkOpeners(dashboardLinkOpeners);

  const attemptedDashboardIntent = useRef<string | null>(null);
  // `?session=` 지정을 아직 읽는 중인가. 지정이 끝나기 전(인증 대기 포함)에 누른
  // 모바일 채팅 탭은 폴더와 실행을 새로 고르지 않고 여기 기억해 둔다.
  const sessionIntentPending = useRef(false);
  const sessionIntentInFlight = useRef(false);
  const chatTabPressedWhilePending = useRef(false);
  const mobileModeRef = useRef(mobileMode);
  useEffect(() => { mobileModeRef.current = mobileMode; }, [mobileMode]);
  useEffect(() => {
    const currentUrl = new URL(window.location.href);
    const hasDashboardQuery = ["session", "card", "document", "folder", "page", "attachment"]
      .some((key) => currentUrl.searchParams.has(key));
    const hasLegacyIntent = /^#\/feed\//.test(currentUrl.hash);
    if (currentUrl.pathname !== "/" || (!hasDashboardQuery && !hasLegacyIntent)) {
      attemptedDashboardIntent.current = null;
      sessionIntentPending.current = false;
      chatTabPressedWhilePending.current = false;
      return;
    }
    const isSessionIntent = currentUrl.searchParams.has("session") || hasLegacyIntent;
    sessionIntentPending.current = isSessionIntent;
    if (authLoading || !isAuthenticated) return;

    const identity = currentUrl.toString();
    if (attemptedDashboardIntent.current === identity) {
      // 같은 주소로 이미 열기를 시작했다. 아직 진행 중이면 지정 대기를 그대로 두고,
      // 실패로 끝난 뒤에만 대기를 풀어 이후 탭 누름이 지금처럼 가게 한다.
      if (!sessionIntentInFlight.current) {
        sessionIntentPending.current = false;
        chatTabPressedWhilePending.current = false;
      }
      return;
    }
    const dashboardIntent = readDashboardLinkIntent(window.location, [window.location.origin]);
    let sessionTarget: Extract<InternalLinkTarget, { kind: "session" }> | null = null;
    if (isSessionIntent) {
      const sessionIntent = parseSessionSearchIntent(currentUrl);
      if (!sessionIntent) {
        attemptedDashboardIntent.current = identity;
        sessionIntentPending.current = false;
        chatTabPressedWhilePending.current = false;
        notify(t("sessions.invalidSessionLink"));
        return;
      }
      if (sessionIntent.eventId !== undefined) {
        if (!/^\d+$/.test(sessionIntent.eventId) || Number(sessionIntent.eventId) < 1
          || !Number.isSafeInteger(Number(sessionIntent.eventId))) {
          attemptedDashboardIntent.current = identity;
          sessionIntentPending.current = false;
          chatTabPressedWhilePending.current = false;
          notify(t("sessions.invalidSessionEvent"));
          return;
        }
      }
      sessionTarget = {
        kind: "session",
        sessionId: sessionIntent.sessionId,
        ...(sessionIntent.eventId === undefined ? {} : { eventId: sessionIntent.eventId }),
      };
    }
    const intent: DashboardLinkIntent | null = dashboardIntent ?? (sessionTarget ? {
      target: sessionTarget,
      identity: `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`,
      legacy: hasLegacyIntent,
    } : null);
    if (!intent) {
      sessionIntentPending.current = false;
      return;
    }
    if ((intent.target.kind === "folder" || intent.target.kind === "page")
      && catalogLoadState.status === "loading") return;

    attemptedDashboardIntent.current = identity;
    sessionIntentInFlight.current = true;
    const target = sessionTarget ?? intent.target;
    // 지정 열기가 거짓으로 끝나든 예외로 끝나든 대기 표시 셋을 함께 푼다.
    // 예외를 그냥 두면 sessionIntentPending이 참으로 남아 이후 채팅 탭 누름이
    // 이 화면에 머무는 동안 계속 삼켜진다.
    runSessionIntentOpen(
      () => openDashboardLink(target, identity),
      {
        inFlight: sessionIntentInFlight,
        pending: sessionIntentPending,
        rememberedChatTab: chatTabPressedWhilePending,
      },
      (opened, rememberedChatTab) => {
        if (!opened || window.location.href !== identity) return;
        window.history.replaceState(
          window.history.state,
          "",
          consumeDashboardLinkIntent(identity, intent),
        );
        attemptedDashboardIntent.current = null;
        if (shouldApplyRememberedChatTab({ opened, mobileMode: mobileModeRef.current, remembered: rememberedChatTab })) {
          setMobileTab("chat");
        }
      },
    );
  }, [t, authLoading, catalogLoadState.status, isAuthenticated, notify, openDashboardLink]);
  const clearSessionPanelFocus = sessionPanel.clearFocusRequest;
  const removeRunHistorySessions = folderSessions.removeSessions;
  const moveRunHistorySession = folderSessions.moveSession;
  const { patchPlannerFolder, removeSessionsFromPlanner, moveSessionInPlanner, moveFolderParentInPlanner } = useV3MutationProjection({
    removeRunHistorySessions, moveRunHistorySession, setSelectedFolderSnapshot,
  });
  const plannerActions = useV3PlannerActions({
    api,
    folders: catalog?.folders ?? [],
    notify,
    notifyWriteFailure,
    patchFolder: patchPlannerFolder,
    removeSessionsFromPlanner,
    moveSessionInPlanner,
    moveFolderParentInPlanner,
    refreshFolder,
  });
  const folderParentMove = useFolderParentMoveController({
    api,
    folders: catalog?.folders ?? [],
    moveFolder: plannerActions.moveFolderParent,
    notify,
  });
  const projectNavigationMutations = useProjectNavigationMutations({
    api,
    knownPages: projects,
    notify,
    selectedFolderId,
    createProject: projectSelection.createProject,
    patchProjectTitle: projectSelection.patchProjectTitle,
    clearProject,
  });
  const plannerSessionIds = useMemo(
    () => [...new Set([
      ...currentFolderEntries.flatMap((task) => task.sessionIds),
      ...(todayData.data?.reviewSessionIds ?? []),
      ...(folderSessions.state?.items.map((session) => session.agentSessionId) ?? []),
    ])].sort(),
    [currentFolderEntries, todayData.data?.reviewSessionIds, folderSessions.state?.items],
  );
  const {
    sessions: targetedRunSessions,
    loading: targetedRunSessionsLoading,
  } = useV3LiveDataPlane({
    sessionIds: plannerSessionIds,
    onConnectionError: handleStreamConnectionError,
  });
  const runSessionResolution = useMemo(() => resolveRunSessions({
    sessionIds: plannerSessionIds,
    fallbackSessions: folderSessions.state?.items ?? [],
    catalogSessions,
    targetedSessions: targetedRunSessions,
    targetedLoading: targetedRunSessionsLoading,
  }), [catalogSessions, folderSessions.state?.items, plannerSessionIds, targetedRunSessions, targetedRunSessionsLoading]);
  const sessions = runSessionResolution.sessions;
  const cursorScope = `${window.location.origin}|${user?.email ?? "anonymous"}`;
  const cardChatVisible = Boolean(cardNavigation.cardId && chatOpen && (!mobileMode || mobileTab === "chat"));
  const detailActive = chatOpen && (cardChatVisible || detailChatVisible);
  const {
    synchronizedSessionKey,
    status: sessionConnectionStatus,
    reconnect: reconnectSession,
  } = useSessionProvider({
    sessionKey: activeSessionKey,
    getSessionProvider: () => orchestratorSessionProvider,
    active: detailActive,
    cursorScope,
    onConnectionError: handleStreamConnectionError,
  });
  const historyEnabled = detailActive && synchronizedSessionKey === activeSessionKey;
  const mobileFolderOptions = useMemo(
    () => buildMobileFolderOptions(catalog?.folders ?? [], sessions),
    [catalog?.folders, sessions],
  );
  useEffect(() => {
    if (!selectedProjectId) {
      setSessionDefaults(null);
      return;
    }
    let active = true;
    void fetchPageSessionDefaults(selectedProjectId).then((defaults) => {
      if (active) setSessionDefaults(defaults);
    }).catch((error: unknown) => {
      if (active) notify(t("sessions.runDefaultsError", { detail: errorText(error) }));
    });
    return () => { active = false; };
  }, [t, notify, selectedProjectId]);
  const activeSession = catalogSessions.find((session) => session.agentSessionId === activeSessionKey)
    ?? sessions.find((session) => session.agentSessionId === activeSessionKey)
    ?? (activeSessionSummary?.agentSessionId === activeSessionKey ? activeSessionSummary : undefined);
  const chatInputDisabled = activeSessionKey !== null && (
    !activeSession?.nodeId || nodes.get(activeSession.nodeId)?.status !== "connected"
  );
  const fileUploadUrl = activeSession?.nodeId && !chatInputDisabled
    ? `/api/attachments/sessions?nodeId=${encodeURIComponent(activeSession.nodeId)}`
    : undefined;
  const applyMobileState = useCallback((next: MobilePlannerState) => {
    setMobileTab(next.activeTab);
    setChatOpen(next.chatOpen);
    if (!next.workspaceOpen) clearProject();
    else if (next.selectedFolderId !== selectedFolderId) {
      const folder = catalog?.folders.find((candidate) => candidate.id === next.selectedFolderId) ?? null;
      if (folder) void selectFolder(folder);
    }
    if (next.selectedRunId !== activeSessionKey) {
      const session = sessions.find((candidate) => candidate.agentSessionId === next.selectedRunId) ?? null;
      if (session) {
        activateRunSession(session, { setActiveSessionSummary, setActiveSession, setActiveTab });
      } else {
        setActiveSessionSummary(null);
        setActiveSession(null);
      }
    }
    if (next.activeTab === "today") {
      clearProject();
    }
  }, [activeSessionKey, catalog?.folders, clearProject, selectFolder, selectedFolderId, sessions, setActiveSession, setActiveSessionSummary, setActiveTab]);
  const switchMobileTab = useCallback((target: MobilePlannerTab) => {
    cardNavigation.close();
    const press = resolveSessionIntentTabPress(target, sessionIntentPending.current);
    if (press.rememberChatTab) chatTabPressedWhilePending.current = true;
    else if (press.forgetChatTab) chatTabPressedWhilePending.current = false;
    if (press.deferChatTab) return;
    applyMobileState(selectMobilePlannerTab({
      activeTab: mobileTab,
      selectedFolderId: selectedFolderId,
      selectedRunId: activeSessionKey,
      workspaceOpen,
      chatOpen,
    }, target, mobileFolderOptions));
  }, [activeSessionKey, applyMobileState, chatOpen, mobileTab, mobileFolderOptions, selectedFolderId, workspaceOpen]);
  const returnToPlanner = useCallback(() => {
    cardNavigation.close();
    setMobileTab("today");
    setChatOpen(false);
    clearProject();
  }, [cardNavigation.close, clearProject]);
  const closeWorkspace = useCallback(() => {
    setMobileTab("today");
    setChatOpen(false);
    clearProject();
  }, [clearProject]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if(event.defaultPrevented)return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const typing = target?.matches("input, textarea, select, [contenteditable=true]") ?? false;
      if ((event.key === "c" || event.key === "C") && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setChildFolderDialog({ mode: "create", parentFolderId: null, parentName: null });
        return;
      }
      if (event.key !== "Escape") return;
      if (cardNavigation.cardId) { closeCardWorkspace(); event.preventDefault(); }
      else if (childFolderDialog) setChildFolderDialog(null);
      else if (mobileMode && mobileTab === "chat" && chatOpen) {
        event.preventDefault();
        applyMobileState(reduceMobilePlannerEscape({
          activeTab: mobileTab,
          selectedFolderId: selectedFolderId,
          selectedRunId: activeSessionKey,
          workspaceOpen,
          chatOpen,
        }));
      }
      else if (workspaceOpen) closeWorkspace();
      else if (selectedProjectId) clearProject();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeSessionKey, applyMobileState, cardNavigation.cardId, closeCardWorkspace, chatOpen, childFolderDialog, clearProject, closeWorkspace, mobileMode, mobileTab, selectedFolderId, selectedProjectId, workspaceOpen]);
  const openStarredFolder = async (page: typeof starredFolders[number]) => {
    const targetPage = starredFolderPage(page);
    const folder = catalog?.folders.find((candidate) => candidate.projectPageId === targetPage.id) ?? null;
    if (!folder) {
      notify(t("sessions.starredFolderMissing"));
      return;
    }
    await selectFolder(folder, "page" in page ? page : undefined);
  };
  const openSession = useCallback((session: SessionSummary, selection?:CardSessionSelection) => {
    clearSessionPanelFocus();
    activateRunSession(session, { setActiveSessionSummary, setActiveSession, setActiveTab });
    setChatOpen(true);
    if (selection?.source !== 'automatic' && mobileMode && (selectedFolderId || cardNavigation.cardId)) setMobileTab("chat");
  }, [cardNavigation.cardId, clearSessionPanelFocus, mobileMode, selectedFolderId, setActiveSession, setActiveSessionSummary, setActiveTab]);
  const {
    saveDescription,
    acknowledgeReview,
    applyFolderBlocks,
  } = useV3DashboardMutations({
    api,
    selectedFolderEntry,
    selectedPageId: selectedProjectId,
    setAcknowledgedReviewIds,
    notify,
    notifyWriteFailure,
    patchPlannerFolder,
    refreshFolder,
  });
  const { sessions: panelSessions } = sessionPanel;
  const shellStyle = {
    "--v3-card-gap": `${V3_CARD_GAP_PX}px`,
    "--v3-panel-gap": `${V3_PANEL_GAP_PX}px`,
    "--v3-outer-inset": `${V3_OUTER_INSET_PX}px`,
    "--v3-main-columns-outer-margin": `${V3_MAIN_COLUMNS_OUTER_MARGIN_PX}px`,
    "--v3-content-max-width": `${V3_CONTENT_MAX_WIDTH_PX}px`,
    "--v3-navigation-width": `${navigationWidth}px`,
    "--v3-session-panel-width": `${sessionPanelWidth}px`,
  } as CSSProperties;
  const workspaceFolderEntry = useMemo(
    () => selectedFolderEntry ? {
      ...selectedFolderEntry,
      sessionIds: [...new Set([
        ...(folderSessions.state?.items.map((session) => session.agentSessionId) ?? []),
      ])],
    } : null,
    [folderSessions.state?.items, selectedFolderEntry],
  );
  const parentFolder = catalog?.folders.find((folder) => folder.id === selectedFolder?.parentFolderId) ?? null;
  const projectTitle = parentFolder?.name ?? t("sessions.uncategorized");
  const projectFolderId = selectedFolderId;
  const folderSections = selectedFolder ? <FolderWorkspaceSections
    folder={selectedFolder}
    parentFolder={parentFolder}
    folders={catalog?.folders ?? []}
    children={(folderAggregate?.subfolders ?? childFolders)
      .map((child) => catalog?.folders.find((current) => current.id === child.id) ?? child)
      .filter((child) => !child.archived)}
    hasMoreChildren={Boolean(folderAggregate?.nextSubfolderCursor)}
    childrenLoadingMore={subfoldersLoadingMore}
    onLoadMoreChildren={() => { void loadMoreSubfolders(); }}
    knownPages={projects}
    sessions={sessions}
    nodeConnectivity={nodeConnectivity}
    invalidationKey={projectContextInvalidationKey}
    contextSavedKey={folderSettingsSaved}
    onOpenFolder={(folder) => { void selectFolder(folder); }}
    onCreateSubfolder={() => setChildFolderDialog({ mode: "create", parentFolderId: selectedFolder.id, parentName: selectedFolder.name })}
    onOpenSettings={() => setChildFolderDialog({ mode: "edit", folder: selectedFolder })}
    onRenameChild={(folder) => setChildFolderDialog({ mode: "edit", folder })}
    onArchiveChild={(folder) => {
      void (async () => {
        let hasContents: boolean;
        try {
          hasContents = await projectNavigationMutations.projectHasContents(folder.id);
        } catch (error) {
          notifyWriteFailure(t("sessions.checkFolderContents"), error);
          return;
        }
        if (hasContents) setChildArchiveTarget(folder);
        else void projectNavigationMutations.onDeleteProject(folder).catch((error) => notifyWriteFailure(t("sessions.archiveFolder"), error));
      })();
    }}
    onCompleteFolder={plannerActions.completeFolder}
    onMoveFolderToParent={folderParentMove.openFolder}
    onBlocksChanged={applyFolderBlocks}
  /> : null;
  const renameSelectedFolder = (title: string) => workspaceFolderEntry
    ? plannerActions.renameFolderPageTitle(workspaceFolderEntry, title)
    : Promise.reject(new Error(t("sessions.noLinkedFolder")));
  return (
    <SessionMenuProvider sessions={sessions} onRename={plannerActions.renameSession}
      onDelete={plannerActions.deleteSessions} onMove={plannerActions.moveSession} onCreated={sessionPanel.openSession}>
    <div className="v3-shell isolate font-sans" data-mobile-tab={mobileTab} data-mobile-project-open={selectedFolderId ? "true" : "false"} style={shellStyle}>
      <WallpaperLayer />
      <LiquidGlassCanvas />
      <V3GlobalToolbar
        onOpenConfig={() => setConfigOpen(true)}
        onOpenSearch={() => setSearchOpen(true)}
      />
      <V3Navigation
        onSelectHome={returnToPlanner} homeSelected={!selectedFolderId} folders={catalog?.folders ?? []} catalogLoadError={catalogLoadError} selectedFolderId={selectedFolderId}
        starredFolders={starredFolders} starredFoldersHasMore={starredFoldersHasMore} starredFoldersLoading={starredFoldersLoading || starredFoldersLoadingMore || starredFoldersReordering}
        completedFolderIds={new Set(currentFolderEntries.filter((task) => task.status === "completed").map((task) => task.page.id))}
        onLoadMoreStarredFolders={() => { void loadMoreStarredFolders(); }}
        onReorderStarredFolders={reorderStarredFolders}
        onSelectFolder={(folder) => { void selectFolder(folder); }}
        onSelectStarredFolder={(task) => { void openStarredFolder(task); }} onCompleteFolder={plannerActions.completeStarredFolder}
        onMoveFolderToParent={(task) => { void folderParentMove.openPage(task); }} {...projectNavigationMutations}
      />
      {mobileMode && mobileTab === "projects" && !selectedFolderId ? <MobileProjectList folders={catalog?.folders ?? []} onSelect={(folder) => { void selectFolder(folder); }} /> : null}
      <div className="v3-navigation-resize" data-testid="v3-navigation-resize-handle" aria-hidden="true">
        <DragHandle onDrag={resizeNavigation} widthPx={V3_PANEL_GAP_PX} />
      </div>
      <main className="v3-main">
        <div
          ref={plannerSurfaceRef}
          className="v3-planner border border-glass-border glass-strong glass-chrome lg-rim"
          data-liquid-glass-webgl={plannerWebglActive ? "true" : undefined}
        >
          <div ref={plannerScrollRef} className="v3-planner-scroll" data-testid="v3-planner-scroll">
            {selectedFolderId ? (workspaceFolderEntry && selectedFolder ? <FolderDetailPane
              placement="inline"
              scrollContainerRef={plannerScrollRef}
              task={workspaceFolderEntry}
              folderSections={folderSections}
              parentFolder={parentFolder}
              onOpenParent={(folder) => { void selectFolder(folder); }}
              projectFolderId={projectFolderId}
              folders={catalog?.folders ?? []}
              contextInvalidationKey={projectContextInvalidationKey}
              sessions={sessions}
              runSessionLoadStates={runSessionResolution.loadStateById}
              runHistoryTotal={workspaceFolderEntry.sessionIds.length}
              runHistoryHasMore={Boolean(folderSessions.state?.nextCursor)}
              runHistoryLoading={Boolean(folderSessions.state?.loadingMore)}
              runHistoryFailed={Boolean(folderSessions.state?.loadFailed)}
              activeSessionId={activeSessionKey}
              markdownDocumentsRevision={markdownDocumentsRevision}
              focusRequest={sessionPanel.focusRequest}
              onFocusRequestHandled={sessionPanel.acknowledgeFocusRequest}
              onLoadMoreRuns={folderSessions.loadMore}
              sessionDefaults={sessionDefaults}
              onReturnToToday={returnToPlanner}
              folderMoveTargets={currentFolderEntries}
              onOpenSession={openSession}
              onRenameFolderTitle={async (title) => { await renameSelectedFolder(title); }}
              onSaveDescription={saveDescription}

              onFolderBlocksChanged={applyFolderBlocks}
              onArchiveFolder={() => projectNavigationMutations.onDeleteProject(selectedFolder)}
            /> : !workspaceFolderEntry && !activeSession ? (
              <section className="v3-planner-loading" aria-busy={resolution.status === "loading"}>
                {resolution.status === "error" || project.status === "error" ? (
                  <FrameNotice>
                    <V3ErrorNotice message={t("sessions.plannerLoadFailed")}
                      detail={resolution.status === "error" ? resolution.message : project.message} />
                  </FrameNotice>
                ) : <FrameLoading label={t("sessions.loading")} />}
              </section>
            ) : null) : <CardHome folders={catalog?.folders??[]}/> }
          </div>
        </div>
      </main>
      <div className="v3-session-panel-resize" data-testid="v3-session-panel-resize-handle" aria-hidden="true">
        <DragHandle onDrag={resizeSessionPanel} widthPx={V3_PANEL_GAP_PX} />
      </div>
      <V3SessionPanel ref={sessionPanel.panelRef} sessions={panelSessions} folders={catalog?.folders ?? []} nodeConnectivity={nodeConnectivity} activeSessionId={activeSessionKey} acknowledgedReviewIds={acknowledgedReviewIds} onOpenSession={sessionPanel.openFeedSession} onAcknowledged={acknowledgeReview} />
      {cardNavigation.cardId ? <CardWorkspace cardId={cardNavigation.cardId} initialSessionId={cardNavigation.initialSessionId} folders={catalog?.folders??[]} onClose={closeCardWorkspace} onCloseChat={() => setMobileTab("today")} onOpenSession={openSession}
        mobileMode={mobileMode} mobileTab={mobileTab} activeSession={chatOpen?activeSession:undefined}
        chatInputDisabled={chatInputDisabled} fileUploadUrl={fileUploadUrl} historyEnabled={historyEnabled}
        sessionStreamActive={detailActive} sessionConnectionStatus={sessionConnectionStatus} reconnectSession={reconnectSession} onAcknowledgedReview={acknowledgeReview}/> : null}
      {!cardNavigation.cardId && chatOpen && activeSession ? (
        <FolderWorkspace
          task={workspaceFolderEntry}
          folderSections={folderSections}
          parentFolder={parentFolder}
          onOpenParent={(folder) => { void selectFolder(folder); }}
          folderResolutionError={sessionPanel.workspaceFolderError}
          projectTitle={projectTitle}
          projectFolderId={projectFolderId}
          folders={catalog?.folders ?? []}
          contextInvalidationKey={projectContextInvalidationKey}
          sessions={sessions}
          runSessionLoadStates={runSessionResolution.loadStateById}
          runHistoryTotal={workspaceFolderEntry?.sessionIds.length ?? 0}
          runHistoryHasMore={Boolean(folderSessions.state?.nextCursor)}
          runHistoryLoading={Boolean(folderSessions.state?.loadingMore)}
          runHistoryFailed={Boolean(folderSessions.state?.loadFailed)}
          onLoadMoreRuns={folderSessions.loadMore}
          activeSession={activeSession}
          focusRequest={sessionPanel.focusRequest}
          onFocusRequestHandled={sessionPanel.acknowledgeFocusRequest}
          chatOpen={chatOpen}
          chatInputDisabled={chatInputDisabled}
          fileUploadUrl={fileUploadUrl}
          sessionDefaults={sessionDefaults}
          mobileMode={mobileMode}
          mobileTab={mobileTab}
          historyEnabled={historyEnabled}
          sessionStreamActive={detailActive}
          sessionConnectionStatus={sessionConnectionStatus}
          reconnectSession={reconnectSession}
          onChatVisibilityChange={setDetailChatVisible}
          folderMoveTargets={currentFolderEntries}
          onReturnToToday={returnToPlanner}
          onCloseWorkspace={() => { setChatOpen(false); setActiveSessionSummary(null); setActiveSession(null); if (!workspaceFolderEntry) closeWorkspace(); }}
          onCloseChat={() => { if (mobileMode) switchMobileTab("task"); else setChatOpen(false); }}
          onOpenSession={openSession}
          onRenameFolderTitle={(title) => workspaceFolderEntry ? plannerActions.renameFolderPageTitle(workspaceFolderEntry, title) : Promise.reject(new Error(t("sessions.noLinkedFolder")))}
          onSaveDescription={saveDescription}

          onFolderBlocksChanged={applyFolderBlocks}
          onAcknowledgedReview={acknowledgeReview}
          onArchiveFolder={selectedFolder ? () => projectNavigationMutations.onDeleteProject(selectedFolder) : undefined}
          markdownDocumentsRevision={markdownDocumentsRevision}
          onMarkdownDocumentEditorClosed={() => setMarkdownDocumentsRevision((current) => current + 1)}
        />
      ) : null}
      <AskQuestionBanner
        treeEnabled={detailActive}
        onOpenDetail={() => {
          applyMobileState(revealAttentionDetail({
            activeTab: mobileTab,
            selectedFolderId: selectedFolderId,
            selectedRunId: activeSessionKey,
            workspaceOpen,
            chatOpen,
          }, mobileMode));
        }}
      />
      <FolderParentMoveDialog {...folderParentMove.dialogProps} />
      <ProjectDialog
        target={childFolderDialog}
        createLabel={t("sessions.newFolder")}
        onClose={() => setChildFolderDialog(null)}
        onCreateIdentity={projectNavigationMutations.onCreateProject}
        onRename={projectNavigationMutations.onRenameProject}
        folders={catalog?.folders ?? []}
        onSaveContext={(pageId, previous, value, attempt) => saveProjectFormContext(api, pageId, previous, value, attempt)}
        onSaved={() => setFolderSettingsSaved((count) => count + 1)}
      />
      <FolderArchiveDialog
        folder={childArchiveTarget}
        onClose={() => setChildArchiveTarget(null)}
        onArchive={(folder) => {
          setChildArchiveTarget(null);
          void projectNavigationMutations.onDeleteProject(folder).catch((error) => notifyWriteFailure(t("sessions.archiveFolder"), error));
        }}
      />
      <MobilePlannerTabs activeTab={mobileTab} onSelect={switchMobileTab} />
      <ConfigModal open={configOpen} onOpenChange={setConfigOpen} />
      <V3SearchModal open={searchOpen} onOpenChange={setSearchOpen} sessions={sessions} onOpenSession={sessionPanel.openSessionById} onOpenFolder={(folderId) => { const folder = catalog?.folders.find((candidate) => candidate.id === folderId); if (folder) void selectFolder(folder); }} />
      <V3Toast message={toast} />
      <InternalLinkViewers />
    </div>
    </SessionMenuProvider>
  );
}

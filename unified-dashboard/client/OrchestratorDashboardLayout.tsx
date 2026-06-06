/**
 * OrchestratorDashboardLayout - unified-dashboard orchestrator 모드 레이아웃
 *
 * orchestrator-dashboard의 App.tsx를 unified-dashboard로 포팅.
 * features.nodePanel = true일 때 NodePanel 표시,
 * useNodes()로 /api/nodes/stream SSE 구독,
 * 30초 폴링 안전망으로 SSE 누락 대비.
 *
 * Phase 5 산출물. Phase 4의 ConfigModal/SearchModal/NewSessionModal 포함.
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import { FolderWorkspaceView } from "./components/FolderWorkspaceView";
import {
  createFolder,
  renameFolderOptimistic,
  deleteFolderOptimistic,
  updateFolderSettingsOptimistic,
  reorderFoldersOptimistic,
} from "./lib/folder-operations";
import { moveSessionsOptimistic } from "./lib/move-sessions";
import { NodePanel } from "./components/NodePanel";
import { OrchestratorNewSessionModal } from "./components/OrchestratorNewSessionModal";
import { ConfigButton } from "./components/ConfigButton";
import { ConfigModal } from "./components/ConfigModal";
import { SearchModal } from "./components/SearchModal";
import { useNodes } from "./hooks/useNodes";
import { useOrchestratorStore } from "./store/orchestrator-store";
import { orchestratorSessionProvider } from "./providers";
import { resolveActiveSessionSummary } from "./lib/active-session-summary";
import {
  AskQuestionBanner,
  MobileChatHeader,
  ThemeToggle,
  useSessionProvider,
  useReadPositionSync,
  useNotification,
  useUrlSync,
  useDashboardConfig,
  useServerStatus,
  DashboardShell,
  DashboardDndProvider,
  FolderTree,
  RightPanel,
  ChatView,
  initTheme,
  useDashboardStore,
  ConnectionBadge,
  useSessionListProvider,
  useIsMobile,
  useAuth,
  shouldLoadMoreAfterSessionMove,
  TaskTreeView,
} from "@seosoyoung/soul-ui";
import { FeedView } from "./components/FeedView";
import { useAppConfig } from "./config/AppConfigContext";
import {
  getRestrictedEntryFolderId,
  isFolderVisibleInRestrictedCatalog,
  isRestrictedDashboardAccess,
  RestrictedNoFoldersView,
} from "./restricted-dashboard-access";

export function OrchestratorDashboardLayout() {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const activeSessionSummary = useDashboardStore((s) => s.activeSessionSummary);
  const viewMode = useDashboardStore((s) => s.viewMode);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const catalog = useDashboardStore((s) => s.catalog);
  const openNewSessionModal = useDashboardStore((s) => s.openNewSessionModal);
  const nodes = useOrchestratorStore((s) => s.nodes);
  const connectionStatus = useOrchestratorStore((s) => s.connectionStatus);

  const { features } = useAppConfig();
  const { user, logout } = useAuth();
  const isMobile = useIsMobile();
  const dashboardAccess = user?.dashboardAccess;
  const isRestrictedAccess = isRestrictedDashboardAccess(dashboardAccess);

  // 테마 초기화
  useEffect(() => { initTheme(); }, []);

  // URL ↔ 스토어 동기화
  useUrlSync();

  useEffect(() => {
    if (!isMobile && !isRestrictedAccess && viewMode === "feed") {
      useDashboardStore.getState().setViewMode("folder");
    }
  }, [isMobile, isRestrictedAccess, viewMode]);

  // 읽음 위치 동기화
  useReadPositionSync();

  // 브라우저 알림
  useNotification();

  // 대시보드 프로필 설정 로드
  useDashboardConfig();

  // Soul Server 드레이닝 상태 폴링
  const { isDraining } = useServerStatus();

  // 노드 SSE 구독 (orchestrator 모드 전용)
  useNodes();

  // 세션 목록 구독
  const { folderCounts, hasMore, loadMore, sessions } = useSessionListProvider({
    intervalMs: 5000,
    getSessionProvider: () => orchestratorSessionProvider,
  });

  // 활성 세션 구독
  const { status: sseStatus } = useSessionProvider({
    sessionKey: activeSessionKey,
    getSessionProvider: () => orchestratorSessionProvider,
  });

  const activeSession = useMemo(
    () => resolveActiveSessionSummary(activeSessionKey, activeSessionSummary, sessions),
    [activeSessionKey, activeSessionSummary, sessions],
  );

  const restrictedEntryFolderId = useMemo(
    () => getRestrictedEntryFolderId(dashboardAccess, catalog),
    [dashboardAccess, catalog],
  );
  const restrictedHasNoFolders = isRestrictedAccess && catalog !== null && restrictedEntryFolderId === null;

  useEffect(() => {
    if (!isRestrictedAccess || restrictedEntryFolderId === null) return;
    if (viewMode !== "folder" || !isFolderVisibleInRestrictedCatalog(catalog, selectedFolderId)) {
      useDashboardStore.getState().selectFolder(restrictedEntryFolderId);
    }
  }, [catalog, isRestrictedAccess, restrictedEntryFolderId, selectedFolderId, viewMode]);

  // 활성 세션의 노드가 없거나 disconnected이면 ChatInput 비활성화
  const isChatInputDisabled = useMemo(() => {
    if (!activeSessionKey) return false;
    if (!activeSession?.nodeId) return true;
    const node = nodes.get(activeSession.nodeId);
    return !node || node.status === "disconnected";
  }, [activeSessionKey, activeSession, nodes]);

  const chatFileUploadUrl = useMemo(() => {
    if (!activeSession?.nodeId || isChatInputDisabled) {
      return undefined;
    }
    return `/api/attachments/sessions?nodeId=${encodeURIComponent(activeSession.nodeId)}`;
  }, [activeSession, isChatInputDisabled]);

  // 세션 이동 후 빈 자리 보충
  const handleMoveSessions = useCallback(
    async (sessionIds: string[], targetFolderId: string | null) => {
      if (isRestrictedAccess && !isFolderVisibleInRestrictedCatalog(catalog, targetFolderId)) return;
      const shouldBackfill = shouldLoadMoreAfterSessionMove({
        viewMode,
        selectedFolderId,
        catalog,
        sessionIds,
        targetFolderId,
      });
      await moveSessionsOptimistic(sessionIds, targetFolderId);
      if (hasMore && shouldBackfill) loadMore();
    },
    [catalog, hasMore, isRestrictedAccess, loadMore, selectedFolderId, viewMode],
  );

  // Config / Search 모달 상태
  const [configOpen, setConfigOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const restrictedFolderView = restrictedHasNoFolders ? (
    <RestrictedNoFoldersView onLogout={() => { void logout(); }} />
  ) : (
    <FolderWorkspaceView sessions={sessions} onLoadMore={loadMore} hasMore={hasMore} />
  );

  return (
    <DashboardDndProvider
      onMoveSessions={handleMoveSessions}
      onReorderFolders={reorderFoldersOptimistic}
    >
    <DashboardShell
      title="Soulstream Orchestrator"
      hideLeftPanel={isRestrictedAccess}
      leftPanel={
        <FolderTree
          onMoveSessions={handleMoveSessions}
          onCreateFolder={createFolder}
          onRenameFolder={renameFolderOptimistic}
          onDeleteFolder={deleteFolderOptimistic}
          onUpdateFolderSettings={updateFolderSettingsOptimistic}
          onReorderFolders={reorderFoldersOptimistic}
          folderCounts={folderCounts}
        />
      }
      leftFeedPanel={
        isRestrictedAccess ? undefined : (
          <FeedView
            placement="sidebar"
            onNewSession={() => openNewSessionModal("feed")}
            onLoadMore={loadMore}
            hasMore={hasMore}
          />
        )
      }
      leftPanelBottom={features.nodePanel && !isMobile && !isRestrictedAccess ? <NodePanel /> : undefined}
      leftBottomRatio={features.nodePanel && !isMobile && !isRestrictedAccess ? 3 : undefined}
      leftSplitStorageKey="soulstream:orchestrator-dashboard:left-split-top-percent:v1"
      centerPanel={
        isRestrictedAccess ? (
          restrictedFolderView
        ) : viewMode === "tasks" ? (
          <TaskTreeView
            sessions={sessions}
            onNewSession={(task, defaults) => openNewSessionModal("feed", task ?? null, defaults ?? null)}
          />
        ) : (
          <FolderWorkspaceView sessions={sessions} onLoadMore={loadMore} hasMore={hasMore} />
        )
      }
      rightPanel={
        <RightPanel
          chatInputDisabled={isChatInputDisabled}
          fileUploadUrl={chatFileUploadUrl}
        />
      }
      connectionStatus={connectionStatus ?? sseStatus}
      onSearchClick={isRestrictedAccess ? undefined : () => setSearchOpen(true)}
      banner={
        isDraining ? (
          <div
            role="status"
            className="flex items-center justify-center px-4 py-1.5 text-sm font-medium bg-accent-amber text-black shrink-0"
          >
            서버가 재시작 중입니다. 재시작 완료 후 세션이 자동으로 재개됩니다.
          </div>
        ) : undefined
      }
      headerRight={
        <>
          <ThemeToggle />
          {!isRestrictedAccess && <ConfigButton onClick={() => setConfigOpen(true)} />}
        </>
      }
      mobileSessionsView={
        isRestrictedAccess ? restrictedFolderView : <FeedView
          onNewSession={() => openNewSessionModal("feed")}
          onLoadMore={loadMore}
          hasMore={hasMore}
        />
      }
      mobileFolderContents={
        restrictedFolderView
      }
      mobileTasksView={
        isRestrictedAccess ? restrictedFolderView : <TaskTreeView
          sessions={sessions}
          onNewSession={(task, defaults) => openNewSessionModal("feed", task ?? null, defaults ?? null)}
        />
      }
      onNewSession={() => openNewSessionModal("folder")}
      mobileChatHeader={(onBack) => <MobileChatHeader onBack={onBack} />}
      mobileChatView={
        <ChatView
          chatInputDisabled={isChatInputDisabled}
          fileUploadUrl={chatFileUploadUrl}
        />
      }
      mobileSettingsContent={
        <div className="p-4 space-y-4">
          <h2 className="text-base font-semibold">설정</h2>
          {features.nodePanel && !isRestrictedAccess && (
            <div className="rounded-lg border border-border overflow-hidden">
              <NodePanel />
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-sm">테마</span>
            <ThemeToggle />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">연결 상태</span>
            <ConnectionBadge status={sseStatus} />
          </div>
        </div>
      }
      modals={
        <>
          <ConfigModal open={configOpen} onOpenChange={setConfigOpen} />
          <SearchModal open={searchOpen} onOpenChange={setSearchOpen} />
          <OrchestratorNewSessionModal />
          <AskQuestionBanner />
        </>
      }
    />
    </DashboardDndProvider>
  );
}

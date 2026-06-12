/**
 * DashboardLayout - unified-dashboard 메인 레이아웃 (single-node 모드)
 *
 * DashboardShell 위에 unified-dashboard 전용 훅과 컴포넌트를 조합한다.
 * 레이아웃 구조(3패널 리사이즈, 모바일 반응형)는 DashboardShell이 담당한다.
 *
 * soul-dashboard 대비 변경 사항:
 * - node-info 엔드포인트 제거 (BFF 없음) → isOtherNode = false 고정
 * - ConfigModal / SearchModal / NewSessionModal / DrainBanner 추가 (Phase 4)
 */

import { useState, useEffect, useCallback } from "react";
import { FolderWorkspaceView } from "./components/FolderWorkspaceView";
import {
  createFolder,
  renameFolderOptimistic,
  deleteFolderOptimistic,
  updateFolderSettingsOptimistic,
  reorderFoldersOptimistic,
} from "./lib/folder-operations";
import { moveSessionsOptimistic } from "./lib/move-sessions";
import { computeIsOtherNode } from "./lib/node-guard";
import { NewSessionModal } from "./components/NewSessionModal";
import { ConfigButton } from "./components/ConfigButton";
import { ConfigModal } from "./components/ConfigModal";
import { SearchModal } from "./components/SearchModal";
import { useAppConfig } from "./config/AppConfigContext";
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
  shouldLoadMoreAfterSessionMove,
  TaskTreeView,
} from "@seosoyoung/soul-ui";
import { FeedView } from "./components/FeedView";
import { getSessionProvider } from "./providers";

export function DashboardLayout() {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const viewMode = useDashboardStore((s) => s.viewMode);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const catalog = useDashboardStore((s) => s.catalog);
  const openNewSessionModal = useDashboardStore((s) => s.openNewSessionModal);

  // 세션 목록 구독 (SSE 모드: 실시간)
  const { folderCounts, hasMore, loadMore, sessions } = useSessionListProvider({
    intervalMs: 5000,
    getSessionProvider,
  });
  const {
    hasMore: feedHasMore,
    loadMore: loadMoreFeed,
    sessions: feedSessions,
  } = useSessionListProvider({
    intervalMs: 5000,
    getSessionProvider,
    viewModeOverride: "feed",
    folderIdOverride: null,
    streamEnabled: false,
    initialCatalogLoadEnabled: false,
    folderCountsEnabled: false,
  });

  // 활성 세션 구독 (Provider 기반)
  const { status: sseStatus } = useSessionProvider({
    sessionKey: activeSessionKey,
    getSessionProvider,
  });

  // 테마 초기화 (localStorage → OS 설정 → dark 기본)
  useEffect(() => { initTheme(); }, []);

  // 읽음 상태 동기화 (세션 선택 시 즉시 + 활성 세션 이벤트 도착 시 debounce)
  useReadPositionSync();

  // 브라우저 알림 (완료/에러/인터벤션)
  useNotification();

  // URL ↔ 스토어 동기화 (/{sessionId} 라우팅)
  useUrlSync();

  useEffect(() => {
    if (viewMode === "feed") {
      useDashboardStore.getState().setViewMode("folder");
    }
  }, [viewMode]);

  // 대시보드 프로필 설정 로드
  useDashboardConfig();

  // Soul Server 드레이닝 상태 폴링 (3초 간격)
  const { isDraining } = useServerStatus();

  // features.nodeGuard = true인 single-node 모드에서 /api/node-info로 현재 노드 판별
  // features.nodeGuard = false(orchestrator 모드)에서는 항상 false
  const { features } = useAppConfig();
  const activeSession = useDashboardStore((s) => s.activeSession);
  const [currentNodeId, setCurrentNodeId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!features.nodeGuard) return;
    fetch("/api/node-info")
      .then((r) => {
        if (!r.ok) throw new Error(`node-info: ${r.status}`);
        return r.json();
      })
      .then((data: { nodeId?: string }) => {
        if (data.nodeId) setCurrentNodeId(data.nodeId);
      })
      .catch(() => {
        // fetch 실패 → undefined 유지 → 판단 유보
      });
  }, [features.nodeGuard]);

  const isOtherNode = features.nodeGuard
    ? computeIsOtherNode(currentNodeId, activeSession?.nodeId)
    : false;
  const chatFileUploadUrl = isOtherNode ? undefined : "/attachments/sessions";

  // 세션 이동 후 빈 자리 보충 — 이동으로 폴더 표시 세션 수가 줄면 더 있으면 loadMore
  const handleMoveSessions = useCallback(
    async (sessionIds: string[], targetFolderId: string | null) => {
      const shouldBackfill = shouldLoadMoreAfterSessionMove({
        viewMode,
        selectedFolderId,
        catalog,
        sessionIds,
        targetFolderId,
      });
      await moveSessionsOptimistic(sessionIds, targetFolderId);
      if (hasMore && shouldBackfill) {
        loadMore();
      }
    },
    [catalog, hasMore, loadMore, selectedFolderId, viewMode],
  );

  // Config / Search 모달 상태
  const [configOpen, setConfigOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  return (
    <DashboardDndProvider
      onMoveSessions={handleMoveSessions}
      onReorderFolders={reorderFoldersOptimistic}
    >
    <DashboardShell
      title="Soul Dashboard"
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
        <FeedView
          placement="sidebar"
          onNewSession={() => openNewSessionModal("feed")}
          onLoadMore={loadMoreFeed}
          hasMore={feedHasMore}
          sessions={feedSessions}
        />
      }
      centerPanel={
        viewMode === "tasks" ? (
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
          chatInputDisabled={isOtherNode}
          fileUploadUrl={chatFileUploadUrl}
        />
      }
      connectionStatus={sseStatus}
      onSearchClick={() => setSearchOpen(true)}
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
          <ConfigButton variant="chrome" onClick={() => setConfigOpen(true)} />
          <ThemeToggle variant="chrome" />
        </>
      }
      mobileSessionsView={
        <FeedView
          onNewSession={() => openNewSessionModal("feed")}
          onLoadMore={loadMoreFeed}
          hasMore={feedHasMore}
          sessions={feedSessions}
        />
      }
      mobileFolderContents={
        // DashboardShell의 isMobile && selectedFolderId 조건이 표시 여부를 제어하므로
        // 항상 FolderContents를 전달한다. 조건부로 undefined를 전달하면 타이밍 이슈로 빈 화면이 보인다.
        <FolderWorkspaceView sessions={sessions} onLoadMore={loadMore} hasMore={hasMore} />
      }
      mobileTasksView={
        <TaskTreeView
          sessions={sessions}
          onNewSession={(task, defaults) => openNewSessionModal("feed", task ?? null, defaults ?? null)}
        />
      }
      onNewSession={() => openNewSessionModal("folder")}
      mobileChatHeader={(onBack) => <MobileChatHeader onBack={onBack} />}
      mobileChatView={
        <ChatView
          chatInputDisabled={isOtherNode}
          fileUploadUrl={chatFileUploadUrl}
          showHeader={false}
        />
      }
      mobileSettingsContent={
        <div className="p-4 space-y-4">
          <h2 className="text-base font-semibold">설정</h2>
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
          <NewSessionModal />
          <AskQuestionBanner />
        </>
      }
    />
    </DashboardDndProvider>
  );
}

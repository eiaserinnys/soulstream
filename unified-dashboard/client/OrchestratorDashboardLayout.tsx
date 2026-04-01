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

import { useState, useEffect, useMemo } from "react";
import { FolderContents } from "./components/FolderContents";
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
import {
  NodeGraph,
  SessionsTopBar,
  MobileChatHeader,
  VerticalSplitPane,
  ThemeToggle,
  useSessionProvider,
  useReadPositionSync,
  useNotification,
  useUrlSync,
  useDashboardConfig,
  useServerStatus,
  DashboardShell,
  FolderTree,
  RightPanel,
  ChatView,
  initTheme,
  useDashboardStore,
  ConnectionBadge,
  useSessionListProvider,
} from "@seosoyoung/soul-ui";
import { FeedView } from "./components/FeedView";
import { useAppConfig } from "./config/AppConfigContext";

export function OrchestratorDashboardLayout() {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const viewMode = useDashboardStore((s) => s.viewMode);
  const sessions = useDashboardStore((s) => s.sessions);
  const openNewSessionModal = useDashboardStore((s) => s.openNewSessionModal);
  const nodes = useOrchestratorStore((s) => s.nodes);
  const connectionStatus = useOrchestratorStore((s) => s.connectionStatus);

  const { features } = useAppConfig();

  // 테마 초기화
  useEffect(() => { initTheme(); }, []);

  // URL ↔ 스토어 동기화
  useUrlSync();

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
  const { folderCounts, hasMore, loadMore } = useSessionListProvider({
    intervalMs: 5000,
    getSessionProvider: () => orchestratorSessionProvider,
  });

  // 활성 세션 구독
  const { status: sseStatus } = useSessionProvider({
    sessionKey: activeSessionKey,
    getSessionProvider: () => orchestratorSessionProvider,
  });

  // 활성 세션의 노드가 없거나 disconnected이면 ChatInput 비활성화
  const isChatInputDisabled = useMemo(() => {
    if (!activeSessionKey) return false;
    const session = sessions.find((s) => s.agentSessionId === activeSessionKey);
    if (!session?.nodeId) return true;
    const node = nodes.get(session.nodeId);
    return !node || node.status === "disconnected";
  }, [activeSessionKey, sessions, nodes]);

  // Config / Search 모달 상태
  const [configOpen, setConfigOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  return (
    <DashboardShell
      title="Soulstream Orchestrator"
      leftPanel={
        <FolderTree
          onMoveSessions={moveSessionsOptimistic}
          onCreateFolder={createFolder}
          onRenameFolder={renameFolderOptimistic}
          onDeleteFolder={deleteFolderOptimistic}
          onUpdateFolderSettings={updateFolderSettingsOptimistic}
          onReorderFolders={reorderFoldersOptimistic}
          folderCounts={folderCounts}
        />
      }
      leftPanelBottom={features.nodePanel ? <NodePanel /> : undefined}
      leftBottomRatio={features.nodePanel ? 3 : undefined}
      centerPanel={
        viewMode === "feed" ? (
          <FeedView
            onNewSession={() => openNewSessionModal("feed")}
            onLoadMore={loadMore}
            hasMore={hasMore}
          />
        ) : (
          <>
            <SessionsTopBar />
            <VerticalSplitPane
              className="flex-1 overflow-hidden"
              top={<FolderContents onLoadMore={loadMore} hasMore={hasMore} />}
              bottom={
                <div className="flex-1 overflow-hidden h-full bg-muted/50 dark:bg-muted/30">
                  <NodeGraph />
                </div>
              }
            />
          </>
        )
      }
      rightPanel={<RightPanel chatInputDisabled={isChatInputDisabled} />}
      connectionStatus={connectionStatus ?? sseStatus}
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
          <ThemeToggle />
          <ConfigButton onClick={() => setConfigOpen(true)} />
        </>
      }
      mobileSessionsView={
        viewMode === "feed" ? (
          <FeedView
            onNewSession={() => openNewSessionModal("feed")}
            onLoadMore={loadMore}
            hasMore={hasMore}
          />
        ) : (
          <>
            <SessionsTopBar />
            <FolderContents onLoadMore={loadMore} hasMore={hasMore} />
          </>
        )
      }
      mobileChatHeader={(onBack) => <MobileChatHeader onBack={onBack} />}
      mobileChatView={<ChatView chatInputDisabled={isChatInputDisabled} />}
      mobileSheetFooter={
        <>
          <ThemeToggle />
          <ConnectionBadge status={sseStatus} />
        </>
      }
      modals={
        <>
          <ConfigModal open={configOpen} onOpenChange={setConfigOpen} />
          <SearchModal open={searchOpen} onOpenChange={setSearchOpen} />
          <OrchestratorNewSessionModal />
        </>
      }
    />
  );
}

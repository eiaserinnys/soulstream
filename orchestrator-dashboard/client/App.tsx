/**
 * OrchestratorDashboard - DashboardShell 기반 메인 레이아웃
 *
 * soul-ui의 DashboardShell 위에 orchestrator 전용 훅과 컴포넌트를 조합합니다.
 * 노드 SSE, 세션 목록/상세 Provider, 카탈로그 팩토리를 여기서 초기화합니다.
 */

import { useEffect, useMemo } from "react";
import {
  DashboardShell,
  FolderTree,
  FolderContents,
  FeedView,
  RightPanel,
  SessionsTopBar,
  VerticalSplitPane,
  NodeGraph,
  ThemeToggle,
  initTheme,
  useDashboardStore,
  createFolderOperations,
  createMoveSessionsOperations,
  useSessionListProvider,
  useSessionProvider,
  useUrlSync,
  useReadPositionSync,
} from "@seosoyoung/soul-ui";
import { useOrchestratorStore } from "./store/orchestrator-store";
import { NodePanel } from "./components/NodePanel";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { useNodes } from "./hooks/useNodes";
import { orchestratorSessionProvider } from "./providers/OrchestratorSessionProvider";
import { renameSessionOptimistic } from "./lib/rename-session";

// === 팩토리 인스턴스 (모듈 레벨 싱글턴) ===

const folderOps = createFolderOperations({
  createUrl: "/api/folders",
  updateUrl: (id) => `/api/folders/${id}`,
  deleteUrl: (id) => `/api/folders/${id}`,
  // deleteFallbackFolderName 미지정 → 인덱스 기반 폴백
});

const moveOps = createMoveSessionsOperations({
  batchUrl: "/api/sessions/folder",
  batchMethod: "PATCH",
  // singleUrl 없음 → 항상 batch
});

export function App() {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const viewMode = useDashboardStore((s) => s.viewMode);
  const sessions = useDashboardStore((s) => s.sessions);
  const openNewSessionModal = useDashboardStore((s) => s.openNewSessionModal);
  const nodes = useOrchestratorStore((s) => s.nodes);

  // 스토리지 모드를 SSE로 설정
  useEffect(() => {
    useDashboardStore.getState().setStorageMode("sse");
  }, []);

  // 테마 초기화
  useEffect(() => { initTheme(); }, []);

  // URL 해시 ↔ activeSessionKey 동기화
  useUrlSync();

  // 읽음 위치 동기화 (unread 배지/볼드)
  useReadPositionSync();

  // 노드 SSE → orchestrator-store
  useNodes();

  // 세션 목록 구독 (SSE 모드: 실시간)
  const { folderCounts, hasMore, loadMore } = useSessionListProvider({
    intervalMs: 5000,
    getSessionProvider: () => orchestratorSessionProvider,
  });

  // 30초마다 세션 목록 전체 재조회 (SSE 누락 대비 안전망)
  // TODO: soul-ui가 "SSE 유지 + 독립 폴링" 옵션을 지원하면 이 useEffect를 제거하고
  //       useSessionListProvider의 공식 옵션으로 교체한다.
  useEffect(() => {
    const refresh = async () => {
      try {
        const result = await orchestratorSessionProvider.fetchSessions();
        useDashboardStore.getState().setSessions(result.sessions);
      } catch {
        // 갱신 실패는 조용히 무시 (SSE가 주 경로이므로 fallback 실패는 치명적이지 않음)
      }
    };

    // Effect 1(useSessionListProvider 내부)에서 마운트 시 이미 초기 fetch를 수행하므로,
    // 여기서는 interval만 설정하고 마운트 즉시 호출은 생략한다.
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, []);

  // 활성 세션 구독 (Provider 기반)
  useSessionProvider({
    sessionKey: activeSessionKey,
    getSessionProvider: () => orchestratorSessionProvider,
  });

  const connectionStatus = useOrchestratorStore((s) => s.connectionStatus);

  // 활성 세션의 노드가 없거나 disconnected이면 ChatInput 비활성화
  // removeNode가 Map에서 노드를 삭제하므로 !node 체크가 핵심
  const isChatInputDisabled = useMemo(() => {
    if (!activeSessionKey) return false;
    const session = sessions.find((s) => s.agentSessionId === activeSessionKey);
    if (!session?.nodeId) return true;
    const node = nodes.get(session.nodeId);
    return !node || node.status === "disconnected";
  }, [activeSessionKey, sessions, nodes]);

  return (
    <DashboardShell
      title="Soulstream Orchestrator"
      headerRight={<ThemeToggle />}
      leftPanel={
        <FolderTree
          onMoveSessions={moveOps.moveSessionsOptimistic}
          onCreateFolder={folderOps.createFolder}
          onRenameFolder={folderOps.renameFolderOptimistic}
          onDeleteFolder={folderOps.deleteFolderOptimistic}
          folderCounts={folderCounts}
        />
      }
      leftPanelBottom={<NodePanel />}
      leftBottomRatio={3}
      centerPanel={
        viewMode === "feed" ? (
          <FeedView
            onNewSession={() => openNewSessionModal('feed')}
            onLoadMore={loadMore}
            hasMore={hasMore}
            onRenameSession={renameSessionOptimistic}
            onMoveSessions={moveOps.moveSessionsOptimistic}
          />
        ) : (
          <>
            <SessionsTopBar />
            <VerticalSplitPane
              className="flex-1 overflow-hidden"
              top={
                <FolderContents
                  onMoveSessions={moveOps.moveSessionsOptimistic}
                  onRenameSession={renameSessionOptimistic}
                />
              }
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
      connectionStatus={connectionStatus}
      modals={<NewSessionDialog />}
    />
  );
}

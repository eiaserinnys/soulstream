/**
 * DashboardLayout - unified-dashboard 메인 레이아웃 (single-node 모드)
 *
 * DashboardShell 위에 unified-dashboard 전용 훅과 컴포넌트를 조합한다.
 * 레이아웃 구조(3패널 리사이즈, 모바일 반응형)는 DashboardShell이 담당한다.
 *
 * soul-dashboard 대비 변경 사항:
 * - node-info 엔드포인트 제거 (BFF 없음) → isOtherNode = false 고정
 * - serendipityAvailable 로드 제거 (세렌디피티 기능 미사용)
 * - StorageModeToggleCompact 제거 (세렌디피티 관련)
 * - ConfigModal / SearchModal / NewSessionModal / DrainBanner 추가 (Phase 4)
 */

import { useState, useEffect } from "react";
import { FolderContents } from "./components/FolderContents";
import {
  createFolder,
  renameFolderOptimistic,
  deleteFolderOptimistic,
} from "./lib/folder-operations";
import { moveSessionsOptimistic } from "./lib/move-sessions";
import { computeIsOtherNode } from "./lib/node-guard";
import { NewSessionModal } from "./components/NewSessionModal";
import { ConfigButton } from "./components/ConfigButton";
import { ConfigModal } from "./components/ConfigModal";
import { SearchModal } from "./components/SearchModal";
import { useAppConfig } from "./config/AppConfigContext";
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
  FeedView,
  RightPanel,
  ChatView,
  initTheme,
  useDashboardStore,
  ConnectionBadge,
  useSessionListProvider,
} from "@seosoyoung/soul-ui";
import { getSessionProvider } from "./providers";

export function DashboardLayout() {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const viewMode = useDashboardStore((s) => s.viewMode);
  const openNewSessionModal = useDashboardStore((s) => s.openNewSessionModal);

  // 세션 목록 구독 (SSE 모드: 실시간)
  const { folderCounts, hasMore, loadMore } = useSessionListProvider({
    intervalMs: 5000,
    getSessionProvider,
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

  // Config / Search 모달 상태
  const [configOpen, setConfigOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  return (
    <DashboardShell
      title="Soul Dashboard"
      leftPanel={
        <FolderTree
          onMoveSessions={moveSessionsOptimistic}
          onCreateFolder={createFolder}
          onRenameFolder={renameFolderOptimistic}
          onDeleteFolder={deleteFolderOptimistic}
          folderCounts={folderCounts}
        />
      }
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
      rightPanel={<RightPanel chatInputDisabled={isOtherNode} />}
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
      mobileChatView={<ChatView chatInputDisabled={isOtherNode} />}
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
          <NewSessionModal />
        </>
      }
    />
  );
}

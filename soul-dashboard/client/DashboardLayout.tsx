/**
 * DashboardLayout - Soul Dashboard 메인 레이아웃
 *
 * DashboardShell 위에 soul-dashboard 전용 훅과 컴포넌트를 조합합니다.
 * 레이아웃 구조(3패널 리사이즈, 모바일 반응형)는 DashboardShell이 담당합니다.
 */

import { useState, useEffect } from "react";
import { FolderContents } from "./components/FolderContents";
import { createFolder, renameFolderOptimistic, deleteFolderOptimistic, updateFolderSettingsOptimistic } from "./lib/folder-operations";
import { moveSessionsOptimistic } from "./lib/move-sessions";
import { computeIsOtherNode } from "./lib/node-guard";
import { NodeGraph, SessionsTopBar, MobileChatHeader, VerticalSplitPane, StorageModeToggleCompact, ThemeToggle, useSessionProvider, useReadPositionSync } from "@seosoyoung/soul-ui";
import { NewSessionModal } from "./components/NewSessionModal";
import { ConfigButton } from "./components/ConfigButton";
import { ConfigModal } from "./components/ConfigModal";
import { SearchModal } from "./components/SearchModal";
import { useSessionListProvider } from "./hooks/useSessionListProvider";
import { getSessionProvider } from "./providers";
import { useNotification } from "./hooks/useNotification";
import { useUrlSync } from "./hooks/useUrlSync";
import { useDashboardConfig } from "./hooks/useDashboardConfig";
import { useServerStatus } from "./hooks/useServerStatus";
import {
  DashboardShell,
  FolderTree,
  FeedView,
  RightPanel,
  ChatView,
  initTheme,
  useDashboardStore,
  ConnectionBadge,
} from "@seosoyoung/soul-ui";

export function DashboardLayout() {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const viewMode = useDashboardStore((s) => s.viewMode);
  const setSerendipityAvailable = useDashboardStore((s) => s.setSerendipityAvailable);
  const openNewSessionModal = useDashboardStore((s) => s.openNewSessionModal);

  // 세션 목록 구독 (SSE 모드: 실시간, Serendipity 모드: 폴링)
  const { sessions, loading, error, folderCounts, hasMore, loadMore } = useSessionListProvider({ intervalMs: 5000, getSessionProvider });

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

  // 서버 설정 로드 (세렌디피티 가용 여부)
  useEffect(() => {
    fetch("/api/config/settings")
      .then((res) => {
        if (!res.ok) throw new Error(`Config fetch failed: ${res.status}`);
        return res.json();
      })
      .then((config: { serendipityAvailable?: boolean }) => {
        setSerendipityAvailable(!!config.serendipityAvailable);
      })
      .catch(() => {
        // config 로드 실패 시 기본값 유지 (false)
      });
  }, [setSerendipityAvailable]);

  // 현재 soul-server의 nodeId (다른 노드 세션 판별용)
  const activeSession = useDashboardStore((s) => s.activeSession);
  const [currentNodeId, setCurrentNodeId] = useState<string | undefined>(undefined);
  useEffect(() => {
    fetch("/api/node-info")
      .then((r) => {
        if (!r.ok) throw new Error(`node-info: ${r.status}`);
        return r.json();
      })
      .then((data: { nodeId?: string }) => {
        if (data.nodeId) setCurrentNodeId(data.nodeId);
        // nodeId 없으면 undefined 유지 → 판단 유보
      })
      .catch(() => {
        // fetch 실패 → undefined 유지 → 판단 유보
      });
  }, []);

  // 다른 노드 세션이면 채팅 입력 비활성화
  // currentNodeId가 undefined(미로드/오류)면 판단 유보 → false
  const isOtherNode = computeIsOtherNode(currentNodeId, activeSession?.nodeId);

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
          onUpdateFolderSettings={updateFolderSettingsOptimistic}
          folderCounts={folderCounts}
        />
      }
      centerPanel={
        viewMode === "feed" ? (
          <FeedView onNewSession={() => openNewSessionModal('feed')} onLoadMore={loadMore} hasMore={hasMore} />
        ) : (
          <>
            <SessionsTopBar />
            <VerticalSplitPane
              className="flex-1 overflow-hidden"
              top={<FolderContents />}
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
      headerRight={
        <>
          <ThemeToggle />
          <ConfigButton onClick={() => setConfigOpen(true)} />
          <StorageModeToggleCompact />
        </>
      }
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
      mobileSessionsView={
        viewMode === "feed" ? (
          <FeedView onNewSession={() => openNewSessionModal('feed')} onLoadMore={loadMore} hasMore={hasMore} />
        ) : (
          <>
            <SessionsTopBar />
            <FolderContents />
          </>
        )
      }
      mobileChatHeader={(onBack) => <MobileChatHeader onBack={onBack} />}
      mobileChatView={<ChatView chatInputDisabled={isOtherNode} />}
      mobileSheetFooter={
        <>
          <ThemeToggle />
          <StorageModeToggleCompact />
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

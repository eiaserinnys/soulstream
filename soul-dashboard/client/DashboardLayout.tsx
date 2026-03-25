/**
 * DashboardLayout - Soul Dashboard 메인 레이아웃
 *
 * DashboardShell 위에 soul-dashboard 전용 훅과 컴포넌트를 조합합니다.
 * 레이아웃 구조(3패널 리사이즈, 모바일 반응형)는 DashboardShell이 담당합니다.
 */

import { useState, useEffect } from "react";
import { FolderContents } from "./components/FolderContents";
import { createFolder, renameFolderOptimistic, deleteFolderOptimistic } from "./lib/folder-operations";
import { moveSessionsOptimistic } from "./lib/move-sessions";
import { SessionsTopBar } from "./components/SessionsTopBar";
import { MobileChatHeader } from "./components/MobileChatHeader";
import { VerticalSplitPane } from "./components/VerticalSplitPane";
import { NodeGraph } from "@seosoyoung/soul-ui";
import { NewSessionModal } from "./components/NewSessionModal";
import { StorageModeToggleCompact } from "./components/StorageModeToggle";
import { ThemeToggle } from "./components/ThemeToggle";
import { ConfigButton } from "./components/ConfigButton";
import { ConfigModal } from "./components/ConfigModal";
import { SearchModal } from "./components/SearchModal";
import { useSessionListProvider } from "./hooks/useSessionListProvider";
import { useSessionProvider } from "./hooks/useSessionProvider";
import { getSessionProvider } from "./providers";
import { useReadPositionSync } from "@seosoyoung/soul-ui";
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

  // 세션 목록 구독 (SSE 모드: 실시간, Serendipity 모드: 폴링)
  const { sessions, loading, error } = useSessionListProvider({ intervalMs: 5000, getSessionProvider });

  // 활성 세션 구독 (Provider 기반)
  const { status: sseStatus } = useSessionProvider({
    sessionKey: activeSessionKey,
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
        />
      }
      centerPanel={
        viewMode === "feed" ? (
          <FeedView />
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
      rightPanel={<RightPanel />}
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
          <FeedView />
        ) : (
          <>
            <SessionsTopBar />
            <FolderContents />
          </>
        )
      }
      mobileChatHeader={(onBack) => <MobileChatHeader onBack={onBack} />}
      mobileChatView={<ChatView />}
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

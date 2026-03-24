/**
 * OrchestratorDashboard - DashboardShell 기반 메인 레이아웃
 *
 * soul-ui의 DashboardShell 위에 orchestrator 전용 훅과 컴포넌트를 조합합니다.
 * 노드 SSE, 세션 폴링, 카탈로그 동기화를 여기서 초기화합니다.
 */

import { useEffect } from "react";
import {
  DashboardShell,
  FolderTree,
  FolderContents,
  RightPanel,
  initTheme,
  useDashboardStore,
  createFolderOperations,
  createMoveSessionsOperations,
} from "@seosoyoung/soul-ui";
import { useOrchestratorStore } from "./store/orchestrator-store";
import { NodePanel } from "./components/NodePanel";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { useNodes } from "./hooks/useNodes";
import { useSessions } from "./hooks/useSessions";
import { useCatalog } from "./hooks/useCatalog";
import { useSessionStream } from "./hooks/useSessionStream";

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
  // 스토리지 모드를 SSE로 설정
  useEffect(() => {
    useDashboardStore.getState().setStorageMode("sse");
  }, []);

  // 테마 초기화
  useEffect(() => { initTheme(); }, []);

  // 노드 SSE → orchestrator-store
  useNodes();
  // 세션 폴링 → orchestrator-store
  useSessions();
  // 카탈로그 초기화 → useDashboardStore
  useCatalog();
  // 세션 SSE → useDashboardStore (ChatView/RightPanel 연동)
  useSessionStream();

  const connectionStatus = useOrchestratorStore((s) => s.connectionStatus);

  return (
    <DashboardShell
      title="Soulstream Orchestrator"
      leftPanel={
        <FolderTree
          onMoveSessions={moveOps.moveSessionsOptimistic}
          onCreateFolder={folderOps.createFolder}
          onRenameFolder={folderOps.renameFolderOptimistic}
          onDeleteFolder={folderOps.deleteFolderOptimistic}
        />
      }
      leftPanelBottom={<NodePanel />}
      leftBottomRatio={3}
      centerPanel={
        <FolderContents
          onMoveSessions={moveOps.moveSessionsOptimistic}
        />
      }
      rightPanel={<RightPanel />}
      connectionStatus={connectionStatus}
      modals={<NewSessionDialog />}
    />
  );
}

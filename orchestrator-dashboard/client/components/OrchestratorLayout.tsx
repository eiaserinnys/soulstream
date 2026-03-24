/**
 * OrchestratorLayout — 메인 레이아웃.
 *
 * 구조:
 *   TopBar
 *   ┌─────────────────────┬──────────────────┐
 *   │ 좌측 (30%)          │ 우측 (70%)       │
 *   │ ┌─────────────────┐ │                  │
 *   │ │ FolderTree(70%) │ │   ChatPanel      │
 *   │ ├─────────────────┤ │                  │
 *   │ │  NodePanel(30%) │ │                  │
 *   │ └─────────────────┘ │                  │
 *   └─────────────────────┴──────────────────┘
 */

import { useEffect, useMemo } from "react";
import {
  useDashboardStore,
  FolderTree,
  createFolderOperations,
  createMoveSessionsOperations,
} from "@seosoyoung/soul-ui";
import { TopBar } from "./TopBar";
import { NodePanel } from "./NodePanel";
import { ChatPanel } from "./ChatPanel";
import { useNodes } from "../hooks/useNodes";
import { useSessions } from "../hooks/useSessions";
import { useCatalog } from "../hooks/useCatalog";
import { ORCHESTRATOR_API } from "../lib/api-config";

export function OrchestratorLayout() {
  // soul-ui 스토리지 모드 설정
  useEffect(() => {
    useDashboardStore.getState().setStorageMode("sse");
  }, []);

  // 팩토리에서 CRUD operations 생성
  const folderOps = useMemo(() => createFolderOperations(ORCHESTRATOR_API), []);
  const moveOps = useMemo(() => createMoveSessionsOperations(ORCHESTRATOR_API), []);

  // 노드/세션/카탈로그 훅
  useNodes();
  useSessions();
  useCatalog();

  return (
    <div className="w-screen h-screen flex flex-col overflow-hidden">
      <TopBar />
      <div className="flex-1 flex overflow-hidden">
        {/* 좌측: FolderTree(상 70%) + NodePanel(하 30%) */}
        <div className="w-[30%] flex flex-col overflow-hidden border-r border-border">
          {/* FolderTree — 70% */}
          <div className="flex-[7] flex flex-col overflow-hidden min-h-0">
            <FolderTree
              onMoveSessions={(ids, folderId) =>
                moveOps.moveSessionsOptimistic(ids, folderId)
              }
              onCreateFolder={(name) => folderOps.createFolder(name)}
              onRenameFolder={(folderId, newName) =>
                folderOps.renameFolderOptimistic(folderId, newName)
              }
              onDeleteFolder={(folderId) =>
                folderOps.deleteFolderOptimistic(folderId)
              }
            />
          </div>

          {/* NodePanel — 30% */}
          <div className="flex-[3] flex flex-col overflow-hidden min-h-0 border-t border-border">
            <div className="px-3 py-1.5 shrink-0 border-b border-border">
              <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">
                Nodes
              </span>
            </div>
            <NodePanel />
          </div>
        </div>

        {/* 우측: ChatPanel */}
        <div className="flex-1 flex flex-col bg-popover overflow-hidden">
          <ChatPanel />
        </div>
      </div>
    </div>
  );
}

/**
 * FolderTree - 폴더 카탈로그 트리 컴포넌트
 *
 * 왼쪽 패널에서 폴더 목록을 표시하고 폴더 선택/생성/삭제를 관리한다.
 */

import { useState, useCallback, useMemo } from "react";
import { useDashboardStore, cn, Button, Badge, SYSTEM_FOLDERS } from "@seosoyoung/soul-ui";
import { moveSessionsOptimistic } from "client/lib/move-sessions";
import {
  createFolder,
  renameFolderOptimistic,
  deleteFolderOptimistic,
} from "client/lib/folder-operations";

const SYSTEM_FOLDER_NAMES = new Set(Object.values(SYSTEM_FOLDERS));

export function FolderTree() {
  const catalog = useDashboardStore((s) => s.catalog);
  const catalogVersion = useDashboardStore((s) => s.catalogVersion);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const selectFolder = useDashboardStore((s) => s.selectFolder);
  const sessions = useDashboardStore((s) => s.sessions);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const handleDrop = useCallback(async (folderId: string | null, e: React.DragEvent) => {
    e.preventDefault();
    setDragOverId(null);
    try {
      const ids: string[] = JSON.parse(e.dataTransfer.getData("text/plain"));
      await moveSessionsOptimistic(ids, folderId);
    } catch {
      // JSON parse error — ignore
    }
  }, []);

  const getSessionCount = useCallback(
    (folderId: string | null) => {
      if (!catalog) return 0;
      return sessions.filter((s) => {
        const assignment = catalog.sessions[s.agentSessionId];
        if (folderId === null) {
          return !assignment || assignment.folderId === null;
        }
        return assignment?.folderId === folderId;
      }).length;
    },
    [catalog, sessions, catalogVersion],
  );

  const handleCreateFolder = async () => {
    const name = prompt("새 폴더 이름:");
    if (!name?.trim()) return;
    await createFolder(name.trim());
  };

  const handleDeleteFolder = async (folderId: string, folderName: string) => {
    if (!confirm(`'${folderName}' 폴더를 삭제하시겠습니까?\n폴더 내 세션은 미분류로 이동됩니다.`)) return;
    await deleteFolderOptimistic(folderId);
  };

  const handleDoubleClick = (folderId: string, currentName: string) => {
    setEditingId(folderId);
    setEditName(currentName);
  };

  const handleRenameSubmit = async (folderId: string) => {
    if (editName.trim()) {
      await renameFolderOptimistic(folderId, editName.trim());
    }
    setEditingId(null);
  };

  /** 폴더 선택 시 해당 폴더의 첫 세션을 자동 선택한다 */
  const handleSelectFolder = useCallback((folderId: string | null) => {
    const store = useDashboardStore.getState();
    // 폴더 선택을 먼저 명시적으로 설정 (setActiveSession의 early return과 무관하게)
    selectFolder(folderId);
    const folderSessions = store.getSessionsInFolder(folderId);
    if (folderSessions.length > 0) {
      store.setActiveSession(folderSessions[0].agentSessionId);
    } else {
      store.clearActiveSession();
    }
  }, [selectFolder]);

  const allFolders = catalog?.folders ?? [];
  const { normalFolders, systemFolders } = useMemo(() => {
    const normal = allFolders.filter((f) => !SYSTEM_FOLDER_NAMES.has(f.name));
    const system = allFolders.filter((f) => SYSTEM_FOLDER_NAMES.has(f.name));
    return { normalFolders: normal, systemFolders: system };
  }, [allFolders]);

  const renderFolder = (folder: typeof allFolders[number]) => (
    <div
      key={folder.id}
      className={cn(
        "flex items-center justify-between px-3 py-1.5 cursor-pointer text-sm hover:bg-accent/50 group",
        selectedFolderId === folder.id && "bg-accent text-accent-foreground",
        dragOverId === folder.id && "ring-2 ring-primary",
      )}
      onClick={() => handleSelectFolder(folder.id)}
      onDoubleClick={() => handleDoubleClick(folder.id, folder.name)}
      onContextMenu={(e) => {
        e.preventDefault();
        handleDeleteFolder(folder.id, folder.name);
      }}
      onDragOver={(e) => { e.preventDefault(); setDragOverId(folder.id); }}
      onDragLeave={() => setDragOverId(null)}
      onDrop={(e) => handleDrop(folder.id, e)}
    >
      {editingId === folder.id ? (
        <input
          autoFocus
          className="flex-1 bg-transparent border-b border-primary outline-none text-sm"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={() => handleRenameSubmit(folder.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleRenameSubmit(folder.id);
            if (e.key === "Escape") setEditingId(null);
          }}
        />
      ) : (
        <span className="truncate">{folder.name}</span>
      )}
      <Badge variant="secondary" className="ml-2 text-xs">
        {getSessionCount(folder.id)}
      </Badge>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-sm font-medium">Folders</span>
        <Button variant="ghost" size="sm" onClick={handleCreateFolder} title="New folder">
          +
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {/* 일반 폴더 */}
        {normalFolders.map(renderFolder)}

        {/* 구분선 (일반 폴더가 1개 이상일 때만) */}
        {normalFolders.length > 0 && (
          <div className="border-t border-border my-1 mx-3" />
        )}

        {/* 시스템 폴더 */}
        {systemFolders.map(renderFolder)}

        {/* 미분류 */}
        <div
          className={cn(
            "flex items-center justify-between px-3 py-1.5 cursor-pointer text-sm hover:bg-accent/50",
            selectedFolderId === null && "bg-accent text-accent-foreground",
            dragOverId === "__null__" && "ring-2 ring-primary",
          )}
          onClick={() => handleSelectFolder(null)}
          onDragOver={(e) => { e.preventDefault(); setDragOverId("__null__"); }}
          onDragLeave={() => setDragOverId(null)}
          onDrop={(e) => handleDrop(null, e)}
        >
          <span className="truncate text-muted-foreground">Uncategorized</span>
          <Badge variant="secondary" className="ml-2 text-xs">
            {getSessionCount(null)}
          </Badge>
        </div>
      </div>
    </div>
  );
}

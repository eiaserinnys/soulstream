/**
 * FolderTree - 폴더 카탈로그 트리 컴포넌트
 *
 * 왼쪽 패널에서 폴더 목록을 표시하고 폴더 선택/생성/삭제를 관리한다.
 */

import { useState, useCallback, useMemo } from "react";
import { useDashboardStore, isSessionUnread, cn, Button, Badge, Spinner, SYSTEM_FOLDERS } from "@seosoyoung/soul-ui";
import { Plus } from "lucide-react";
import { moveSessionsOptimistic } from "client/lib/move-sessions";
import {
  createFolder,
  renameFolderOptimistic,
  deleteFolderOptimistic,
} from "client/lib/folder-operations";
import { FolderDialog } from "./FolderDialog";

const SYSTEM_FOLDER_NAMES: Set<string> = new Set(Object.values(SYSTEM_FOLDERS));

export function FolderTree() {
  const catalog = useDashboardStore((s) => s.catalog);
  const catalogVersion = useDashboardStore((s) => s.catalogVersion);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const selectFolder = useDashboardStore((s) => s.selectFolder);
  const sessions = useDashboardStore((s) => s.sessions);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

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

  const getUnreadCount = useCallback(
    (folderId: string | null) => {
      if (!catalog) return 0;
      return sessions.filter((s) => {
        const assignment = catalog.sessions[s.agentSessionId];
        if (folderId === null) {
          return (!assignment || assignment.folderId === null) && isSessionUnread(s);
        }
        return assignment?.folderId === folderId && isSessionUnread(s);
      }).length;
    },
    [catalog, sessions, catalogVersion],
  );

  const handleCreateFolder = async (name: string) => {
    try {
      await createFolder(name.trim());
      setCreateDialogOpen(false);
    } catch {
      // API 에러는 folder-operations 내부에서 console.error로 보고됨
    }
  };

  const handleDeleteFolder = async () => {
    if (!deleteTarget) return;
    try {
      await deleteFolderOptimistic(deleteTarget.id);
      setDeleteTarget(null);
    } catch {
      // API 에러는 folder-operations 내부에서 console.error로 보고됨
    }
  };

  const runningFolderIds = useMemo(() => {
    if (!catalog) return new Set<string>();
    const set = new Set<string>();
    for (const s of sessions) {
      if (s.status === "running") {
        const fid = catalog.sessions[s.agentSessionId]?.folderId;
        if (fid) set.add(fid);
      }
    }
    return set;
  }, [catalog, sessions, catalogVersion]);

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
        setDeleteTarget({ id: folder.id, name: folder.name });
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
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="truncate">{folder.name}</span>
          {runningFolderIds.has(folder.id) && (
            <Spinner className="h-3 w-3 shrink-0" />
          )}
        </div>
      )}
      {(() => {
        const unreadCount = getUnreadCount(folder.id);
        return unreadCount > 0 ? (
          <Badge variant="destructive" className="ml-2 text-xs font-bold">
            {unreadCount}
          </Badge>
        ) : (
          <Badge variant="secondary" className="ml-2 text-xs">
            {getSessionCount(folder.id)}
          </Badge>
        );
      })()}
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-sm font-medium">Folders</span>
        <Button variant="ghost" size="icon" onClick={() => setCreateDialogOpen(true)} title="New folder">
          <Plus className="h-3.5 w-3.5" />
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

        {/* PostgreSQL 모드: 모든 세션이 기본 폴더에 자동 배정되므로 Uncategorized 불필요 */}
      </div>

      <FolderDialog
        mode="create"
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onConfirm={handleCreateFolder}
      />
      <FolderDialog
        mode="delete"
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        onConfirm={handleDeleteFolder}
        folderName={deleteTarget?.name ?? ""}
      />
    </div>
  );
}

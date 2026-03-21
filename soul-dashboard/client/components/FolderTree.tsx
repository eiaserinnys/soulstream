/**
 * FolderTree - 폴더 카탈로그 트리 컴포넌트
 *
 * 왼쪽 패널에서 폴더 목록을 표시하고 폴더 선택/생성/삭제를 관리한다.
 */

import { useState, useCallback } from "react";
import { useDashboardStore, cn, Button, Badge } from "@seosoyoung/soul-ui";

export function FolderTree() {
  const catalog = useDashboardStore((s) => s.catalog);
  const catalogVersion = useDashboardStore((s) => s.catalogVersion);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const selectFolder = useDashboardStore((s) => s.selectFolder);
  const sessions = useDashboardStore((s) => s.sessions);
  const startCompose = useDashboardStore((s) => s.startCompose);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const handleDrop = useCallback(async (folderId: string | null, e: React.DragEvent) => {
    e.preventDefault();
    setDragOverId(null);
    try {
      const ids: string[] = JSON.parse(e.dataTransfer.getData("text/plain"));
      if (ids.length === 1) {
        await fetch(`/api/catalog/sessions/${ids[0]}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folderId }),
        });
      } else if (ids.length > 1) {
        await fetch("/api/catalog/sessions/batch", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionIds: ids, folderId }),
        });
      }
    } catch {
      // SSE will sync state
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
    await fetch("/api/catalog/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
  };

  const handleDeleteFolder = async (folderId: string, folderName: string) => {
    if (!confirm(`'${folderName}' 폴더를 삭제하시겠습니까?\n폴더 내 세션은 미분류로 이동됩니다.`)) return;
    await fetch(`/api/catalog/folders/${folderId}`, { method: "DELETE" });
    if (selectedFolderId === folderId) {
      selectFolder(null);
    }
  };

  const handleDoubleClick = (folderId: string, currentName: string) => {
    setEditingId(folderId);
    setEditName(currentName);
  };

  const handleRenameSubmit = async (folderId: string) => {
    if (editName.trim()) {
      await fetch(`/api/catalog/folders/${folderId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName.trim() }),
      });
    }
    setEditingId(null);
  };

  /** 폴더 선택 시 해당 폴더의 첫 세션을 자동 선택한다 */
  const handleSelectFolder = useCallback((folderId: string | null) => {
    const store = useDashboardStore.getState();
    const folderSessions = store.getSessionsInFolder(folderId);
    if (folderSessions.length > 0) {
      // 첫 번째 세션 활성화 → setActiveSession이 selectedFolderId도 갱신
      store.setActiveSession(folderSessions[0].agentSessionId);
    } else {
      // 빈 폴더: 폴더만 선택하고 세션 해제
      selectFolder(folderId);
      store.clearActiveSession();
    }
  }, [selectFolder]);

  const folders = catalog?.folders ?? [];

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-sm font-medium">Folders</span>
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={handleCreateFolder} title="New folder">
            +
          </Button>
          <Button variant="ghost" size="sm" onClick={() => startCompose()} title="New session">
            New
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {folders.map((folder) => (
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
        ))}

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

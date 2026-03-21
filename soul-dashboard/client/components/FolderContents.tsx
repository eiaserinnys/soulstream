/**
 * FolderContents - 선택된 폴더의 세션 목록
 *
 * 폴더 내 세션을 가상 스크롤로 표시. DnD/다중선택/인라인편집 지원.
 */

import { useMemo, useRef, useState, memo, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { moveSessionsOptimistic } from "client/lib/move-sessions";
import {
  useDashboardStore,
  cn,
  Badge,
  type SessionSummary,
} from "@seosoyoung/soul-ui";

const STATUS_COLORS: Record<string, string> = {
  running: "bg-green-500",
  completed: "bg-blue-500",
  error: "bg-red-500",
  interrupted: "bg-yellow-500",
};

const SessionItem = memo(function SessionItem({
  session,
  isActive,
  isSelected,
  isEditing,
  onClick,
  onContextMenu,
  onDragStart,
  onEditSubmit,
  onEditCancel,
}: {
  session: SessionSummary;
  isActive: boolean;
  isSelected: boolean;
  isEditing: boolean;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onEditSubmit: (name: string) => void;
  onEditCancel: () => void;
}) {
  const [editValue, setEditValue] = useState(session.displayName ?? "");

  const displayText =
    session.displayName ||
    session.lastMessage?.preview ||
    session.prompt ||
    session.agentSessionId;

  const timeStr = session.updatedAt
    ? new Date(session.updatedAt).toLocaleString()
    : "";

  return (
    <div
      draggable
      className={cn(
        "flex items-center gap-2 px-3 py-2 cursor-pointer text-sm hover:bg-accent/50 border-b border-border/50",
        isActive && "bg-accent text-accent-foreground",
        isSelected && !isActive && "bg-primary/10",
      )}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDragStart={onDragStart}
      data-session-id={session.agentSessionId}
    >
      <div
        className={cn("w-2 h-2 rounded-full shrink-0", STATUS_COLORS[session.status] ?? "bg-gray-400")}
      />
      <div className="flex-1 min-w-0">
        {isEditing ? (
          <input
            autoFocus
            className="w-full bg-transparent border-b border-primary outline-none text-sm"
            defaultValue={session.displayName ?? ""}
            onBlur={(e) => onEditSubmit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onEditSubmit((e.target as HTMLInputElement).value);
              if (e.key === "Escape") onEditCancel();
            }}
          />
        ) : (
          <div className="truncate">{displayText}</div>
        )}
        <div className="text-xs text-muted-foreground truncate">{timeStr}</div>
      </div>
      <Badge variant="outline" className="text-xs shrink-0">
        {session.status}
      </Badge>
    </div>
  );
});

export function FolderContents() {
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const getSessionsInFolder = useDashboardStore((s) => s.getSessionsInFolder);
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const toggleSessionSelection = useDashboardStore((s) => s.toggleSessionSelection);
  const selectedSessionIds = useDashboardStore((s) => s.selectedSessionIds);
  const editingSessionId = useDashboardStore((s) => s.editingSessionId);
  const setEditingSession = useDashboardStore((s) => s.setEditingSession);
  const catalogVersion = useDashboardStore((s) => s.catalogVersion);
  const sessions = useDashboardStore((s) => s.sessions);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    sessionId: string;
  } | null>(null);

  const folderSessions = useMemo(
    () => getSessionsInFolder(selectedFolderId),
    [selectedFolderId, getSessionsInFolder, catalogVersion, sessions],
  );

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: folderSessions.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56,
    overscan: 5,
  });

  const handleDragStart = useCallback(
    (sessionId: string, e: React.DragEvent) => {
      const ids = selectedSessionIds.has(sessionId)
        ? Array.from(selectedSessionIds)
        : [sessionId];
      e.dataTransfer.setData("text/plain", JSON.stringify(ids));
      e.dataTransfer.effectAllowed = "move";
    },
    [selectedSessionIds],
  );

  const handleContextMenu = useCallback(
    (sessionId: string, e: React.MouseEvent) => {
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, sessionId });
    },
    [],
  );

  const handleEditSubmit = useCallback(
    async (sessionId: string, name: string) => {
      const displayName = name.trim() || null;
      await fetch(`/api/catalog/sessions/${sessionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
      setEditingSession(null);
    },
    [setEditingSession],
  );

  const handleMoveToFolder = useCallback(
    async (targetFolderId: string | null) => {
      const sessionId = contextMenu?.sessionId;
      if (!sessionId) return;
      const ids = selectedSessionIds.has(sessionId)
        ? Array.from(selectedSessionIds)
        : [sessionId];
      setContextMenu(null);
      await moveSessionsOptimistic(ids, targetFolderId);
    },
    [selectedSessionIds, contextMenu],
  );

  const catalog = useDashboardStore((s) => s.catalog);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "F2" && activeSessionKey) {
        setEditingSession(activeSessionKey);
      }
    },
    [activeSessionKey, setEditingSession],
  );

  if (folderSessions.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        No sessions in this folder
      </div>
    );
  }

  return (
    <div
      ref={parentRef}
      className="h-full overflow-y-auto outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onClick={() => setContextMenu(null)}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const session = folderSessions[virtualItem.index];
          return (
            <div
              key={session.agentSessionId}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualItem.size}px`,
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <SessionItem
                session={session}
                isActive={activeSessionKey === session.agentSessionId}
                isSelected={selectedSessionIds.has(session.agentSessionId)}
                isEditing={editingSessionId === session.agentSessionId}
                onClick={(e) =>
                  toggleSessionSelection(session.agentSessionId, e.ctrlKey || e.metaKey, e.shiftKey)
                }
                onContextMenu={(e) => handleContextMenu(session.agentSessionId, e)}
                onDragStart={(e) => handleDragStart(session.agentSessionId, e)}
                onEditSubmit={(name) => handleEditSubmit(session.agentSessionId, name)}
                onEditCancel={() => setEditingSession(null)}
              />
            </div>
          );
        })}
      </div>

      {/* 컨텍스트 메뉴 */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-popover border border-border rounded-md shadow-lg py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              setEditingSession(contextMenu.sessionId);
              setContextMenu(null);
            }}
          >
            Rename
          </button>
          <div className="border-t border-border my-1" />
          <div className="px-3 py-1 text-xs text-muted-foreground">Move to:</div>
          {catalog?.folders.map((f) => (
            <button
              key={f.id}
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent"
              onClick={() => handleMoveToFolder(f.id)}
            >
              {f.name}
            </button>
          ))}
          <button
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent text-muted-foreground"
            onClick={() => handleMoveToFolder(null)}
          >
            Uncategorized
          </button>
        </div>
      )}
    </div>
  );
}

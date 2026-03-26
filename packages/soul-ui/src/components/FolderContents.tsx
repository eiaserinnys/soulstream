/**
 * FolderContents - 선택된 폴더의 세션 목록
 *
 * 폴더 내 세션을 가상 스크롤로 표시. DnD/다중선택/인라인편집 지원.
 * API 호출은 콜백 props로 주입받아 앱별 엔드포인트에 의존하지 않는다.
 */

import { useMemo, useRef, useState, memo, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useDashboardStore,
  isSessionUnread,
} from "../stores/dashboard-store";
import { useIsMobile } from "../hooks/use-mobile";
import { cn } from "../lib/cn";
import { Badge } from "./ui/badge";
import { useTheme } from "../hooks/useTheme";
import type { SessionSummary, SessionStatus } from "../shared/types";

// === Node ID Color Utils ===

/** 노드 ID 문자열을 0~359 hue 값으로 해시한다 (djb2 XOR 변형) */
export function nodeIdToHue(nodeId: string): number {
  let hash = 5381;
  for (let i = 0; i < nodeId.length; i++) {
    hash = ((hash << 5) + hash) ^ nodeId.charCodeAt(i);
  }
  return Math.abs(hash) % 360;
}

// === Status Config ===

export interface StatusConfig {
  dotClass: string;
  animate: boolean;
}

export const STATUS_CONFIG: Record<SessionStatus, StatusConfig> = {
  running:      { dotClass: "bg-success",          animate: true  },
  completed:    { dotClass: "bg-muted-foreground",  animate: false },
  error:        { dotClass: "bg-accent-red",        animate: false },
  interrupted:  { dotClass: "bg-accent-amber",      animate: false },
  unknown:      { dotClass: "bg-muted-foreground",  animate: false },
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
  const config = STATUS_CONFIG[session.status] ?? STATUS_CONFIG.unknown;
  const isUnread = isSessionUnread(session);
  const isReadCompleted = session.status === "completed" && !isUnread;
  const [theme] = useTheme();

  const displayText = session.displayName
    ? `📌 ${session.displayName}`
    : session.lastMessage?.preview
      ? `🗨️ ${session.lastMessage.preview}`
      : session.prompt || session.agentSessionId;

  const displayTime = session.lastMessage?.timestamp ?? session.updatedAt ?? session.createdAt;
  const timeStr = displayTime
    ? new Date(displayTime).toLocaleString("ko-KR", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "...";

  return (
    <div
      draggable
      className={cn(
        "flex items-center gap-2 px-3 py-2 cursor-pointer text-sm hover:bg-accent/50 border-b border-border/50",
        isActive && "bg-accent text-accent-foreground",
        isSelected && !isActive && "bg-primary/10",
        isReadCompleted && "opacity-50",
      )}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDragStart={onDragStart}
      data-session-id={session.agentSessionId}
    >
      <span
        className={cn(
          "w-2 h-2 rounded-full shrink-0",
          config.dotClass,
          config.animate && "animate-[pulse_2s_infinite]",
        )}
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
          <div className={cn("truncate", isUnread ? "text-foreground font-semibold" : isReadCompleted ? "text-muted-foreground" : "text-foreground")}>
            {displayText}
          </div>
        )}
        <div className="text-xs text-muted-foreground truncate flex items-center gap-1">
          {session.agentName && (
            <>
              <span className="shrink-0 text-[10px] opacity-70">{session.agentName}</span>
              <span className="shrink-0 opacity-50">·</span>
            </>
          )}
          <span>{timeStr}</span>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {session.nodeId && (() => {
          const hue = nodeIdToHue(session.nodeId);
          const isDark = theme === "dark";
          const bgStyle = isDark
            ? `hsl(${hue}, 12%, 28%)`
            : `hsl(${hue}, 20%, 88%)`;
          const colorStyle = isDark
            ? `hsl(${hue}, 18%, 72%)`
            : `hsl(${hue}, 30%, 35%)`;
          return (
            <Badge
              variant="secondary"
              className="text-[10px] px-1 py-0 shrink-0"
              style={{ backgroundColor: bgStyle, color: colorStyle }}
            >
              {session.nodeId}
            </Badge>
          );
        })()}
        {session.eventCount > 0 && (
          <Badge variant="outline" size="sm" className="shrink-0">
            {session.eventCount}
          </Badge>
        )}
      </div>
    </div>
  );
});

export interface FolderContentsProps {
  /** 세션을 다른 폴더로 이동하는 콜백 */
  onMoveSessions: (sessionIds: string[], targetFolderId: string | null) => Promise<void>;
  /** 세션 이름 변경 콜백. 미지정 시 이름 변경 UI 비활성화 */
  onRenameSession?: (sessionId: string, displayName: string | null) => Promise<void>;
}

export function FolderContents({ onMoveSessions, onRenameSession }: FolderContentsProps) {
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const getSessionsInFolder = useDashboardStore((s) => s.getSessionsInFolder);
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const toggleSessionSelection = useDashboardStore((s) => s.toggleSessionSelection);
  const selectedSessionIds = useDashboardStore((s) => s.selectedSessionIds);
  const editingSessionId = useDashboardStore((s) => s.editingSessionId);
  const setEditingSession = useDashboardStore((s) => s.setEditingSession);
  const setMobileView = useDashboardStore((s) => s.setMobileView);
  const catalogVersion = useDashboardStore((s) => s.catalogVersion);
  const sessions = useDashboardStore((s) => s.sessions);
  const isMobile = useIsMobile();
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
      setEditingSession(null);
      if (onRenameSession) {
        await onRenameSession(sessionId, displayName);
      }
    },
    [setEditingSession, onRenameSession],
  );

  const handleMoveToFolder = useCallback(
    async (targetFolderId: string | null) => {
      const sessionId = contextMenu?.sessionId;
      if (!sessionId) return;
      const ids = selectedSessionIds.has(sessionId)
        ? Array.from(selectedSessionIds)
        : [sessionId];
      setContextMenu(null);
      await onMoveSessions(ids, targetFolderId);
    },
    [selectedSessionIds, contextMenu, onMoveSessions],
  );

  const catalog = useDashboardStore((s) => s.catalog);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "F2" && activeSessionKey && onRenameSession) {
        setEditingSession(activeSessionKey);
      }
    },
    [activeSessionKey, setEditingSession, onRenameSession],
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
                isEditing={onRenameSession ? editingSessionId === session.agentSessionId : false}
                onClick={(e) => {
                  toggleSessionSelection(session.agentSessionId, e.ctrlKey || e.metaKey, e.shiftKey);
                  if (isMobile) setMobileView("chat");
                }}
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
          {onRenameSession && (
            <>
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
            </>
          )}
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
        </div>
      )}
    </div>
  );
}

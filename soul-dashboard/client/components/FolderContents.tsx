/**
 * FolderContents - 선택된 폴더의 세션 목록
 *
 * 폴더 내 세션을 가상 스크롤로 표시한다.
 */

import { useMemo, useRef, memo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
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
  onClick,
}: {
  session: SessionSummary;
  isActive: boolean;
  onClick: () => void;
}) {
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
      className={cn(
        "flex items-center gap-2 px-3 py-2 cursor-pointer text-sm hover:bg-accent/50 border-b border-border/50",
        isActive && "bg-accent text-accent-foreground",
      )}
      onClick={onClick}
    >
      <div
        className={cn("w-2 h-2 rounded-full shrink-0", STATUS_COLORS[session.status] ?? "bg-gray-400")}
      />
      <div className="flex-1 min-w-0">
        <div className="truncate">{displayText}</div>
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
  const setActiveSession = useDashboardStore((s) => s.setActiveSession);
  const catalogVersion = useDashboardStore((s) => s.catalogVersion);
  const sessions = useDashboardStore((s) => s.sessions);

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

  if (folderSessions.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        No sessions in this folder
      </div>
    );
  }

  return (
    <div ref={parentRef} className="h-full overflow-y-auto">
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
                onClick={() => setActiveSession(session.agentSessionId)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

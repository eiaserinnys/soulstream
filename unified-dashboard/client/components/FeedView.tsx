/**
 * FeedView - soul-ui FeedView 래퍼 (unified-dashboard)
 *
 * soul-ui의 FeedView에 unified-dashboard API 구현을 주입한다.
 */
import { useCallback } from "react";
import {
  FeedView as SoulUIFeedView,
  type SessionSummary,
  shouldLoadMoreAfterSessionMove,
  useDashboardStore,
  useRenameSessionOperation,
} from "@seosoyoung/soul-ui";
import { moveSessionsOptimistic } from "client/lib/move-sessions";
import { renameSessionOperation } from "client/lib/rename-session";

interface FeedViewWrapperProps {
  onNewSession?: () => void;
  placement?: "main" | "sidebar";
  onLoadMore?: () => Promise<unknown> | void;
  hasMore?: boolean;
  sessions?: SessionSummary[];
}

export function FeedView({
  onNewSession,
  placement,
  onLoadMore,
  hasMore,
  sessions,
}: FeedViewWrapperProps = {}) {
  const viewMode = useDashboardStore((s) => s.viewMode);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const catalog = useDashboardStore((s) => s.catalog);
  const renameSession = useRenameSessionOperation(renameSessionOperation);

  const handleMoveSessions = useCallback(
    async (sessionIds: string[], targetFolderId: string | null) => {
      const shouldBackfill = shouldLoadMoreAfterSessionMove({
        viewMode,
        selectedFolderId,
        catalog,
        sessionIds,
        targetFolderId,
      });
      await moveSessionsOptimistic(sessionIds, targetFolderId);
      if (hasMore && onLoadMore && shouldBackfill) {
        onLoadMore();
      }
    },
    [catalog, hasMore, onLoadMore, selectedFolderId, viewMode],
  );

  return (
    <SoulUIFeedView
      onMoveSessions={handleMoveSessions}
      onRenameSession={renameSession}
      onNewSession={onNewSession}
      placement={placement}
      onLoadMore={onLoadMore}
      hasMore={hasMore}
      sessions={sessions}
    />
  );
}

/**
 * FeedView - soul-ui FeedView 래퍼 (unified-dashboard)
 *
 * soul-ui의 FeedView에 unified-dashboard API 구현을 주입한다.
 */
import { useCallback } from "react";
import { FeedView as SoulUIFeedView } from "@seosoyoung/soul-ui";
import { moveSessionsOptimistic } from "client/lib/move-sessions";
import { renameSessionOptimistic } from "client/lib/rename-session";

interface FeedViewWrapperProps {
  onNewSession?: () => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
}

export function FeedView({ onNewSession, onLoadMore, hasMore }: FeedViewWrapperProps = {}) {
  const handleMoveSessions = useCallback(
    async (sessionIds: string[], targetFolderId: string | null) => {
      await moveSessionsOptimistic(sessionIds, targetFolderId);
      if (hasMore && onLoadMore) {
        onLoadMore();
      }
    },
    [hasMore, onLoadMore],
  );

  return (
    <SoulUIFeedView
      onMoveSessions={handleMoveSessions}
      onRenameSession={renameSessionOptimistic}
      onNewSession={onNewSession}
      onLoadMore={onLoadMore}
      hasMore={hasMore}
    />
  );
}

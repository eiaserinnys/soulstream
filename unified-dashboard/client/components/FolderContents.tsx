/**
 * FolderContents - soul-ui FolderContents 래퍼 (unified-dashboard)
 *
 * soul-ui의 FolderContents에 unified-dashboard API 구현을 주입한다.
 */

import { FolderContents as SoulUIFolderContents } from "@seosoyoung/soul-ui";
import type { SessionSummary } from "@seosoyoung/soul-ui";
import { moveSessionsOptimistic } from "client/lib/move-sessions";
import { renameSessionOptimistic } from "client/lib/rename-session";

interface FolderContentsWrapperProps {
  sessions?: SessionSummary[];
  onLoadMore?: () => Promise<unknown> | void;
  hasMore?: boolean;
}

export function FolderContents({ sessions, onLoadMore, hasMore }: FolderContentsWrapperProps = {}) {
  return (
    <SoulUIFolderContents
      sessions={sessions}
      onMoveSessions={moveSessionsOptimistic}
      onRenameSession={renameSessionOptimistic}
      onLoadMore={onLoadMore}
      hasMore={hasMore}
    />
  );
}

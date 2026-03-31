/**
 * FolderContents - soul-ui FolderContents 래퍼 (unified-dashboard)
 *
 * soul-ui의 FolderContents에 unified-dashboard API 구현을 주입한다.
 */

import { FolderContents as SoulUIFolderContents } from "@seosoyoung/soul-ui";
import { moveSessionsOptimistic } from "client/lib/move-sessions";
import { renameSessionOptimistic } from "client/lib/rename-session";

interface FolderContentsWrapperProps {
  onLoadMore?: () => void;
  hasMore?: boolean;
}

export function FolderContents({ onLoadMore, hasMore }: FolderContentsWrapperProps = {}) {
  return (
    <SoulUIFolderContents
      onMoveSessions={moveSessionsOptimistic}
      onRenameSession={renameSessionOptimistic}
      onLoadMore={onLoadMore}
      hasMore={hasMore}
    />
  );
}

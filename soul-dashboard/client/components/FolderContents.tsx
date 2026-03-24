/**
 * FolderContents - soul-ui FolderContents 래퍼 (soul-dashboard 전용)
 *
 * soul-ui의 FolderContents에 soul-dashboard API 구현을 주입한다.
 */

import { FolderContents as SoulUIFolderContents } from "@seosoyoung/soul-ui";
import { moveSessionsOptimistic } from "client/lib/move-sessions";
import { renameSessionOptimistic } from "client/lib/rename-session";

export function FolderContents() {
  return (
    <SoulUIFolderContents
      onMoveSessions={moveSessionsOptimistic}
      onRenameSession={renameSessionOptimistic}
    />
  );
}

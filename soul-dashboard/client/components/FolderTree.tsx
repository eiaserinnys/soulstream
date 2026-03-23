/**
 * FolderTree - soul-ui FolderTree 래퍼
 *
 * soul-ui의 FolderTree 컴포넌트에 soul-dashboard 전용 API 구현을 주입한다.
 */

import { FolderTree as SoulUIFolderTree } from "@seosoyoung/soul-ui";
import { moveSessionsOptimistic } from "client/lib/move-sessions";
import {
  createFolder,
  renameFolderOptimistic,
  deleteFolderOptimistic,
} from "client/lib/folder-operations";

export function FolderTree() {
  return (
    <SoulUIFolderTree
      onMoveSessions={(ids, folderId) => moveSessionsOptimistic(ids, folderId)}
      onCreateFolder={(name) => createFolder(name)}
      onRenameFolder={(folderId, newName) => renameFolderOptimistic(folderId, newName)}
      onDeleteFolder={(folderId) => deleteFolderOptimistic(folderId)}
    />
  );
}

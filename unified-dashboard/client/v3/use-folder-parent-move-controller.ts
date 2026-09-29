import { useCallback, useMemo, useState } from "react";
import type { CatalogFolder } from "@seosoyoung/soul-ui";
import type { PageApiClient, PageDto } from "@seosoyoung/soul-ui/page";

import type { PlannerFolder, StarredPlannerFolder } from "./planner-data";
import { loadStarredPlannerFolder } from "./planner-data";
import type { FolderParentMoveDialogProps } from "./FolderParentMoveDialog";
import type { FolderParentTarget } from "./folder-parent-move";
import { errorText } from "./v3-dashboard-utils";

export function useFolderParentMoveController({
  api,
  folders,
  moveFolder,
  notify,
}: {
  api: PageApiClient;
  folders: readonly CatalogFolder[];
  moveFolder(task: PlannerFolder, target: FolderParentTarget): Promise<void>;
  notify(message: string): void;
}) {
  const [task, setFolder] = useState<PlannerFolder | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openFolder = useCallback((next: PlannerFolder) => {
    setFolder(next);
    setError(null);
  }, []);
  const openPage = useCallback(async (task: StarredPlannerFolder) => {
    try {
      openFolder(await loadStarredPlannerFolder(api, task, folders));
    } catch (cause) {
      notify(`업무 불러오기 실패 · ${errorText(cause)}`);
    }
  }, [api, folders, notify, openFolder]);
  const currentFolderId = task?.parentFolderId ?? null;
  const close = useCallback(() => {
    if (!pending) setFolder(null);
  }, [pending]);
  const move = useCallback((target: FolderParentTarget) => {
    if (!task || pending) return;
    setPending(true);
    setError(null);
    void moveFolder(task, target).then(() => {
      setFolder(null);
    }).catch((cause: unknown) => {
      setError(`프로젝트 이동 실패 · ${errorText(cause)}`);
    }).finally(() => {
      setPending(false);
    });
  }, [moveFolder, pending, task]);
  const dialogProps: FolderParentMoveDialogProps = {
    task,
    currentFolderId,
    folders,
    pending,
    error,
    onMove: move,
    onClose: close,
  };
  return { openFolder, openPage, dialogProps };
}

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
  moveTask,
  notify,
}: {
  api: PageApiClient;
  folders: readonly CatalogFolder[];
  moveTask(task: PlannerFolder, target: FolderParentTarget): Promise<void>;
  notify(message: string): void;
}) {
  const [task, setTask] = useState<PlannerFolder | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openTask = useCallback((next: PlannerFolder) => {
    setTask(next);
    setError(null);
  }, []);
  const openPage = useCallback(async (task: StarredPlannerFolder) => {
    try {
      openTask(await loadStarredPlannerFolder(api, task, folders));
    } catch (cause) {
      notify(`업무 불러오기 실패 · ${errorText(cause)}`);
    }
  }, [api, folders, notify, openTask]);
  const currentFolderId = task?.parentFolderId ?? null;
  const close = useCallback(() => {
    if (!pending) setTask(null);
  }, [pending]);
  const move = useCallback((target: FolderParentTarget) => {
    if (!task || pending) return;
    setPending(true);
    setError(null);
    void moveTask(task, target).then(() => {
      setTask(null);
    }).catch((cause: unknown) => {
      setError(`프로젝트 이동 실패 · ${errorText(cause)}`);
    }).finally(() => {
      setPending(false);
    });
  }, [moveTask, pending, task]);
  const dialogProps: FolderParentMoveDialogProps = {
    task,
    currentFolderId,
    folders,
    pending,
    error,
    onMove: move,
    onClose: close,
  };
  return { openTask, openPage, dialogProps };
}

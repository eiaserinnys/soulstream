import { useCallback, useMemo, useState } from "react";
import type { CatalogFolder } from "@seosoyoung/soul-ui";
import type { PageApiClient, PageDto } from "@seosoyoung/soul-ui/page";

import type { PlannerTask } from "./planner-data";
import { loadStarredPlannerTask } from "./planner-data";
import type { TaskProjectMoveDialogProps } from "./TaskProjectMoveDialog";
import type { TaskProjectMoveTarget } from "./task-project-move";
import { errorText } from "./v3-dashboard-utils";

export function useTaskProjectMoveController({
  api,
  folders,
  moveTask,
  notify,
}: {
  api: PageApiClient;
  folders: readonly CatalogFolder[];
  moveTask(task: PlannerTask, target: TaskProjectMoveTarget): Promise<void>;
  notify(message: string): void;
}) {
  const [task, setTask] = useState<PlannerTask | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openTask = useCallback((next: PlannerTask) => {
    setTask(next);
    setError(null);
  }, []);
  const openPage = useCallback(async (page: PageDto) => {
    try {
      openTask(await loadStarredPlannerTask(api, page));
    } catch (cause) {
      notify(`업무 불러오기 실패 · ${errorText(cause)}`);
    }
  }, [api, notify, openTask]);
  const currentFolderId = useMemo(() => folders.find(
    (folder) => folder.projectPageId === task?.projectPageId,
  )?.id ?? null, [folders, task?.projectPageId]);
  const close = useCallback(() => {
    if (!pending) setTask(null);
  }, [pending]);
  const move = useCallback((target: TaskProjectMoveTarget) => {
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
  const dialogProps: TaskProjectMoveDialogProps = {
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

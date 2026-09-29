import { useCallback, type Dispatch, type SetStateAction } from "react";
import { retainEqualValue } from "@seosoyoung/soul-ui";

import type { PlannerLoadState } from "./PlannerViews";
import type {
  DailyPlannerData,
  PlannerFolder,
  ProjectPlannerData,
} from "./planner-data";
import {
  movePlannerFolderProject,
  replacePlannerFolder,
} from "./planner-mutation-projection";

export function usePlannerProjectMoveProjection(
  setDaily: Dispatch<SetStateAction<PlannerLoadState<DailyPlannerData>>>,
  setProject: Dispatch<SetStateAction<PlannerLoadState<ProjectPlannerData>>>,
) {
  return useCallback((task: PlannerFolder, targetFolderId: string | null) => {
    const projectedTask = { ...task, parentFolderId: targetFolderId };
    setDaily((current) => {
      if (!current.data) return current;
      const tasks = replacePlannerFolder(current.data.tasks, task.page.id, () => projectedTask);
      if (tasks === current.data.tasks) return current;
      return retainEqualValue(current, {
        ...current,
        data: { ...current.data, tasks },
      });
    });
    setProject((current) => {
      if (!current.data) return current;
      const tasks = movePlannerFolderProject(
        current.data.tasks,
        task,
        targetFolderId,
        current.data.project.id,
      );
      return tasks === current.data.tasks
        ? current
        : retainEqualValue(current, { ...current, data: { ...current.data, tasks } });
    });
  }, [setDaily, setProject]);
}

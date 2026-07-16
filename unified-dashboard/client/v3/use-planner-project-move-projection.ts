import { useCallback, type Dispatch, type SetStateAction } from "react";
import { retainEqualValue } from "@seosoyoung/soul-ui";
import type { PageDto } from "@seosoyoung/soul-ui/page";

import type { PlannerLoadState } from "./PlannerViews";
import type {
  DailyPlannerData,
  PlannerTask,
  ProjectPlannerData,
} from "./planner-data";
import {
  movePlannerTaskProject,
  projectPagesForTasks,
  replacePlannerTask,
} from "./planner-mutation-projection";

export function usePlannerProjectMoveProjection(
  setDaily: Dispatch<SetStateAction<PlannerLoadState<DailyPlannerData>>>,
  setProject: Dispatch<SetStateAction<PlannerLoadState<ProjectPlannerData>>>,
) {
  return useCallback((task: PlannerTask, targetProject: PageDto) => {
    const projectedTask = { ...task, projectPageId: targetProject.id };
    setDaily((current) => {
      if (!current.data) return current;
      const tasks = replacePlannerTask(current.data.tasks, task.page.id, () => projectedTask);
      if (tasks === current.data.tasks) return current;
      const projects = projectPagesForTasks(current.data.projects, tasks, targetProject);
      return retainEqualValue(current, {
        ...current,
        data: { ...current.data, tasks, projects },
      });
    });
    setProject((current) => {
      if (!current.data) return current;
      const tasks = movePlannerTaskProject(
        current.data.tasks,
        task,
        targetProject.id,
        current.data.project.id,
      );
      return tasks === current.data.tasks
        ? current
        : retainEqualValue(current, { ...current, data: { ...current.data, tasks } });
    });
  }, [setDaily, setProject]);
}

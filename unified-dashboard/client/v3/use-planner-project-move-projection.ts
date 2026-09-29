import { useCallback, type Dispatch, type SetStateAction } from "react";
import { retainEqualValue } from "@seosoyoung/soul-ui";

import type { PlannerLoadState } from "./PlannerViews";
import type { DailyPlannerData, PlannerFolder } from "./planner-data";
import { replacePlannerFolder } from "./planner-mutation-projection";

export function usePlannerProjectMoveProjection(
  setDaily: Dispatch<SetStateAction<PlannerLoadState<DailyPlannerData>>>,
) {
  return useCallback((task: PlannerFolder, targetFolderId: string | null) => {
    const projectedTask = { ...task, parentFolderId: targetFolderId };
    setDaily((current) => {
      if (!current.data) return current;
      const folders = replacePlannerFolder(current.data.folders, task.page.id, () => projectedTask);
      if (folders === current.data.folders) return current;
      return retainEqualValue(current, {
        ...current,
        data: { ...current.data, folders },
      });
    });
  }, [setDaily]);
}

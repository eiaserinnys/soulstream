import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import { toggleDailyFolderMembership } from "./daily-folder-membership";
import { operationId } from "./folder-star-actions";
import type { PlannerFolder } from "./planner-data";

type OperationIdFactory = (prefix: string) => string;

export async function togglePlannerFolderToday(
  task: PlannerFolder,
  api: PageApiClient,
  idFactory: OperationIdFactory = operationId,
): Promise<"added" | "removed"> {
  const daily = await api.getDailyPage();
  return await toggleDailyFolderMembership({
    api,
    dailyPageId: daily.page.id,
    folderPage: task.page,
    idempotencyKey: () => idFactory("v3-daily-toggle"),
    reason: "v3 planner daily task toggle",
  });
}


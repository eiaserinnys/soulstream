import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import { toggleDailyTaskMembership } from "./daily-task-membership";
import type { PlannerFolder } from "./planner-data";

type OperationIdFactory = (prefix: string) => string;

export async function togglePlannerFolderToday(
  task: PlannerFolder,
  api: PageApiClient,
  idFactory: OperationIdFactory = operationId,
): Promise<"added" | "removed"> {
  const daily = await api.getDailyPage();
  return await toggleDailyTaskMembership({
    api,
    dailyPageId: daily.page.id,
    taskPage: task.page,
    idempotencyKey: () => idFactory("daily-toggle"),
    reason: "v3 planner daily task toggle",
  });
}

function operationId(prefix: string): string {
  if (!globalThis.crypto?.randomUUID) throw new Error("브라우저 randomUUID 지원이 필요합니다");
  return `v3-${prefix}-${globalThis.crypto.randomUUID()}`;
}

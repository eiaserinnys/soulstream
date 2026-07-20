import type { PageApiClient } from "@seosoyoung/soul-ui/page";
import { postTaskStatus } from "@seosoyoung/soul-ui/stores/task-api";

import { toggleDailyTaskMembership } from "./daily-task-membership";
import type { PlannerTask } from "./planner-data";

type OperationIdFactory = (prefix: string) => string;

export async function completePlannerTask(
  task: PlannerTask,
): Promise<void> {
  const expectedVersion = task.task?.task.version;
  if (expectedVersion === undefined) {
    throw new Error("업무를 불러오지 못해 완료 처리할 수 없습니다");
  }
  await postTaskStatus({
    taskId: task.taskId,
    expectedVersion,
    idempotencyKey: operationId("task-complete"),
    status: "completed",
    reason: "v3 planner task completion",
  });
}

export async function togglePlannerTaskToday(
  task: PlannerTask,
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

import type { PageApiClient } from "@seosoyoung/soul-ui/page";
import { postTaskStatus } from "@seosoyoung/soul-ui/stores/task-api";

import { BrowserPlannerMutationPort } from "./planner-browser-port";
import type { RitualActionPort } from "./ritual-model";

export class BrowserRitualActionPort implements RitualActionPort {
  private readonly plannerPort: BrowserPlannerMutationPort;

  constructor(
    private readonly dailyPageId: string,
    api: PageApiClient,
  ) {
    this.plannerPort = new BrowserPlannerMutationPort(api);
  }

  async mountToday(input: { taskTitle: string }) {
    await mountRitualTaskToday(this.plannerPort, this.dailyPageId, input.taskTitle);
  }

  async completeTask(input: { taskId: string; expectedVersion: number }) {
    await completeRitualTask(input);
  }
}

export async function mountRitualTaskToday(
  plannerPort: Pick<BrowserPlannerMutationPort, "mountPage">,
  dailyPageId: string,
  taskTitle: string,
): Promise<void> {
  await plannerPort.mountPage({ sourcePageId: dailyPageId, title: taskTitle });
}

export async function completeRitualTask(input: {
  taskId: string;
  expectedVersion: number;
}): Promise<void> {
  await postTaskStatus({
    taskId: input.taskId,
    expectedVersion: input.expectedVersion,
    idempotencyKey: ritualOperationId("task-complete"),
    status: "completed",
    reason: "v3 morning ritual completion",
  });
}

function ritualOperationId(prefix: string): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error("브라우저 randomUUID 지원이 필요합니다");
  }
  return `ritual-${prefix}-${globalThis.crypto.randomUUID()}`;
}

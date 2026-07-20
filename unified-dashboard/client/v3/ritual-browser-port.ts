import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import { setDailyTaskMembership } from "./daily-task-membership";
import type { RitualActionPort } from "./ritual-model";

export class BrowserRitualActionPort implements RitualActionPort {
  constructor(
    private readonly dailyPageId: string,
    private readonly api: PageApiClient,
  ) {}

  async mountToday(input: { taskPageId: string; taskTitle: string }) {
    await mountRitualTaskToday(
      this.api,
      this.dailyPageId,
      input.taskPageId,
      input.taskTitle,
    );
  }

  async removeFromDaily(input: {
    dailyPageId: string;
    taskPageId: string;
    taskTitle: string;
  }) {
    await removeRitualTaskFromDaily(
      this.api,
      input.dailyPageId,
      input.taskPageId,
      input.taskTitle,
    );
  }
}

export async function mountRitualTaskToday(
  api: PageApiClient,
  dailyPageId: string,
  taskPageId: string,
  taskTitle: string,
): Promise<void> {
  await setDailyTaskMembership({
    api,
    dailyPageId,
    taskPage: { id: taskPageId, title: taskTitle },
    present: true,
    idempotencyKey: () => ritualOperationId("daily-mount"),
    reason: "v3 morning ritual daily mount",
  });
}

export async function removeRitualTaskFromDaily(
  api: PageApiClient,
  dailyPageId: string,
  taskPageId: string,
  taskTitle: string,
  idFactory: () => string = () => ritualOperationId("daily-unmount"),
): Promise<void> {
  await setDailyTaskMembership({
    api,
    dailyPageId,
    taskPage: { id: taskPageId, title: taskTitle },
    present: false,
    idempotencyKey: idFactory,
    reason: "v3 morning ritual daily unmount",
  });
}

function ritualOperationId(prefix: string): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error("브라우저 randomUUID 지원이 필요합니다");
  }
  return `ritual-${prefix}-${globalThis.crypto.randomUUID()}`;
}

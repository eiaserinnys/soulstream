import type { PageApiClient } from "@seosoyoung/soul-ui/page";
import { postRunbookStatus } from "@seosoyoung/soul-ui/stores/runbook-api";

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

  async completeRunbook(input: { runbookId: string; expectedVersion: number }) {
    await completeRitualRunbook(input);
  }
}

export async function mountRitualTaskToday(
  plannerPort: Pick<BrowserPlannerMutationPort, "mountPage">,
  dailyPageId: string,
  taskTitle: string,
): Promise<void> {
  await plannerPort.mountPage({ sourcePageId: dailyPageId, title: taskTitle });
}

export async function completeRitualRunbook(input: {
  runbookId: string;
  expectedVersion: number;
}): Promise<void> {
  await postRunbookStatus({
    runbookId: input.runbookId,
    expectedVersion: input.expectedVersion,
    idempotencyKey: ritualOperationId("runbook-complete"),
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

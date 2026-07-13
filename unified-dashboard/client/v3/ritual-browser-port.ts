import type { PageApiClient } from "@seosoyoung/soul-ui/page";
import { acknowledgeSessionReview } from "@seosoyoung/soul-ui/lib/session-review";
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
    await this.plannerPort.mountPage({
      sourcePageId: this.dailyPageId,
      title: input.taskTitle,
    });
  }

  async completeRunbook(input: { runbookId: string; expectedVersion: number }) {
    await postRunbookStatus({
      runbookId: input.runbookId,
      expectedVersion: input.expectedVersion,
      idempotencyKey: ritualOperationId("runbook-complete"),
      status: "completed",
      reason: "v3 morning ritual completion",
    });
  }

  async acknowledgeReview(sessionId: string) {
    await acknowledgeSessionReview(sessionId);
  }
}

function ritualOperationId(prefix: string): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error("브라우저 randomUUID 지원이 필요합니다");
  }
  return `ritual-${prefix}-${globalThis.crypto.randomUUID()}`;
}

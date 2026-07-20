import type { PageApiClient } from "@seosoyoung/soul-ui/page";
import { postTaskStatus } from "@seosoyoung/soul-ui/stores/task-api";

import { BrowserPlannerMutationPort } from "./planner-browser-port";
import { parseSingleMountTitle } from "./planner-model";
import type { RitualActionPort } from "./ritual-model";

export class BrowserRitualActionPort implements RitualActionPort {
  private readonly plannerPort: BrowserPlannerMutationPort;

  constructor(
    private readonly dailyPageId: string,
    private readonly api: PageApiClient,
  ) {
    this.plannerPort = new BrowserPlannerMutationPort(api);
  }

  async mountToday(input: { taskTitle: string }) {
    await mountRitualTaskToday(this.plannerPort, this.dailyPageId, input.taskTitle);
  }

  async removeFromDaily(input: { dailyPageId: string; taskTitle: string }) {
    await removeRitualTaskFromDaily(
      this.api,
      input.dailyPageId,
      input.taskTitle,
    );
  }
}

export async function mountRitualTaskToday(
  plannerPort: Pick<BrowserPlannerMutationPort, "mountPage">,
  dailyPageId: string,
  taskTitle: string,
): Promise<void> {
  await plannerPort.mountPage({ sourcePageId: dailyPageId, title: taskTitle });
}

export async function removeRitualTaskFromDaily(
  api: PageApiClient,
  dailyPageId: string,
  taskTitle: string,
  idFactory: () => string = () => ritualOperationId("daily-unmount"),
): Promise<void> {
  const snapshot = await api.getPage(dailyPageId);
  const mount = snapshot.blocks.find(
    (block) => parseSingleMountTitle(block) === taskTitle,
  );
  if (!mount) return;
  await api.applyOperations(dailyPageId, {
    expectedVersion: snapshot.page.version,
    expectedStateVector: decodeStateVector(snapshot.state_vector),
    idempotencyKey: idFactory(),
    reason: "v3 morning ritual daily unmount",
    operations: [{ op: "delete_block_subtree", block_id: mount.id }],
  });
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

function decodeStateVector(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function ritualOperationId(prefix: string): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error("브라우저 randomUUID 지원이 필요합니다");
  }
  return `ritual-${prefix}-${globalThis.crypto.randomUUID()}`;
}

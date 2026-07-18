import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import { BrowserPlannerMutationPort } from "./planner-browser-port";
import type { PlannerTask } from "./planner-data";
import { parseSingleMountTitle } from "./planner-model";
import {
  completeRitualTask,
  mountRitualTaskToday,
} from "./ritual-browser-port";

type OperationIdFactory = (prefix: string) => string;

export async function completePlannerTask(
  task: PlannerTask,
): Promise<void> {
  const expectedVersion = task.task?.task.version;
  if (expectedVersion === undefined) {
    throw new Error("업무를 불러오지 못해 완료 처리할 수 없습니다");
  }
  await completeRitualTask({ taskId: task.taskId, expectedVersion });
}

export async function togglePlannerTaskToday(
  task: PlannerTask,
  api: PageApiClient,
  idFactory: OperationIdFactory = operationId,
): Promise<"added" | "removed"> {
  const daily = await api.getDailyPage();
  const snapshot = await api.getPage(daily.page.id);
  const existingMount = snapshot.blocks.find(
    (block) => parseSingleMountTitle(block) === task.page.title,
  );
  if (existingMount) {
    await api.applyOperations(daily.page.id, {
      expectedVersion: snapshot.page.version,
      expectedStateVector: decodeStateVector(snapshot.state_vector),
      idempotencyKey: idFactory("daily-toggle"),
      reason: "v3 planner daily task unmount",
      operations: [{ op: "delete_block_subtree", block_id: existingMount.id }],
    });
    return "removed";
  }

  await mountRitualTaskToday(
    new BrowserPlannerMutationPort(api),
    daily.page.id,
    task.page.title,
  );
  return "added";
}

function decodeStateVector(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function operationId(prefix: string): string {
  if (!globalThis.crypto?.randomUUID) throw new Error("브라우저 randomUUID 지원이 필요합니다");
  return `v3-${prefix}-${globalThis.crypto.randomUUID()}`;
}

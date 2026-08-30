import type { SSEEventPayload } from "../engine/protocol.js";

import { TaskDeliveryConsumption } from "./task_delivery_consumption.js";
import type { InterventionMessage, Task } from "./task_models.js";

/** Consumes the exact claimed delivery at the first non-envelope model event. */
export class TaskDeliveryTurnReceipt {
  private readonly receipts: Array<{
    intervention: InterventionMessage;
    consumed: boolean;
  }>;

  constructor(
    private readonly consumption: TaskDeliveryConsumption,
    interventions: readonly InterventionMessage[],
  ) {
    this.receipts = interventions.map((intervention) => ({
      intervention,
      consumed: false,
    }));
  }

  async observe(task: Task, event: SSEEventPayload): Promise<void> {
    if (event.type === "session" || event.type === "error") return;
    const consumedTurnId = turnReceiptId(task);
    for (const receipt of this.receipts) {
      if (receipt.consumed) continue;
      await this.consumption.recordConsumed(
        task,
        receipt.intervention,
        consumedTurnId,
      );
      receipt.consumed = true;
    }
  }
}

function turnReceiptId(task: Task): string {
  const ownership = task.executionOwnership;
  if (!ownership) {
    throw new Error(`Delivery receipt has no execution owner: ${task.agentSessionId}`);
  }
  return [
    "execution",
    ownership.ownershipGeneration,
    ownership.executionCommandId,
    "first-model-event",
  ].join(":");
}

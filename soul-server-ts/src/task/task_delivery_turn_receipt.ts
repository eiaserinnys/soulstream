import type { SSEEventPayload } from "../engine/protocol.js";

import { TaskDeliveryConsumption } from "./task_delivery_consumption.js";
import type { InterventionMessage, Task } from "./task_models.js";

/**
 * Owns the durable boundary between SDK input enqueue and observed foreground
 * execution. A fresh Query's session envelope is not proof that it consumed
 * the input, so the delivery remains replayable until a later turn event.
 */
export class TaskDeliveryTurnReceipt {
  private readonly receipts: Array<{
    intervention: InterventionMessage;
    recorded: boolean;
    consumed: boolean;
    consumedTurnId?: string;
  }>;

  constructor(
    private readonly consumption: TaskDeliveryConsumption,
    interventions: readonly InterventionMessage[],
  ) {
    this.receipts = interventions.map((intervention) => ({
      intervention,
      recorded: false,
      consumed: false,
    }));
  }

  async observe(task: Task, event: SSEEventPayload): Promise<void> {
    if (event.type === "session" || event.type === "error") return;
    const consumedTurnId = turnReceiptId(task);
    for (const receipt of this.receipts) {
      if (receipt.recorded) continue;
      receipt.recorded = await this.consumption.recordTurnStarted(
        task,
        receipt.intervention,
      );
      if (receipt.recorded) receipt.consumedTurnId = consumedTurnId;
    }
  }

  async consume(task: Task): Promise<void> {
    for (const receipt of this.receipts) {
      if (receipt.consumed || !receipt.recorded) continue;
      // Without an observed turn receipt the delivery stays replayable. Startup
      // transcript recovery owns the durable completed/absent decision.
      await this.consumption.recordConsumed(
        task,
        receipt.intervention,
        receipt.consumedTurnId,
      );
      receipt.consumed = true;
    }
  }
}

function turnReceiptId(task: Task): string {
  return `event:${task.lastEventId ?? "unknown"}`;
}

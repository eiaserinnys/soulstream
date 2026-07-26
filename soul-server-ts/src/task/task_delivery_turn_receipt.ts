import type { SSEEventPayload } from "../engine/protocol.js";

import { TaskDeliveryConsumption } from "./task_delivery_consumption.js";
import type { InterventionMessage, Task } from "./task_models.js";

/**
 * Owns the durable boundary between SDK input enqueue and observed foreground
 * execution. A fresh Query's session envelope is not proof that it consumed
 * the input, so the delivery remains replayable until a later turn event.
 */
export class TaskDeliveryTurnReceipt {
  private recorded = false;

  constructor(
    private readonly consumption: TaskDeliveryConsumption | undefined,
    private readonly intervention: InterventionMessage | undefined,
  ) {}

  async observe(task: Task, event: SSEEventPayload): Promise<void> {
    if (
      this.recorded ||
      !this.consumption ||
      event.type === "session" ||
      event.type === "error"
    ) {
      return;
    }
    this.recorded =
      await this.consumption.recordTurnStarted(task, this.intervention);
  }

  async consume(task: Task): Promise<void> {
    if (!this.recorded || !this.consumption) return;
    await this.consumption.recordConsumed(task, this.intervention);
  }
}

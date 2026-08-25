import type { SSEEventPayload } from "../engine/protocol.js";
import type { ClaudeDeliveryTranscriptReceiptReader } from
  "../engine/claude_delivery_transcript_receipt.js";

import { TaskDeliveryConsumption } from "./task_delivery_consumption.js";
import type { InterventionMessage, Task } from "./task_models.js";

/**
 * Owns the durable boundary between SDK input enqueue and observed foreground
 * execution. A fresh Query's session envelope is not proof that it consumed
 * the input, so the delivery remains replayable until a later turn event.
 */
export class TaskDeliveryTurnReceipt {
  private recorded = false;
  private consumed = false;
  private consumedTurnId: string | undefined;

  constructor(
    private readonly consumption: TaskDeliveryConsumption,
    private readonly intervention: InterventionMessage | undefined,
    private readonly transcriptReceipt?: Pick<
      ClaudeDeliveryTranscriptReceiptReader,
      "inspect"
    >,
  ) {
    void this.transcriptReceipt;
  }

  async observe(task: Task, event: SSEEventPayload): Promise<void> {
    if (
      this.recorded ||
      event.type === "session" ||
      event.type === "error"
    ) {
      return;
    }
    const consumedTurnId = turnReceiptId(task);
    this.recorded = await this.consumption.recordTurnStarted(task, this.intervention);
    if (this.recorded) this.consumedTurnId = consumedTurnId;
  }

  async consume(task: Task): Promise<void> {
    if (this.consumed) return;
    // Without an observed turn receipt the delivery stays replayable. Startup
    // transcript recovery owns the durable completed/absent decision.
    if (!this.recorded) return;
    await this.consumption.recordConsumed(
      task,
      this.intervention,
      this.consumedTurnId,
    );
    this.consumed = true;
  }
}

function turnReceiptId(task: Task): string {
  return `event:${task.lastEventId ?? "unknown"}`;
}

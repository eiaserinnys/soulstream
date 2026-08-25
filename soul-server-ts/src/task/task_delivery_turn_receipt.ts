import type { SSEEventPayload } from "../engine/protocol.js";
import type {
  ClaudeDeliveryTranscriptReceipt,
  ClaudeDeliveryTranscriptReceiptReader,
} from
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

  constructor(
    private readonly consumption: TaskDeliveryConsumption,
    private readonly intervention: InterventionMessage | undefined,
    private readonly transcriptReceipt: Pick<
      ClaudeDeliveryTranscriptReceiptReader,
      "inspect"
    > | undefined,
    private readonly requiresClaudeInputProof: boolean,
    private consumedTurnId: string,
  ) {}

  async observe(task: Task, event: SSEEventPayload): Promise<void> {
    const consumedTurnId = turnReceiptId(task);
    if (this.requiresClaudeInputProof) return;
    if (
      this.recorded ||
      event.type === "session" ||
      event.type === "error"
    ) {
      return;
    }
    this.recorded = await this.consumption.recordTurnStarted(task, this.intervention);
    if (this.recorded) this.consumedTurnId = consumedTurnId;
  }

  async consume(task: Task): Promise<void> {
    if (this.consumed) return;
    if (this.requiresClaudeInputProof && !this.recorded) {
      await this.recordFromClaudeInputProof(task);
    }
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

  private async recordFromClaudeInputProof(task: Task): Promise<void> {
    const deliveryId = this.intervention?.deliveryId;
    if (!this.transcriptReceipt) return;
    let receipt: ClaudeDeliveryTranscriptReceipt;
    try {
      receipt = await this.transcriptReceipt.inspect({
        delivery_id: deliveryId!,
        target_session_id: task.agentSessionId,
      });
    } catch {
      return;
    }
    if (
      receipt.kind !== "input_pending" && receipt.kind !== "completed"
    ) {
      return;
    }
    const consumedTurnId = this.consumedTurnId;
    this.recorded = await this.consumption.recordTurnStarted(
      task,
      this.intervention,
      consumedTurnId,
    );
    if (this.recorded) this.consumedTurnId = consumedTurnId;
  }
}

export function turnReceiptId(task: Task): string {
  return `event:${task.lastEventId ?? "unknown"}`;
}

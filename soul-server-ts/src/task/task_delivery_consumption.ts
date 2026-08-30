import type { Logger } from "pino";

import { isDeliveryIntent } from "./delivery_contract.js";
import type { InterventionMessage, Task } from "./task_models.js";
import type { TaskDeliveryLedgerGate } from "./task_delivery_ledger_gate.js";

type ConsumptionRecorder = Pick<
  TaskDeliveryLedgerGate,
  "recordConsumed" | "nextAcceptedForTarget" | "acceptedDelivery"
>;

export class TaskDeliveryConsumption {
  constructor(
    private readonly recorder: ConsumptionRecorder | undefined,
    private readonly logger: Logger,
  ) {}

  async recordConsumed(
    task: Task,
    intervention: InterventionMessage | undefined,
    consumedTurnId?: string,
  ): Promise<void> {
    if (!intervention || !this.recorder) return;
    try {
      if (consumedTurnId === undefined) {
        await this.recorder.recordConsumed(intervention, task);
      } else {
        await this.recorder.recordConsumed(intervention, task, consumedTurnId);
      }
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId, deliveryId: intervention.deliveryId },
        "delivery ledger consume update failed",
      );
      if (requiresExactConsumption(intervention)) {
        // Child result consumption is an exactly-once boundary. Returning
        // success without its relation tombstone lets a later notifier wake
        // and display the already-observed completion again.
        throw err;
      }
    }
  }

  async nextAcceptedForTarget(
    targetSessionId: string,
  ): Promise<InterventionMessage | undefined> {
    return await this.recorder?.nextAcceptedForTarget(targetSessionId);
  }

  async acceptedDelivery(
    deliveryId: string,
    targetSessionId: string,
  ): Promise<InterventionMessage> {
    if (!this.recorder) {
      throw new Error("Delivery consumption recorder is unavailable");
    }
    return await this.recorder.acceptedDelivery(deliveryId, targetSessionId);
  }
}

function requiresExactConsumption(
  intervention: InterventionMessage,
): boolean {
  return isDeliveryIntent(intervention.deliveryIntent)
    || intervention.source === "claude_runtime_task_followup";
}

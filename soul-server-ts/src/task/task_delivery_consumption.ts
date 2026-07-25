import type { Logger } from "pino";

import type { InterventionMessage, Task } from "./task_models.js";
import type { TaskDeliveryLedgerGate } from "./task_delivery_ledger_gate.js";

type ConsumptionRecorder = Pick<
  TaskDeliveryLedgerGate,
  "recordConsumed" | "recordTurnStarted" | "recordTurnFailure"
>;

export class TaskDeliveryConsumption {
  constructor(
    private readonly recorder: ConsumptionRecorder | undefined,
    private readonly logger: Logger,
  ) {}

  async recordConsumed(
    task: Task,
    intervention: InterventionMessage | undefined,
  ): Promise<void> {
    if (!intervention || !this.recorder) return;
    try {
      await this.recorder.recordConsumed(intervention, task);
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId, deliveryId: intervention.deliveryId },
        "delivery ledger consume update failed",
      );
    }
  }

  async recordTurnStarted(
    task: Task,
    intervention: InterventionMessage | undefined,
  ): Promise<void> {
    if (!intervention || !this.recorder) return;
    try {
      await this.recorder.recordTurnStarted(intervention, task);
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId, deliveryId: intervention.deliveryId },
        "delivery ledger turn-start update failed",
      );
    }
  }

  async recordTurnFailure(
    intervention: InterventionMessage | undefined,
  ): Promise<void> {
    if (!intervention || !this.recorder) return;
    try {
      await this.recorder.recordTurnFailure(intervention);
    } catch (err) {
      this.logger.warn(
        { err, deliveryId: intervention.deliveryId },
        "delivery ledger failure update failed",
      );
    }
  }
}

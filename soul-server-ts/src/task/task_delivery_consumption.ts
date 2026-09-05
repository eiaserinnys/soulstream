import type { Logger } from "pino";

import type { InterventionMessage, Task } from "./task_models.js";
import type { TaskDeliveryLedgerGate } from "./task_delivery_ledger_gate.js";
import type { ClaudeBackgroundConsumptionProof } from
  "./claude_background_result_consumption.js";

type ConsumptionRecorder = Pick<
  TaskDeliveryLedgerGate,
  | "recordConsumed"
  | "recordTurnStarted"
  | "discardIfConsumed"
  | "recordConsumptionFailure"
  | "recordRuntimeFollowupRelationConsumed"
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
      await this.recordBookkeepingFailure(task, intervention, err);
    }
  }

  async recordTurnStarted(
    task: Task,
    intervention: InterventionMessage | undefined,
  ): Promise<boolean> {
    if (!intervention || !this.recorder) return false;
    try {
      await this.recorder.recordTurnStarted(intervention, task);
      return true;
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId, deliveryId: intervention.deliveryId },
        "delivery ledger turn-start update failed",
      );
      await this.recordBookkeepingFailure(task, intervention, err);
      return false;
    }
  }

  async discardIfConsumed(
    task: Task,
    intervention: InterventionMessage,
  ): Promise<boolean> {
    if (!this.recorder) return false;
    try {
      return await this.recorder.discardIfConsumed(intervention, task);
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId, deliveryId: intervention.deliveryId },
        "delivery ledger consumed-state check failed",
      );
      await this.recordBookkeepingFailure(task, intervention, err);
      return false;
    }
  }

  async recordRuntimeFollowupRelationConsumed(
    task: Task,
    proof: ClaudeBackgroundConsumptionProof,
    consumedTurnId: string,
  ): Promise<boolean> {
    if (!this.recorder) return false;
    try {
      return await this.recorder.recordRuntimeFollowupRelationConsumed(
        task,
        proof,
        consumedTurnId,
      );
    } catch (err) {
      this.logger.warn(
        {
          err,
          sessionId: task.agentSessionId,
          sdkSessionId: task.codexThreadId,
          taskId: proof.taskId,
        },
        "runtime follow-up relation consumption failed",
      );
      return false;
    }
  }

  private async recordBookkeepingFailure(
    task: Task,
    intervention: InterventionMessage,
    error: unknown,
  ): Promise<void> {
    try {
      await this.recorder?.recordConsumptionFailure(intervention, error);
    } catch (uncertainError) {
      this.logger.warn(
        {
          err: uncertainError,
          sessionId: task.agentSessionId,
          deliveryId: intervention.deliveryId,
          bookkeepingError: error,
        },
        "delivery ledger uncertain-state update failed",
      );
    }
  }
}

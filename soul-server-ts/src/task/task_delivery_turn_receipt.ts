import type { SSEEventPayload } from "../engine/protocol.js";

import { TaskDeliveryConsumption } from "./task_delivery_consumption.js";
import type { InterventionMessage, Task } from "./task_models.js";

interface DeliveryReceipt {
  intervention: InterventionMessage;
  recorded: boolean;
  consumed: boolean;
  consumedTurnId?: string;
  recording?: Promise<void>;
}

/**
 * Owns the durable boundary between SDK input enqueue and observed foreground
 * execution. A fresh Query's session envelope is not proof that it consumed
 * the input, so the delivery remains replayable until a later turn event.
 */
export class TaskDeliveryTurnReceipt {
  private readonly receipts: DeliveryReceipt[] = [];
  private observedTask: Task | undefined;
  private observedTurnId: string | undefined;

  constructor(
    private readonly consumption: TaskDeliveryConsumption,
    interventions: readonly InterventionMessage[],
  ) {
    for (const intervention of interventions) this.add(intervention);
  }

  async register(intervention: InterventionMessage): Promise<void> {
    const receipt = this.add(intervention);
    if (receipt && this.observedTask && this.observedTurnId) {
      await this.record(this.observedTask, receipt, this.observedTurnId);
    }
  }

  private add(intervention: InterventionMessage): DeliveryReceipt | undefined {
    const duplicate = this.receipts.some((receipt) =>
      matchesIntervention(receipt.intervention, intervention)
    );
    if (duplicate) return undefined;
    const receipt: DeliveryReceipt = {
      intervention,
      recorded: false,
      consumed: false,
    };
    this.receipts.push(receipt);
    return receipt;
  }

  hasConsumptionReceipt(intervention: InterventionMessage): boolean {
    return this.receipts.some((receipt) =>
      receipt.recorded && matchesIntervention(receipt.intervention, intervention)
    );
  }

  async observe(task: Task, event: SSEEventPayload): Promise<void> {
    if (event.type === "session" || event.type === "error") return;
    const consumedTurnId = turnReceiptId(task);
    this.observedTask = task;
    this.observedTurnId = consumedTurnId;
    for (const receipt of this.receipts) {
      await this.record(task, receipt, consumedTurnId);
    }
  }

  private async record(
    task: Task,
    receipt: DeliveryReceipt,
    consumedTurnId: string,
  ): Promise<void> {
    if (receipt.recorded) return;
    if (receipt.recording) {
      await receipt.recording;
      return;
    }
    const recording = (async () => {
      receipt.recorded = await this.consumption.recordTurnStarted(
        task,
        receipt.intervention,
      );
      if (receipt.recorded) receipt.consumedTurnId = consumedTurnId;
    })();
    receipt.recording = recording;
    try {
      await recording;
    } finally {
      if (receipt.recording === recording) delete receipt.recording;
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

function matchesIntervention(
  candidate: InterventionMessage,
  intervention: InterventionMessage,
): boolean {
  return intervention.deliveryId !== undefined
    ? candidate.deliveryId === intervention.deliveryId
    : candidate === intervention;
}

function turnReceiptId(task: Task): string {
  return `event:${task.lastEventId ?? "unknown"}`;
}

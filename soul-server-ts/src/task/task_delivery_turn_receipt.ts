import type { SSEEventPayload } from "../engine/protocol.js";
import { readClaudeResultReceiptMetadata } from
  "../engine/claude_result_receipt_metadata.js";

import {
  classifyClaudeBackgroundConsumptionProof,
  type ClaudeToolStartObservation,
} from "./claude_background_result_consumption.js";
import { buildDeliveryInputUuid } from "./delivery_identity.js";
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
  private readonly toolStarts = new Map<string, ClaudeToolStartObservation>();
  private readonly exactResultInputUuids = new Set<string>();

  constructor(
    private readonly consumption: TaskDeliveryConsumption,
    interventions: readonly InterventionMessage[],
  ) {
    for (const intervention of interventions) this.add(intervention);
  }

  async register(intervention: InterventionMessage): Promise<void> {
    const receipt = this.add(intervention);
    if (!receipt) return;
    if (
      isRuntimeFollowup(intervention) &&
      intervention.deliveryId &&
      this.exactResultInputUuids.has(buildDeliveryInputUuid(intervention.deliveryId)) &&
      this.observedTask && this.observedTurnId
    ) {
      await this.record(this.observedTask, receipt, this.observedTurnId);
      return;
    }
    if (
      !isRuntimeFollowup(intervention) &&
      this.observedTask && this.observedTurnId
    ) {
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
    await this.observeExplicitBackgroundResult(task, event);
    if (event.type === "session" || event.type === "error") return;
    const consumedTurnId = turnReceiptId(task);
    this.observedTask = task;
    this.observedTurnId = consumedTurnId;
    const resultReceipt = readClaudeResultReceiptMetadata(event);
    if (resultReceipt) this.exactResultInputUuids.add(resultReceipt.inputUuid);
    for (const receipt of this.receipts) {
      if (isRuntimeFollowup(receipt.intervention)) {
        if (
          resultReceipt &&
          receipt.intervention.deliveryId &&
          resultReceipt.inputUuid ===
            buildDeliveryInputUuid(receipt.intervention.deliveryId)
        ) {
          await this.record(task, receipt, consumedTurnId);
        }
        continue;
      }
      await this.record(task, receipt, consumedTurnId);
    }
  }

  private async observeExplicitBackgroundResult(
    task: Task,
    event: SSEEventPayload,
  ): Promise<void> {
    const payload = event as Record<string, unknown>;
    if (event.type === "tool_start") {
      const toolUseId = stringValue(payload.tool_use_id);
      const toolName = stringValue(payload.tool_name);
      const toolInput = recordValue(payload.tool_input);
      if (toolUseId && toolName && toolInput) {
        this.toolStarts.set(toolUseId, { toolUseId, toolName, toolInput });
      }
      return;
    }
    if (event.type !== "tool_result") return;
    const toolUseId = stringValue(payload.tool_use_id);
    if (!toolUseId) return;
    const start = this.toolStarts.get(toolUseId);
    if (!start) return;
    const proof = classifyClaudeBackgroundConsumptionProof(start, event);
    if (!proof) return;
    await this.consumption.recordRuntimeFollowupRelationConsumed(
      task,
      proof,
      turnReceiptId(task),
    );
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
      if (!receipt.recorded) return;
      receipt.consumedTurnId = consumedTurnId;
      await this.consumption.recordConsumed(
        task,
        receipt.intervention,
        consumedTurnId,
      );
      receipt.consumed = true;
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
      if (isRuntimeFollowup(receipt.intervention)) continue;
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

function isRuntimeFollowup(intervention: InterventionMessage): boolean {
  return intervention.deliveryIntent === "runtime_followup" ||
    intervention.source === "claude_runtime_task_followup";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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

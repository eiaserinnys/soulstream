import { asRecord } from "../engine/claude_sdk_helpers.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import { readClaudeResultReceiptMetadata } from
  "../engine/claude_result_receipt_metadata.js";
import { isUsageLimitStopErrorCode } from "../engine/usage_limit_stop.js";

import {
  classifyClaudeBackgroundConsumptionProof,
  type ClaudeBackgroundConsumptionProof,
  type ClaudeToolStartObservation,
} from "./claude_background_result_consumption.js";
import { buildDeliveryInputUuid } from "./delivery_identity.js";
import { TaskDeliveryConsumption } from "./task_delivery_consumption.js";
import {
  isRuntimeFollowup,
  matchesIntervention,
} from "./task_intervention_queue.js";
import type { InterventionMessage, Task } from "./task_models.js";

interface DeliveryReceipt {
  intervention: InterventionMessage;
  /** Set only after an active runner acknowledged delivery through register(). */
  activeDelivery: boolean;
  /**
   * True once this turn asked the ledger to confirm a turn-start receipt.
   * A failed confirmation keeps the transcript-recovery contract (card #1604).
   */
  recordAttempted: boolean;
  /** Set when the next turn takes this delivery over as its input. */
  carried: boolean;
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
    private readonly onExplicitProofConsumed?: (
      proof: ClaudeBackgroundConsumptionProof,
    ) => void,
  ) {
    for (const intervention of interventions) this.add(intervention);
  }

  async register(intervention: InterventionMessage): Promise<void> {
    const receipt = this.add(intervention);
    receipt.activeDelivery = true;
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

  private add(intervention: InterventionMessage): DeliveryReceipt {
    const duplicate = this.receipts.find((receipt) =>
      matchesIntervention(receipt.intervention, intervention)
    );
    if (duplicate) return duplicate;
    const receipt: DeliveryReceipt = {
      intervention,
      activeDelivery: false,
      recordAttempted: false,
      carried: false,
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
    const payload = event as Record<string, unknown>;
    const isUsageLimitFatalError = event.type === "error" &&
      payload.fatal === true &&
      isUsageLimitStopErrorCode(payload.error_code);
    if (
      event.type === "session"
      || (event.type === "error" && !isUsageLimitFatalError)
      || event.type === "input_material_manifest"
      || event.type === "usage_observation"
    ) return;
    const consumedTurnId = turnReceiptId(task);
    this.observedTask = task;
    this.observedTurnId = consumedTurnId;
    const resultReceipt = readClaudeResultReceiptMetadata(event);
    if (resultReceipt) this.exactResultInputUuids.add(resultReceipt.inputUuid);
    for (const receipt of this.receipts) {
      if (isRuntimeFollowup(receipt.intervention)) {
        const hasExactInputReceipt = resultReceipt &&
          receipt.intervention.deliveryId &&
          resultReceipt.inputUuid ===
            buildDeliveryInputUuid(receipt.intervention.deliveryId);
        // A running delivery is acknowledged only after the active engine
        // accepted it and a later turn event arrives. Queued runtime follow-ups
        // retain the exact input UUID path, so the two receipt owners do not
        // consume the same delivery.
        if (receipt.activeDelivery || hasExactInputReceipt) {
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
      const toolInput = asRecord(payload.tool_input);
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
    const proof = classifyClaudeBackgroundConsumptionProof(
      start, event, Object.values(task.claudeRuntime?.tasks ?? {}),
    );
    if (!proof) return;
    const consumed = await this.consumption.recordRuntimeFollowupRelationConsumed(
      task,
      proof,
      turnReceiptId(task),
    );
    if (consumed) this.onExplicitProofConsumed?.(proof);
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
      receipt.recordAttempted = true;
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

  /**
   * Closes the deliveries that entered this turn once the turn has ended,
   * whether it completed or failed. A recorded receipt is written as consumed; a
   * delivery without evidence is closed as an admission failure so transcript
   * recovery cannot replay it after a node reconnect. A delivery that is back in
   * the intervention queue belongs to the next turn and is left alone.
   */
  async settleEndedTurn(task: Task): Promise<void> {
    for (const receipt of this.receipts) {
      if (receipt.consumed) continue;
      // A delivery the next turn took over is settled by that turn's receipt.
      if (receipt.carried) continue;
      if (receipt.recorded) {
        await this.consumption.recordConsumed(
          task,
          receipt.intervention,
          receipt.consumedTurnId,
        );
        receipt.consumed = true;
        continue;
      }
      if (queuedForNextTurn(task, receipt.intervention)) continue;
      await this.consumption.recordAdmissionFailure(
        task,
        receipt.intervention,
        "delivery turn ended without a consumption receipt",
      );
    }
  }

  /**
   * Deliveries this ended turn leaves open, in arrival order. The turn was
   * interrupted before any observed event confirmed them, so the next turn
   * re-sends their bodies as its input and its receipt owns them; this receipt
   * must not settle them (card #1604). Runtime follow-ups keep their exact
   * Result proof, and a delivery whose turn-start receipt was attempted stays
   * with transcript recovery.
   */
  carryUnrecordedDeliveries(task: Task): InterventionMessage[] {
    const carried: InterventionMessage[] = [];
    for (const receipt of this.receipts) {
      if (receipt.carried || receipt.consumed || receipt.recorded) continue;
      if (receipt.recordAttempted) continue;
      if (isRuntimeFollowup(receipt.intervention)) continue;
      if (queuedForNextTurn(task, receipt.intervention)) continue;
      receipt.carried = true;
      carried.push(receipt.intervention);
    }
    return carried;
  }
}

function queuedForNextTurn(
  task: Task,
  intervention: InterventionMessage,
): boolean {
  return task.interventionQueue.some((queued) =>
    matchesIntervention(queued, intervention)
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function turnReceiptId(task: Task): string {
  return `event:${task.lastEventId ?? "unknown"}`;
}

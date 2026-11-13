import { withDeadline } from "../runtime/deadline.js";
import type { Logger } from "pino";

import type { SessionDeliveryHostClient } from
  "../control_plane/persistence_host_clients.js";
import type { SessionDeliveryRow } from "../db/session_db_types.js";
import type { SessionDeliveryRecoveryHostClient } from
  "../control_plane/persistence_host_clients.js";
import {
  UNSUPPORTED_BACKEND_REASON,
  type ClaudeDeliveryTranscriptReceiptReader,
} from "../engine/claude_delivery_transcript_receipt.js";
import {
  INSTRUCTION_UNCERTAIN_REASON,
  decideNodeInstruction,
  type NodeInstructionVerdict,
} from "./state/node_instruction_decision.js";

export interface QueuedDeliveryTranscriptRecoveryDeps {
  deliveryRepository: Pick<
    SessionDeliveryHostClient,
    "get" | "markConsumed" | "markUncertain" | "retryDeliveryAttempt"
  >;
  recoveryRepository: Pick<
    SessionDeliveryRecoveryHostClient,
    "claimQueuedAfterNodeRestart" | "markDeliveredFromTranscript"
  >;
  transcriptReceipt: Pick<
    ClaudeDeliveryTranscriptReceiptReader,
    "inspect"
  >;
  /**
   * Asks the runner that holds the target session whether it received this
   * delivery's instruction number. Anything the node cannot prove is "unknown".
   * Production always supplies it. A harness that leaves it out keeps the
   * transcript as the only proof: an absent input is redelivered and a backend
   * without a transcript stays held.
   */
  instructionReceipt?: {
    lookup(row: SessionDeliveryRow): Promise<NodeInstructionVerdict>;
  };
  /** Re-enters the ordinary durable intervention route with the same row. */
  redeliverContent?(row: SessionDeliveryRow): Promise<void>;
  logger: Pick<Logger, "warn">;
}

export interface QueuedDeliveryTranscriptRecoveryPass {
  claimed: number;
  settled: number;
}

/**
 * Reconciles one SDK receiver receipt pass during node-startup recovery.
 *
 * A stable input UUID prevents duplicate execution, but SDK 0.3.218 does not
 * emit another Result when that UUID is re-sent after resume. A completed
 * transcript therefore settles the ledger directly. An accepted input that is
 * still pending returns to reconnect admission.
 *
 * Every other row (an absent Claude input, or a backend with no Claude
 * transcript such as Codex) is judged by asking the runner for the delivery's
 * instruction number. An absent Claude input is already proven unseen by its
 * transcript, so only an "applied" answer changes its redelivery. Applied closes the row as consumed, a runner of the same
 * registration that never received it re-enters durable intervention after
 * spending the ordinary retry budget (an exhausted row becomes dead-lettered
 * without waking its target again), and anything else is left `uncertain` so
 * the next node start does not pick it up again and nothing is sent twice.
 * Older nodes without that capability retain the R18 dead-letter fallback.
 */
/**
 * One claim covers the whole batch, so the batch — not just one row — has to
 * finish inside the attempt TTL. Reading a transcript is bounded, and the loop stops
 * accepting new rows once too little TTL remains to cover another read, so
 * stale-attempt recovery never returns a row to `queued` underneath its own token.
 */
const TRANSCRIPT_ATTEMPT_TTL_MS = 60_000;
const TRANSCRIPT_READ_TIMEOUT_MS = 10_000;

export class QueuedDeliveryTranscriptRecovery {
  constructor(
    private readonly deps: QueuedDeliveryTranscriptRecoveryDeps,
    private readonly workerId: string,
    private readonly attemptTtlMs = TRANSCRIPT_ATTEMPT_TTL_MS,
    private readonly readTimeoutMs = TRANSCRIPT_READ_TIMEOUT_MS,
  ) {
    if (readTimeoutMs >= attemptTtlMs) {
      throw new Error(
        `Transcript read timeout ${readTimeoutMs}ms must be shorter than the ${attemptTtlMs}ms attempt TTL`,
      );
    }
  }

  async recoverAfterNodeRestart(
    nodeId: string,
    limit = 100,
  ): Promise<QueuedDeliveryTranscriptRecoveryPass> {
    const rows = await this.deps.recoveryRepository
      .claimQueuedAfterNodeRestart(
        nodeId,
        this.workerId,
        limit,
        this.attemptTtlMs,
        // A transcript receipt is delivery proof. Boot recovery must not turn a
        // delivered follow-up back into a queued user message.
        false,
      );
    return {
      claimed: rows.length,
      settled: await this.reconcile(rows),
    };
  }

  private async reconcile(
    rows: Awaited<
      ReturnType<SessionDeliveryRecoveryHostClient["claimQueuedAfterNodeRestart"]>
    >,
  ): Promise<number> {
    let settled = 0;
    const startedAtMs = Date.now();
    // Leave one read's worth of TTL so a row started here cannot outlive it.
    // A row can spend one transcript read and one runner lookup.
    const acceptUntilMs = startedAtMs + (this.attemptTtlMs - this.readTimeoutMs * 2);
    for (const row of rows) {
      if (Date.now() >= acceptUntilMs) {
        await this.returnToPending(
          row.delivery_id,
          "queued_transcript_probe_budget_exhausted",
        );
        continue;
      }
      try {
        const receipt = await withDeadline(
          this.deps.transcriptReceipt.inspect(row),
          this.readTimeoutMs,
          () => new Error(
            `queued transcript read for ${row.delivery_id} exceeded ${this.readTimeoutMs}ms`,
          ),
        );
        if (receipt.kind === "completed") {
          const receiptId = `transcript:${receipt.assistantMessageUuid}`;
          await this.deps.recoveryRepository.markDeliveredFromTranscript(
            row.delivery_id,
            this.workerId,
            receipt.assistantMessageUuid,
          );
          const consumed = await this.deps.deliveryRepository.markConsumed(
            row.delivery_id,
            receiptId,
          );
          const settledRow = consumed
            ?? await this.deps.deliveryRepository.get(row.delivery_id);
          if (
            settledRow?.state !== "consumed"
            || settledRow.aggregate_state !== "consumed"
            || settledRow.target_receipt_id !== receiptId
          ) {
            throw new Error(
              `Transcript-proven delivery ${row.delivery_id} did not reach consumed`,
            );
          }
          settled += 1;
          continue;
        }
        if (
          this.deps.instructionReceipt
          && (receipt.kind === "absent"
            || (receipt.kind === "unavailable" && receipt.reason === UNSUPPORTED_BACKEND_REASON))
        ) {
          settled += await this.settleByInstructionReceipt(
            row,
            this.deps.instructionReceipt,
            receipt.kind === "absent",
          );
          continue;
        }
        if (receipt.kind === "absent") {
          settled += await this.redeliverUnseen(row);
          continue;
        }
        const reason = receipt.kind === "input_pending"
          ? "queued_transcript_input_pending"
          : receipt.reason;
        await this.returnToPending(row.delivery_id, reason);
      } catch (err) {
        await this.returnToPending(
          row.delivery_id,
          `queued_transcript_read_failed:${errorText(err)}`,
        );
        this.deps.logger.warn(
          { err, deliveryId: row.delivery_id },
          "Queued delivery transcript reconciliation returned input to pending",
        );
      }
    }
    return settled;
  }

  /** Judges a row no transcript could settle by the runner's answer to its instruction number. */
  private async settleByInstructionReceipt(
    row: SessionDeliveryRow,
    instructionReceipt: NonNullable<QueuedDeliveryTranscriptRecoveryDeps["instructionReceipt"]>,
    transcriptProvesUnseen: boolean,
  ): Promise<number> {
    let verdict: NodeInstructionVerdict;
    try {
      verdict = await withDeadline(
        instructionReceipt.lookup(row),
        this.readTimeoutMs,
        () => new Error(
          `instruction receipt lookup for ${row.delivery_id} exceeded ${this.readTimeoutMs}ms`,
        ),
      );
    } catch (err) {
      this.deps.logger.warn(
        { err, deliveryId: row.delivery_id },
        "Instruction receipt lookup failed during queued delivery recovery; treating it as unknown",
      );
      verdict = "unknown";
    }
    // A Claude transcript that lacks the input proves it was never seen, which a
    // runner that cannot answer does not overturn. Only the runner saying it
    // applied the instruction stops the redelivery. A backend with no transcript
    // has no such proof, so its unknown stays unknown.
    if (transcriptProvesUnseen && verdict === "unknown") verdict = "not_applied";
    const decision = decideNodeInstruction({ verdict, ledger: "line" });
    if (decision.ledger === "close_consumed") {
      const receiptId = `runner_receipt:${row.delivery_id}`;
      const consumed = await this.deps.deliveryRepository.markConsumed(
        row.delivery_id,
        receiptId,
      );
      const settledRow = consumed
        ?? await this.deps.deliveryRepository.get(row.delivery_id);
      if (settledRow?.state !== "consumed" || settledRow.aggregate_state !== "consumed") {
        throw new Error(
          `Runner-receipt delivery ${row.delivery_id} did not reach consumed`,
        );
      }
      return 1;
    }
    if (decision.ledger === "mark_uncertain") {
      const uncertain = await this.deps.deliveryRepository.markUncertain(
        row.delivery_id,
        this.workerId,
        INSTRUCTION_UNCERTAIN_REASON,
      );
      const settledRow = uncertain
        ?? await this.deps.deliveryRepository.get(row.delivery_id);
      if (
        settledRow?.state !== "uncertain"
        || settledRow.aggregate_state !== "dead_letter"
      ) {
        throw new Error(
          `Unknown-receipt delivery ${row.delivery_id} did not reach dead letter`,
        );
      }
      return 1;
    }
    return await this.redeliverUnseen(row);
  }

  /** The runner or transcript proved the target never saw the content. */
  private async redeliverUnseen(row: SessionDeliveryRow): Promise<number> {
    if (this.deps.redeliverContent) {
      const current = await this.deps.deliveryRepository.get(row.delivery_id);
      if (hasConsumptionReceipt(current)) return 1;
      const retry = await this.deps.deliveryRepository.retryDeliveryAttempt(
        row.delivery_id,
        this.workerId,
        "queued_transcript_redelivery_expired",
        0,
      );
      if (!retry) {
        const settledRow = await this.deps.deliveryRepository.get(row.delivery_id);
        if (hasConsumptionReceipt(settledRow)) return 1;
        throw new Error(
          `Transcript-absent delivery ${row.delivery_id} lost its retry-state CAS`,
        );
      }
      if (retry.aggregate_state === "dead_letter") return 1;
      await this.deps.redeliverContent(retry);
      return 1;
    }
    const uncertain = await this.deps.deliveryRepository.markUncertain(
      row.delivery_id,
      this.workerId,
      "queued_transcript_input_absent",
    );
    const settledRow = uncertain
      ?? await this.deps.deliveryRepository.get(row.delivery_id);
    if (
      settledRow?.state !== "uncertain"
      || settledRow.aggregate_state !== "dead_letter"
    ) {
      throw new Error(
        `Transcript-absent delivery ${row.delivery_id} did not reach dead letter`,
      );
    }
    return 1;
  }

  private async returnToPending(
    deliveryId: string,
    reason: string,
  ): Promise<void> {
    await this.deps.deliveryRepository.retryDeliveryAttempt(
      deliveryId,
      this.workerId,
      reason,
      0,
    );
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasConsumptionReceipt(row: SessionDeliveryRow | null): boolean {
  return row?.state === "consumed"
    && row.aggregate_state === "consumed"
    && Boolean(row.target_receipt_id);
}

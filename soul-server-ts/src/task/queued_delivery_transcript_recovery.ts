import { withDeadline } from "../runtime/deadline.js";
import type { Logger } from "pino";

import type { SessionDeliveryRepository } from
  "../db/repositories/session_delivery_repository.js";
import type { SessionDeliveryRow } from "../db/session_db_types.js";
import type { SessionDeliveryRecoveryRepository } from
  "../db/repositories/session_delivery_recovery_repository.js";
import type {
  ClaudeDeliveryTranscriptReceiptReader,
} from "../engine/claude_delivery_transcript_receipt.js";

export interface QueuedDeliveryTranscriptRecoveryDeps {
  deliveryRepository: Pick<
    SessionDeliveryRepository,
    "get" | "markConsumed" | "markUncertain" | "retryLeasedDelivery"
  >;
  recoveryRepository: Pick<
    SessionDeliveryRecoveryRepository,
    "claimQueuedAfterNodeRestart" | "markDeliveredFromTranscript"
  >;
  transcriptReceipt: Pick<
    ClaudeDeliveryTranscriptReceiptReader,
    "inspect"
  >;
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
 * still pending returns to reconnect admission. An absent stable identity is
 * conclusive proof that the target has not seen the content, so a current node
 * re-enters the ordinary durable intervention route with the original row.
 * Older nodes without that capability retain the R18 dead-letter fallback.
 */
/**
 * One claim covers the whole batch, so the batch — not just one row — has to
 * finish inside the lease. Reading a transcript is bounded, and the loop stops
 * accepting new rows once too little lease remains to cover another read, so
 * the sweeper never returns a row to `queued` underneath its own owner.
 */
const TRANSCRIPT_LEASE_MS = 60_000;
const TRANSCRIPT_READ_TIMEOUT_MS = 10_000;

export class QueuedDeliveryTranscriptRecovery {
  constructor(
    private readonly deps: QueuedDeliveryTranscriptRecoveryDeps,
    private readonly workerId: string,
    private readonly leaseMs = TRANSCRIPT_LEASE_MS,
    private readonly readTimeoutMs = TRANSCRIPT_READ_TIMEOUT_MS,
  ) {
    if (readTimeoutMs >= leaseMs) {
      throw new Error(
        `Transcript read timeout ${readTimeoutMs}ms must be shorter than the ${leaseMs}ms lease`,
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
        this.leaseMs,
        this.deps.redeliverContent !== undefined,
      );
    return {
      claimed: rows.length,
      settled: await this.reconcile(rows),
    };
  }

  private async reconcile(
    rows: Awaited<
      ReturnType<SessionDeliveryRecoveryRepository["claimQueuedAfterNodeRestart"]>
    >,
  ): Promise<number> {
    let settled = 0;
    const startedAtMs = Date.now();
    // Leave one read's worth of lease so a row started here cannot outlive it.
    const acceptUntilMs = startedAtMs + (this.leaseMs - this.readTimeoutMs);
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
        if (receipt.kind === "absent") {
          if (this.deps.redeliverContent) {
            await this.deps.redeliverContent(row);
            settled += 1;
            continue;
          }
          const reason = "queued_transcript_input_absent";
          const uncertain = await this.deps.deliveryRepository.markUncertain(
            row.delivery_id,
            this.workerId,
            reason,
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
          settled += 1;
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

  private async returnToPending(
    deliveryId: string,
    reason: string,
  ): Promise<void> {
    await this.deps.deliveryRepository.retryLeasedDelivery(
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

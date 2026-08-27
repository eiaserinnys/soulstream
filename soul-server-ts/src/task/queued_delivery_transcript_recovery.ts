import { withDeadline } from "../runtime/deadline.js";
import type { Logger } from "pino";

import type { SessionDeliveryRepository } from
  "../db/repositories/session_delivery_repository.js";
import type { SessionDeliveryRecoveryRepository } from
  "../db/repositories/session_delivery_recovery_repository.js";
import type {
  ClaudeDeliveryTranscriptReceiptReader,
} from "../engine/claude_delivery_transcript_receipt.js";

export interface QueuedDeliveryTranscriptRecoveryDeps {
  deliveryRepository: Pick<
    SessionDeliveryRepository,
    "get" | "markConsumed" | "retryLeasedDelivery"
  >;
  recoveryRepository: Pick<
    SessionDeliveryRecoveryRepository,
    | "claimQueuedAfterNodeRestart"
    | "markDeliveredFromTranscript"
    | "deferQueuedTranscriptCheck"
  >;
  transcriptReceipt: Pick<
    ClaudeDeliveryTranscriptReceiptReader,
    "inspect"
  >;
  logger: Pick<Logger, "warn">;
}

/**
 * Reconciles the SDK receiver receipt once during node-startup recovery.
 *
 * A stable input UUID prevents duplicate execution, but SDK 0.3.218 does not
 * emit another Result when that UUID is re-sent after resume. A completed
 * transcript therefore settles the ledger directly. An absent or incomplete
 * receipt returns the same delivery to queued/held state. Periodic maintenance
 * does not consume or re-inject it; only a later explicit intent may claim it.
 */
/** Delay recorded with a deferred one-shot check; it is not an execution timer. */
const QUEUED_HOLD_METADATA_DELAY_MS = 1_000;
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
  ): Promise<number> {
    const rows = await this.deps.recoveryRepository
      .claimQueuedAfterNodeRestart(
        nodeId,
        this.workerId,
        limit,
        this.leaseMs,
      );
    return await this.reconcile(rows);
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
    let deferredForLease = 0;
    for (const row of rows) {
      if (Date.now() >= acceptUntilMs) {
        deferredForLease += 1;
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
          await this.defer(row.delivery_id, "queued_transcript_input_absent");
          continue;
        }
        const reason = receipt.kind === "input_pending"
          ? "queued_transcript_input_pending"
          : receipt.reason;
        await this.defer(row.delivery_id, reason);
      } catch (err) {
        await this.defer(
          row.delivery_id,
          `queued_transcript_read_failed:${errorText(err)}`,
        );
        this.deps.logger.warn(
          { err, deliveryId: row.delivery_id },
          "Queued delivery transcript reconciliation deferred",
        );
      }
    }
    if (deferredForLease > 0) {
      this.deps.logger.warn(
        { deferredForLease, claimed: rows.length, leaseMs: this.leaseMs },
        "Queued transcript startup batch ran out of lease; remaining rows stay held",
      );
    }
    return settled;
  }

  private async defer(deliveryId: string, reason: string): Promise<void> {
    await this.deps.recoveryRepository.deferQueuedTranscriptCheck(
      deliveryId,
      this.workerId,
      reason,
      QUEUED_HOLD_METADATA_DELAY_MS,
    );
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

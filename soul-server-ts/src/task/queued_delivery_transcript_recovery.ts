import type { Logger } from "pino";

import type { SessionDeliveryRepository } from
  "../db/repositories/session_delivery_repository.js";
import type {
  QueuedDeliveryRecoveryScan,
  SessionDeliveryRecoveryRepository,
} from "../db/repositories/session_delivery_recovery_repository.js";
import type {
  ClaudeDeliveryTranscriptReceiptReader,
} from "../engine/claude_delivery_transcript_receipt.js";

export interface QueuedDeliveryTranscriptRecoveryDeps {
  deliveryRepository: Pick<
    SessionDeliveryRepository,
    "retryLeasedDelivery"
  >;
  recoveryRepository: Pick<
    SessionDeliveryRecoveryRepository,
    | "claimQueuedAfterNodeRestart"
    | "claimRecoverableQueued"
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
 * Reconciles the SDK receiver receipt before replaying queued delivery input.
 *
 * A stable input UUID prevents duplicate execution, but SDK 0.3.218 does not
 * emit another Result when that UUID is re-sent after resume. A completed
 * transcript therefore settles the ledger directly; an input without its
 * assistant result remains queued and is polled instead of being re-injected.
 */
/** Poll cadence for a transcript that has not yet settled. */
const TRANSCRIPT_RECHECK_DELAY_MS = 1_000;

export class QueuedDeliveryTranscriptRecovery {
  constructor(
    private readonly deps: QueuedDeliveryTranscriptRecoveryDeps,
    private readonly workerId: string,
    private readonly leaseMs = 15_000,
  ) {}

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

  async recoverPeriodic(
    scan: QueuedDeliveryRecoveryScan,
    limit = 100,
  ): Promise<number> {
    const rows = await this.deps.recoveryRepository.claimRecoverableQueued(
      scan,
      this.workerId,
      limit,
      this.leaseMs,
    );
    return await this.reconcile(rows);
  }

  private async reconcile(
    rows: Awaited<
      ReturnType<SessionDeliveryRecoveryRepository["claimRecoverableQueued"]>
    >,
  ): Promise<number> {
    let settled = 0;
    for (const row of rows) {
      try {
        const receipt = await this.deps.transcriptReceipt.inspect(row);
        if (receipt.kind === "completed") {
          const delivered = await this.deps.recoveryRepository
            .markDeliveredFromTranscript(
              row.delivery_id,
              this.workerId,
              receipt.assistantMessageUuid,
            );
          if (delivered) settled += 1;
          continue;
        }
        if (receipt.kind === "absent") {
          const replayable = await this.deps.deliveryRepository.retryLeasedDelivery(
            row.delivery_id,
            this.workerId,
            "queued_transcript_input_absent",
            0,
          );
          if (replayable) settled += 1;
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
    return settled;
  }

  private async defer(deliveryId: string, reason: string): Promise<void> {
    await this.deps.recoveryRepository.deferQueuedTranscriptCheck(
      deliveryId,
      this.workerId,
      reason,
      TRANSCRIPT_RECHECK_DELAY_MS,
    );
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

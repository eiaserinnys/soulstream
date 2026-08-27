import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import { withDeadline } from "../runtime/deadline.js";

import type { AddInterventionParams } from "./task_intervention_route.js";
import {
  buildDeterministicDeliveryIdentity,
} from "./delivery_identity.js";
import {
  buildCanonicalDeliveryPayload,
  readCanonicalDeliveryPayload,
} from "./delivery_payload.js";
import type { CallerInfo } from "./task_models.js";
import {
  DELIVERY_NOTIFICATION_MAX_AGE_MS,
  DELIVERY_NOTIFICATION_MAX_ATTEMPTS,
  deliveryRetryDelayMs,
} from "./session_delivery_notification_policy.js";
import type { SessionDeliveryRepository } from "../db/repositories/session_delivery_repository.js";
import type {
  RegisterSessionDeliveryParams,
  SessionDeliveryRow,
} from "../db/session_db_types.js";

export interface DurableCompletionInput {
  targetSessionId: string;
  sourceSessionId: string;
  terminalRevision: string;
  text: string;
  callerInfo: CallerInfo;
  createdAt: Date;
}

type CompletionDeliveryRepository = Pick<
  SessionDeliveryRepository,
  | "register"
  | "get"
  | "claimForTarget"
  | "deferPending"
  | "retryLeasedDelivery"
  | "releaseExpiredDeliveryLeases"
  | "markUncertain"
>;

export interface CompletionDeliveryCoordinatorDeps {
  repository: CompletionDeliveryRepository;
  dispatch(params: AddInterventionParams): Promise<void>;
  logger: Pick<Logger, "error" | "warn" | "info">;
}

/**
 * Durable owner of completion delivery admission.
 *
 * Registration always precedes target claiming, so a transient failure leaves a
 * replayable `pending` row instead of losing the finalizer's only call.
 */
export class DeliveryDispatchTimeoutError extends Error {
  constructor(readonly deliveryId: string, readonly timeoutMs: number) {
    super(`Delivery ${deliveryId} dispatch exceeded ${timeoutMs}ms`);
    this.name = "DeliveryDispatchTimeoutError";
  }
}

export class CompletionDeliveryCoordinator {
  private readonly workerId: string;

  /**
   * `leaseMs` must exceed `dispatchTimeoutMs`.
   *
   * The lease is what stops a second worker from re-dispatching a delivery that
   * is still in flight. When a dispatch could outlive its lease — which an
   * unbounded dispatch always could — `releaseExpiredDeliveryLeases` returned
   * the row to `pending` underneath its own owner and the next scan claimed it
   * again (260820 incident).
   *
   * Periodic recovery only releases abandoned admission leases. It never
   * dispatches accepted input; a new explicit intent must claim it again.
   */
  constructor(
    private readonly deps: CompletionDeliveryCoordinatorDeps,
    workerId = `completion:${randomUUID()}`,
    private readonly leaseMs = 60_000,
    private readonly dispatchTimeoutMs = 15_000,
  ) {
    if (dispatchTimeoutMs >= leaseMs) {
      throw new Error(
        `Delivery dispatch timeout ${dispatchTimeoutMs}ms must be shorter than the ${leaseMs}ms lease`,
      );
    }
    this.workerId = workerId;
  }

  async enqueue(input: DurableCompletionInput): Promise<void> {
    const registration = buildCompletionRegistration(input);
    let registered;
    try {
      registered = await this.deps.repository.register(registration);
    } catch (err) {
      this.deps.logger.error(
        { err, sourceSessionId: input.sourceSessionId },
        "Completion delivery could not be persisted",
      );
      return;
    }
    if (registered.conflict) {
      this.deps.logger.error(
        { deliveryId: registered.row.delivery_id },
        "Completion delivery identity conflict",
      );
      return;
    }
    await this.attemptPending(registered.row.delivery_id);
  }

  async recoverPending(_limit = 100): Promise<void> {
    try {
      await this.deps.repository.releaseExpiredDeliveryLeases();
    } catch (err) {
      this.deps.logger.warn({ err }, "Completion delivery recovery scan failed");
    }
  }

  private async attemptPending(deliveryId: string): Promise<void> {
    try {
      const current = await this.deps.repository.get(deliveryId);
      if (!current || !isRecoverable(current)) return;
      const claimed = await this.deps.repository.claimForTarget(
        deliveryId,
        requiredTarget(current),
        this.workerId,
        this.leaseMs,
      );
      if (!claimed) {
        await this.deps.repository.deferPending(
          deliveryId,
          "no_current_target",
          deliveryRetryDelayMs(current.attempt_count),
        );
        return;
      }
      await this.dispatchClaimed(claimed);
    } catch (err) {
      this.deps.logger.warn(
        { err, deliveryId },
        "Completion delivery attempt deferred for durable recovery",
      );
    }
  }

  private async dispatchClaimed(row: SessionDeliveryRow): Promise<void> {
    const leaseOwner = requiredLeaseOwner(row);
    const targetSessionId = requiredTarget(row);
    // TaskCompletionNotifier.notify() is the explicit admission boundary. The
    // dispatch below belongs only to that enqueue attempt; periodic maintenance
    // cannot enter this method or create execution intent.
    if (isStaleSelfCompletionDelivery(row, targetSessionId)) {
      try {
        const terminal = await this.deps.repository.markUncertain(
          row.delivery_id,
          leaseOwner,
          "stale_self_completion_delivery",
        );
        this.deps.logger.info(
          {
            deliveryId: row.delivery_id,
            sourceSessionId: row.source_session_id,
            targetSessionId,
            terminalized: terminal !== null,
          },
          "Stale self completion delivery suppressed during durable recovery",
        );
      } catch (err) {
        this.deps.logger.warn(
          { err, deliveryId: row.delivery_id, sourceSessionId: row.source_session_id },
          "Stale self completion delivery suppression could not be terminalized; recovery will retry",
        );
      }
      return;
    }
    try {
      await withDeadline(
        this.deps.dispatch(toInterventionParams(row, leaseOwner)),
        this.dispatchTimeoutMs,
        () => new DeliveryDispatchTimeoutError(
          row.delivery_id,
          this.dispatchTimeoutMs,
        ),
      );
    } catch (err) {
      const failure = errorText(err);
      const persisted = await this.deps.repository.get(row.delivery_id);
      if (persisted?.state === "queued") {
        this.deps.logger.info(
          { deliveryId: row.delivery_id, state: persisted.state },
          "Completion delivery dispatch returned ambiguously after durable acceptance",
        );
        return;
      }
      if (isRetryExhausted(row)) {
        const terminal = await this.deps.repository.markUncertain(
          row.delivery_id,
          leaseOwner,
          failure,
        );
        this.deps.logger.warn(
          {
            err,
            deliveryId: row.delivery_id,
            attemptCount: row.attempt_count + 1,
            terminalized: terminal !== null,
          },
          "Completion delivery retry budget exhausted; delivery terminalized as uncertain",
        );
        return;
      }
      const retried = await this.deps.repository.retryLeasedDelivery(
        row.delivery_id,
        leaseOwner,
        failure,
        deliveryRetryDelayMs(row.attempt_count),
      );
      if (!retried) {
        this.deps.logger.warn(
          { err, deliveryId: row.delivery_id },
          "Completion delivery retry not scheduled because the dispatch lease was lost",
        );
        return;
      }
      this.deps.logger.warn(
        { err, deliveryId: row.delivery_id },
        "Completion delivery dispatch failed; durable retry scheduled",
      );
    }
  }
}

function isStaleSelfCompletionDelivery(
  row: SessionDeliveryRow,
  targetSessionId: string,
): boolean {
  return row.intent === "completion_notification"
    && row.source_session_id !== null
    && row.source_session_id === targetSessionId;
}

function isRetryExhausted(row: SessionDeliveryRow, nowMs = Date.now()): boolean {
  return row.attempt_count + 1 >= DELIVERY_NOTIFICATION_MAX_ATTEMPTS
    || nowMs - row.created_at.getTime() >= DELIVERY_NOTIFICATION_MAX_AGE_MS;
}

function buildCompletionRegistration(
  input: DurableCompletionInput,
): RegisterSessionDeliveryParams {
  const relationKey =
    `child_session:${input.sourceSessionId}:${input.terminalRevision}`;
  const identity = buildDeterministicDeliveryIdentity({
    targetSessionId: input.targetSessionId,
    relationKey,
    intent: "completion_notification",
  });
  const canonical = buildCanonicalDeliveryPayload({
    text: input.text,
    user: "agent",
    source: "completion_notifier",
    completionId: identity.completionId,
    relationKey,
    callerInfo: input.callerInfo,
  });
  return {
    deliveryId: identity.deliveryId,
    targetSessionId: input.targetSessionId,
    sourceSessionId: input.sourceSessionId,
    relationKey,
    completionId: identity.completionId,
    intent: "completion_notification",
    source: "completion_notifier",
    producerKind: "child_session",
    producerId: input.sourceSessionId,
    producerTerminalRevision: input.terminalRevision,
    payloadHash: canonical.payloadHash,
    payload: canonical.payload,
    createdAt: input.createdAt,
  };
}

function toInterventionParams(
  row: SessionDeliveryRow,
  leaseOwner: string,
): AddInterventionParams {
  const message = readCanonicalDeliveryPayload(row.payload);
  return {
    agentSessionId: requiredTarget(row),
    text: message.text,
    user: message.user,
    callerInfo: message.callerInfo,
    attachmentPaths: message.attachmentPaths,
    context: message.context,
    source: row.source,
    deliveryId: row.delivery_id,
    deliveryIntent: row.intent,
    completionId: row.completion_id ?? undefined,
    relationKey: row.relation_key,
    producerTerminalRevision: row.producer_terminal_revision ?? undefined,
    parentDeliveryId: row.parent_delivery_id ?? undefined,
    callerTurnId: row.caller_turn_id ?? undefined,
    followupKey: message.followupKey,
    followupAttempt: message.followupAttempt,
    followupTaskIds: message.followupTaskIds,
    deliveryCreatedAt: row.created_at.toISOString(),
    deliveryLeaseOwner: leaseOwner,
    storedDeliveryPayload: row.payload,
    storedDeliveryPayloadHash: row.payload_hash,
  };
}

function isRecoverable(row: SessionDeliveryRow): boolean {
  return row.state === "pending" || row.state === "claimed";
}

function requiredTarget(row: SessionDeliveryRow): string {
  if (!row.target_session_id) {
    throw new Error(`Delivery ${row.delivery_id} has no resolved target`);
  }
  return row.target_session_id;
}

function requiredLeaseOwner(row: SessionDeliveryRow): string {
  if (!row.lease_owner) {
    throw new Error(`Delivery ${row.delivery_id} has no lease owner`);
  }
  return row.lease_owner;
}


function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

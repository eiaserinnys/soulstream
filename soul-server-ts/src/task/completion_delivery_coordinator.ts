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
  | "claimRecoverableCompletionDeliveries"
  | "releaseExpiredDeliveryLeases"
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
   * Immediate and periodic recovery both enter the same claim-and-dispatch
   * function. The lease only schedules an owner; timeout cannot terminate the
   * accepted delivery.
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
    try {
      await this.claimAndDispatch(registered.row.delivery_id, 1);
    } catch (err) {
      this.deps.logger.warn(
        { err, deliveryId: registered.row.delivery_id },
        "Completion delivery remains pending after claim scheduling failed",
      );
    }
  }

  async recoverPending(limit = 100): Promise<void> {
    try {
      await this.deps.repository.releaseExpiredDeliveryLeases();
      await this.claimAndDispatch(undefined, limit);
    } catch (err) {
      this.deps.logger.warn({ err }, "Completion delivery recovery scan failed");
    }
  }

  private async claimAndDispatch(
    deliveryId: string | undefined,
    limit: number,
  ): Promise<void> {
    const claimed = await this.deps.repository.claimRecoverableCompletionDeliveries(
      this.workerId,
      limit,
      this.leaseMs,
      deliveryId,
    );
    for (const row of claimed) await this.dispatchClaimed(row);
  }

  private async dispatchClaimed(row: SessionDeliveryRow): Promise<void> {
    const leaseOwner = requiredLeaseOwner(row);
    const targetSessionId = requiredTarget(row);
    // TaskCompletionNotifier.notify() is the explicit admission boundary. Both
    // immediate enqueue and recovery use this one dispatch path; recovery only
    // reclaims the same durable delivery identity.
    if (isStaleSelfCompletionDelivery(row, targetSessionId)) {
      this.deps.logger.warn(
        {
          deliveryId: row.delivery_id,
          sourceSessionId: row.source_session_id,
          targetSessionId,
        },
        "Self completion identity quarantined without consuming its delivery",
      );
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
      this.deps.logger.warn(
        { err, deliveryId: row.delivery_id, failure },
        "Completion dispatch did not prove acceptance; claim remains for lease recovery",
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

import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { CallerInfo } from "./task_models.js";
import type { AddInterventionParams } from "./task_intervention_route.js";
import {
  buildDeterministicDeliveryIdentity,
  hashDeliveryPayload,
} from "./delivery_identity.js";
import type { SessionDeliveryRepository } from "../db/repositories/session_delivery_repository.js";
import type {
  RegisterSessionDeliveryParams,
  SessionDeliveryRow,
} from "../db/session_db_types.js";

export interface DurableCompletionInput {
  targetSessionId: string;
  sourceSessionId: string;
  supervisorRole?: string;
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
  | "claimForCurrentSupervisor"
  | "claimRecoverableCompletionDeliveries"
  | "deferPending"
  | "retryLeasedDelivery"
  | "releaseExpiredDeliveryLeases"
>;

export interface CompletionDeliveryCoordinatorDeps {
  repository: CompletionDeliveryRepository;
  dispatch(params: AddInterventionParams): Promise<void>;
  logger: Pick<Logger, "error" | "warn">;
}

/**
 * Durable owner of completion delivery admission.
 *
 * Registration always precedes supervisor resolution. A failed lookup therefore
 * leaves a replayable `pending` row instead of losing the finalizer's only call.
 */
export class CompletionDeliveryCoordinator {
  private readonly workerId: string;

  constructor(
    private readonly deps: CompletionDeliveryCoordinatorDeps,
    workerId = `completion:${randomUUID()}`,
    private readonly leaseMs = 15_000,
  ) {
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

  async recoverPending(limit = 100): Promise<void> {
    let rows: SessionDeliveryRow[];
    try {
      await this.deps.repository.releaseExpiredDeliveryLeases();
      rows = await this.deps.repository.claimRecoverableCompletionDeliveries(
        this.workerId,
        limit,
        this.leaseMs,
      );
    } catch (err) {
      this.deps.logger.warn({ err }, "Completion delivery recovery scan failed");
      return;
    }
    for (const row of rows) {
      await this.dispatchClaimed(row);
    }
  }

  private async attemptPending(deliveryId: string): Promise<void> {
    try {
      const current = await this.deps.repository.get(deliveryId);
      if (!current || !isRecoverable(current)) return;
      const claimed = current.supervisor_role
        ? await this.deps.repository.claimForCurrentSupervisor(
            deliveryId,
            current.supervisor_role,
            this.workerId,
            this.leaseMs,
          )
        : await this.deps.repository.claimForTarget(
            deliveryId,
            requiredTarget(current),
            this.workerId,
            this.leaseMs,
          );
      if (!claimed) {
        await this.deps.repository.deferPending(
          deliveryId,
          "no_current_target",
          nextAttemptAt(current.attempt_count),
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
    try {
      await this.deps.dispatch(toInterventionParams(row, leaseOwner));
    } catch (err) {
      await this.deps.repository.retryLeasedDelivery(
        row.delivery_id,
        leaseOwner,
        errorText(err),
        nextAttemptAt(row.attempt_count),
      );
      this.deps.logger.warn(
        { err, deliveryId: row.delivery_id },
        "Completion delivery dispatch failed; durable retry scheduled",
      );
    }
  }
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
  const payload = {
    text: input.text,
    user: "agent",
    caller_info: input.callerInfo,
  };
  return {
    deliveryId: identity.deliveryId,
    targetSessionId: input.supervisorRole ? null : input.targetSessionId,
    sourceSessionId: input.sourceSessionId,
    relationKey,
    completionId: identity.completionId,
    intent: "completion_notification",
    source: "completion_notifier",
    producerKind: "child_session",
    producerId: input.sourceSessionId,
    producerTerminalRevision: input.terminalRevision,
    supervisorRole: input.supervisorRole,
    payloadHash: hashDeliveryPayload({
      ...payload,
      source: "completion_notifier",
      completion_id: identity.completionId,
      relation_key: relationKey,
      attachment_paths: null,
      context: null,
    }),
    payload,
    createdAt: input.createdAt,
  };
}

function toInterventionParams(
  row: SessionDeliveryRow,
  leaseOwner: string,
): AddInterventionParams {
  const callerInfo = asCallerInfo(row.payload.caller_info);
  return {
    agentSessionId: requiredTarget(row),
    text: requiredString(row.payload.text, "text"),
    user: requiredString(row.payload.user, "user"),
    callerInfo,
    source: row.source,
    deliveryId: row.delivery_id,
    deliveryIntent: row.intent,
    completionId: row.completion_id ?? undefined,
    relationKey: row.relation_key,
    producerTerminalRevision: row.producer_terminal_revision ?? undefined,
    parentDeliveryId: row.parent_delivery_id ?? undefined,
    callerTurnId: row.caller_turn_id ?? undefined,
    followupTaskIds: asStringArray(row.payload.followup_task_ids),
    deliveryCreatedAt: row.created_at.toISOString(),
    supervisorRole: row.supervisor_role ?? undefined,
    deliveryLeaseOwner: leaseOwner,
  };
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  return values.length > 0 ? values : undefined;
}

function isRecoverable(row: SessionDeliveryRow): boolean {
  return row.state === "pending" || row.state === "claimed";
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Stored completion delivery is missing ${name}`);
  }
  return value;
}

function asCallerInfo(value: unknown): CallerInfo | undefined {
  return value && typeof value === "object"
    ? value as CallerInfo
    : undefined;
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

function nextAttemptAt(attemptCount: number): Date {
  const delayMs = Math.min(60_000, 100 * 2 ** Math.min(attemptCount, 9));
  return new Date(Date.now() + delayMs);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

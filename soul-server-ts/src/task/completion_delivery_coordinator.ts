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
  | "listRecoverableCompletionDeliveries"
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
  constructor(private readonly deps: CompletionDeliveryCoordinatorDeps) {}

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
    await this.attempt(registered.row.delivery_id);
  }

  async recoverPending(limit = 100): Promise<void> {
    let rows: SessionDeliveryRow[];
    try {
      rows = await this.deps.repository.listRecoverableCompletionDeliveries(limit);
    } catch (err) {
      this.deps.logger.warn({ err }, "Completion delivery recovery scan failed");
      return;
    }
    for (const row of rows) {
      await this.attempt(row.delivery_id);
    }
  }

  private async attempt(deliveryId: string): Promise<void> {
    try {
      const current = await this.deps.repository.get(deliveryId);
      if (!current || !isRecoverable(current)) return;
      const claimed = current.supervisor_role
        ? await this.deps.repository.claimForCurrentSupervisor(
            deliveryId,
            current.supervisor_role,
          )
        : await this.deps.repository.claimForTarget(
            deliveryId,
            current.target_session_id,
          );
      if (!claimed) return;
      await this.deps.dispatch(toInterventionParams(claimed));
    } catch (err) {
      // The durable row remains pending/claimed. The worker retries without a
      // fixed attempt cap and with the same delivery identity.
      this.deps.logger.warn(
        { err, deliveryId },
        "Completion delivery attempt deferred for durable recovery",
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
    targetSessionId: input.targetSessionId,
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

function toInterventionParams(row: SessionDeliveryRow): AddInterventionParams {
  const callerInfo = asCallerInfo(row.payload.caller_info);
  return {
    agentSessionId: row.target_session_id,
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
    deliveryCreatedAt: row.created_at.toISOString(),
    supervisorRole: row.supervisor_role ?? undefined,
  };
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

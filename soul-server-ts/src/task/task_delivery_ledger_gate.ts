import { randomUUID } from "node:crypto";

import type {
  RegisterSessionDeliveryParams,
  SessionDeliveryRow,
} from "../db/session_db_types.js";
import type { SessionDeliveryRepository } from "../db/repositories/session_delivery_repository.js";

import type {
  AddInterventionParams,
  AddInterventionResult,
} from "./task_intervention_route.js";
import type { Task } from "./task_models.js";
import type { InterventionMessage } from "./task_models.js";
import { isLedgerControlledDeliveryIntent } from "./delivery_contract.js";
import { buildCanonicalDeliveryPayload } from "./delivery_payload.js";

export type DeliveryLedgerAdmission =
  | { kind: "legacy" }
  | { kind: "suppressed"; deliveryId: string; reason: string }
  | { kind: "admitted"; deliveryId: string; row: SessionDeliveryRow };

type LedgerRepository = Pick<
  SessionDeliveryRepository,
  "register" | "claimForTarget" | "claimForCurrentSupervisor" | "beginDispatch" | "get"
  | "markQueued" | "markDelivered"
  | "markUncertain" | "markConsumed" | "markConsumedByRelation"
> & {
  notifications: Pick<
    SessionDeliveryRepository["notifications"],
    "stageWithQueuedDelivery" | "markPublished" | "retry"
  >;
};

export class TaskDeliveryLedgerGate {
  constructor(
    private readonly enabled: boolean,
    private readonly repository?: LedgerRepository,
  ) {}

  async admit(params: AddInterventionParams): Promise<DeliveryLedgerAdmission> {
    if (!this.enabled || !isLedgerControlled(params)) {
      return { kind: "legacy" };
    }
    const repository = this.requireRepository();
    if (!params.deliveryId || !params.relationKey || !params.completionId) {
      throw new Error(
        `Delivery identity required for ${params.deliveryIntent}: delivery_id, relation_key, completion_id`,
      );
    }
    const registration = buildRegistration({
      ...params,
      deliveryId: params.deliveryId,
      relationKey: params.relationKey,
      completionId: params.completionId,
    });
    const registered = await repository.register(registration);
    if (registered.conflict) {
      return {
        kind: "suppressed",
        deliveryId: registered.row.delivery_id,
        reason: "identity_conflict_uncertain",
      };
    }
    if (registered.row.state === "claimed") {
      if (
        registered.row.target_session_id !== params.agentSessionId ||
        registered.row.supervisor_role !== (params.supervisorRole ?? null) ||
        !params.deliveryLeaseOwner ||
        registered.row.lease_owner !== params.deliveryLeaseOwner
      ) {
        return {
          kind: "suppressed",
          deliveryId: registered.row.delivery_id,
          reason: "supervisor_handover_retry",
        };
      }
      return {
        kind: "admitted",
        deliveryId: registered.row.delivery_id,
        row: registered.row,
      };
    }
    if (registered.row.state !== "pending") {
      return {
        kind: "suppressed",
        deliveryId: registered.row.delivery_id,
        reason: `delivery_${registered.row.state}`,
      };
    }

    const claimed =
      params.supervisorRole !== undefined
        ? await repository.claimForCurrentSupervisor(
            registered.row.delivery_id,
            params.supervisorRole,
            params.deliveryLeaseOwner ?? `route:${randomUUID()}`,
          )
        : await repository.claimForTarget(
            registered.row.delivery_id,
            params.agentSessionId,
            params.deliveryLeaseOwner ?? `route:${randomUUID()}`,
          );
    if (!claimed) {
      const current = await repository.get(registered.row.delivery_id);
      return {
        kind: "suppressed",
        deliveryId: registered.row.delivery_id,
        reason:
          params.supervisorRole !== undefined &&
          current?.state === "pending"
            ? "supervisor_handover_retry"
            : "concurrent_claim",
      };
    }
    if (
      params.supervisorRole !== undefined &&
      claimed.target_session_id !== params.agentSessionId
    ) {
      return {
        kind: "suppressed",
        deliveryId: claimed.delivery_id,
        reason: "supervisor_handover_retry",
      };
    }
    return { kind: "admitted", deliveryId: claimed.delivery_id, row: claimed };
  }

  async beginDispatch(
    admission: DeliveryLedgerAdmission,
  ): Promise<DeliveryLedgerAdmission> {
    if (admission.kind !== "admitted") return admission;
    const dispatching = await this.requireRepository().beginDispatch(
      admission.deliveryId,
      admission.row.lease_owner ?? undefined,
    );
    if (!dispatching) {
      const current = await this.requireRepository().get(admission.deliveryId);
      return {
        kind: "suppressed",
        deliveryId: admission.deliveryId,
        reason:
          current?.state === "claimed" && current.supervisor_role !== null
            ? "supervisor_handover_retry"
            : "delivery_consumed_before_dispatch",
      };
    }
    return { ...admission, row: dispatching };
  }

  async recordInlineConsumed(
    params: AddInterventionParams,
    task: Task,
  ): Promise<boolean> {
    if (!this.enabled || !isLedgerControlled(params)) return false;
    if (!params.deliveryId || !params.relationKey || !params.completionId) return false;
    const repository = this.requireRepository();
    const registered = await repository.register(buildRegistration({
      ...params,
      deliveryId: params.deliveryId,
      relationKey: params.relationKey,
      completionId: params.completionId,
    }));
    if (registered.conflict) return false;
    const consumed = await repository.markConsumedByRelation(
      params.relationKey,
      params.completionId,
      `event:${task.lastEventId ?? "unknown"}`,
    );
    return consumed?.state === "consumed";
  }

  async recordResult(
    admission: DeliveryLedgerAdmission,
    result: AddInterventionResult,
  ): Promise<void> {
    if (admission.kind !== "admitted") return;
    const repository = this.requireRepository();
    if ("queued" in result || "autoResumed" in result) {
      const disposition = "queued" in result ? "queued" : "auto_resume";
      const leaseOwner = admission.row.lease_owner;
      const targetSessionId = admission.row.target_session_id;
      if (!leaseOwner || !targetSessionId) {
        throw new Error(`Delivery ${admission.deliveryId} lost its dispatch lease`);
      }
      if (isNotificationIntent(admission.row.intent)) {
        const staged = await repository.notifications.stageWithQueuedDelivery({
          deliveryId: admission.deliveryId,
          leaseOwner,
          targetSessionId,
          disposition,
          payload: buildNotificationOutboxPayload(admission.row, disposition),
        });
        if (!staged) {
          throw new Error(`Delivery ${admission.deliveryId} could not stage notification`);
        }
      } else {
        const queued = await repository.markQueued(admission.deliveryId, leaseOwner);
        if (!queued) {
          throw new Error(`Delivery ${admission.deliveryId} lost queued-state CAS`);
        }
      }
      return;
    }
    await repository.markUncertain(admission.deliveryId);
  }

  async recordFailure(admission: DeliveryLedgerAdmission): Promise<void> {
    if (admission.kind !== "admitted") return;
    // The end-to-end coordinator owns retry scheduling. Keeping the lease
    // intact lets a cross-node fallback reuse the same fenced attempt token.
  }

  async recordNotificationPublished(
    admission: DeliveryLedgerAdmission,
  ): Promise<void> {
    if (admission.kind !== "admitted" || !isNotificationIntent(admission.row.intent)) {
      return;
    }
    const leaseOwner = admission.row.lease_owner;
    if (!leaseOwner) return;
    await this.requireRepository().notifications.markPublished(
      admission.deliveryId,
      leaseOwner,
    );
  }

  async recordNotificationFailure(
    admission: DeliveryLedgerAdmission,
    error: string,
  ): Promise<void> {
    if (admission.kind !== "admitted" || !isNotificationIntent(admission.row.intent)) {
      return;
    }
    const leaseOwner = admission.row.lease_owner;
    if (!leaseOwner) return;
    await this.requireRepository().notifications.retry(
      admission.deliveryId,
      leaseOwner,
      error,
      nextAttemptAt(admission.row.attempt_count),
    );
  }

  async recordConsumed(
    message: InterventionMessage,
    task: Task,
  ): Promise<void> {
    if (!this.enabled || !isControlledMessage(message) || !message.deliveryId) return;
    await this.requireRepository().markConsumed(
      message.deliveryId,
      `event:${task.lastEventId ?? "unknown"}`,
    );
  }

  async recordTurnStarted(
    message: InterventionMessage,
    task: Task,
  ): Promise<void> {
    if (!this.enabled || !isControlledMessage(message) || !message.deliveryId) return;
    await this.requireRepository().markDelivered(
      message.deliveryId,
      `event:${task.lastEventId ?? "unknown"}`,
    );
  }

  async recordTurnFailure(message: InterventionMessage): Promise<void> {
    if (!this.enabled || !isControlledMessage(message) || !message.deliveryId) return;
    await this.requireRepository().markUncertain(message.deliveryId);
  }

  private requireRepository(): LedgerRepository {
    if (!this.repository) {
      throw new Error("Delivery ledger repository is required when runtime v2 is enabled");
    }
    return this.repository;
  }
}

function buildRegistration(
  params: AddInterventionParams & {
    deliveryId: string;
    relationKey: string;
    completionId: string;
    deliveryIntent: "durable_next_turn" | "completion_notification" | "runtime_followup";
  },
): RegisterSessionDeliveryParams {
  const source = params.source ?? "unknown";
  const canonical = storedCanonicalPayload(params) ??
    buildCanonicalDeliveryPayload({
      text: params.text,
      user: params.user,
      source,
      completionId: params.completionId,
      relationKey: params.relationKey,
      attachmentPaths: params.attachmentPaths,
      context: params.context,
      callerInfo: params.callerInfo,
      followupTaskIds: params.followupTaskIds,
    });
  return {
    deliveryId: params.deliveryId,
    targetSessionId: params.agentSessionId,
    relationKey: params.relationKey,
    completionId: params.completionId,
    intent: params.deliveryIntent,
    source,
    producerTerminalRevision: params.producerTerminalRevision,
    parentDeliveryId: params.parentDeliveryId,
    callerTurnId: params.callerTurnId,
    supervisorRole: params.supervisorRole,
    payloadHash: canonical.payloadHash,
    payload: canonical.payload,
    createdAt: parseCreatedAt(params.deliveryCreatedAt),
  };
}

function storedCanonicalPayload(
  params: Pick<
    AddInterventionParams,
    "storedDeliveryPayload" | "storedDeliveryPayloadHash"
  >,
): { payload: Record<string, unknown>; payloadHash: string } | undefined {
  const payload = params.storedDeliveryPayload;
  const payloadHash = params.storedDeliveryPayloadHash;
  if (payload === undefined && payloadHash === undefined) return undefined;
  if (payload === undefined || !payloadHash) {
    throw new Error("Stored delivery payload and hash must be provided together");
  }
  return { payload, payloadHash };
}

export function isLedgerControlled(
  params: Pick<AddInterventionParams, "deliveryIntent">,
): params is Pick<AddInterventionParams, "deliveryIntent"> & {
  deliveryIntent: "durable_next_turn" | "completion_notification" | "runtime_followup";
} {
  return isLedgerControlledDeliveryIntent(params.deliveryIntent);
}

function parseCreatedAt(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function isControlledMessage(
  message: Pick<InterventionMessage, "deliveryIntent">,
): boolean {
  return (
    message.deliveryIntent === "durable_next_turn" ||
    message.deliveryIntent === "completion_notification" ||
    message.deliveryIntent === "runtime_followup"
  );
}

function isNotificationIntent(
  intent: SessionDeliveryRow["intent"],
): intent is "completion_notification" | "runtime_followup" {
  return intent === "completion_notification" || intent === "runtime_followup";
}

function buildNotificationOutboxPayload(
  row: SessionDeliveryRow,
  disposition: "queued" | "auto_resume",
): Record<string, unknown> {
  return {
    text: row.payload.text,
    user: row.payload.user,
    caller_info: row.payload.caller_info ?? null,
    source: row.source,
    delivery_id: row.delivery_id,
    delivery_intent: row.intent,
    completion_id: row.completion_id,
    relation_key: row.relation_key,
    disposition,
  };
}

function nextAttemptAt(attemptCount: number): Date {
  const delayMs = Math.min(60_000, 100 * 2 ** Math.min(attemptCount, 9));
  return new Date(Date.now() + delayMs);
}

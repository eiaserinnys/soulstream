import { randomUUID } from "node:crypto";

import type {
  SessionDeliveryRow,
} from "../db/session_db_types.js";
import type { SessionDeliveryRepository } from "../db/repositories/session_delivery_repository.js";

import type {
  AddInterventionParams,
  AddInterventionResult,
} from "./task_intervention_route.js";
import type { InterventionMessage, Task } from "./task_models.js";
import { isDeliveryIntent, type DeliveryIntent } from "./delivery_contract.js";
import { loadOrRegisterDelivery } from "./task_delivery_registration.js";
import {
  DELIVERY_NOTIFICATION_MAX_ATTEMPTS,
  deliveryRetryDelayMs,
  notificationOldestAllowedCreatedAt,
  notificationRetryAt,
} from "./session_delivery_notification_policy.js";
import { buildNotificationOutboxPayload, isNotificationDeliveryIntent } from
  "./session_delivery_notification_payload.js";
import { projectNotificationReceipt } from "./notification_receipt_projection.js";
import {
  discardConsumedRunnerIntervention,
  matchesConsumedDelivery,
} from "./consumed_runner_intervention.js";

export type DeliveryLedgerAdmission =
  | { kind: "legacy" }
  | { kind: "suppressed"; deliveryId: string; reason: string }
  | { kind: "admitted"; deliveryId: string; row: SessionDeliveryRow };

const OWNERSHIP_CONFLICT_RETRY_MAX_DELAY_MS = 10_000;

type LedgerRepository = Pick<
  SessionDeliveryRepository,
  "register" | "claimForTarget" | "beginDispatch" | "get"
  | "markQueued" | "markDelivered"
  | "markUncertain" | "markConsumed" | "markConsumedByRelation"
  | "recordRelationConsumed"
  | "retryLeasedDelivery" | "markPendingSuperseded"
> & {
  notifications: Pick<
    SessionDeliveryRepository["notifications"],
    "stageWithQueuedDelivery" | "get" | "markPublished" | "retry"
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
    const registrationParams = {
      ...params,
      deliveryId: params.deliveryId,
      relationKey: params.relationKey,
      completionId: params.completionId,
    };
    const registered = await loadOrRegisterDelivery(repository, registrationParams);
    if (registered.kind === "identity_mismatch") {
      return {
        kind: "suppressed",
        deliveryId: params.deliveryId,
        reason: "delivery_identity_mismatch",
      };
    }
    if (registered.conflict) {
      return {
        kind: "suppressed",
        deliveryId: registered.row.delivery_id,
        reason: "identity_conflict_uncertain",
      };
    }
    if (registered.row.aggregate_state === "consumed") {
      return {
        kind: "suppressed",
        deliveryId: registered.row.delivery_id,
        reason: "delivery_consumed",
      };
    }
    if (registered.row.aggregate_state === "dead_letter") {
      return {
        kind: "suppressed",
        deliveryId: registered.row.delivery_id,
        reason: "delivery_dead_letter",
      };
    }
    if (registered.row.state === "claimed") {
      if (
        registered.row.target_session_id !== params.agentSessionId ||
        !params.deliveryLeaseOwner ||
        registered.row.lease_owner !== params.deliveryLeaseOwner
      ) {
        return {
          kind: "suppressed",
          deliveryId: registered.row.delivery_id,
          reason: "delivery_target_changed",
        };
      }
      return {
        kind: "admitted",
        deliveryId: registered.row.delivery_id,
        row: registered.row,
      };
    }
    const explicitQueuedIntent =
      registered.row.state === "queued" && !params.deliveryLeaseOwner;
    if (registered.row.state !== "pending" && !explicitQueuedIntent) {
      return {
        kind: "suppressed",
        deliveryId: registered.row.delivery_id,
        reason: `delivery_${registered.row.state}`,
      };
    }

    const claimed = await repository.claimForTarget(
      registered.row.delivery_id,
      params.agentSessionId,
      params.deliveryLeaseOwner ?? `route:${randomUUID()}`,
    );
    if (!claimed) {
      const current = await repository.get(registered.row.delivery_id);
      return {
        kind: "suppressed",
        deliveryId: registered.row.delivery_id,
        reason: current?.state === "pending" ? "target_unavailable" : "concurrent_claim",
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
        reason: current
          ? `delivery_${current.state}_before_dispatch`
          : "delivery_missing_before_dispatch",
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
    const registrationParams = {
      ...params,
      deliveryId: params.deliveryId,
      relationKey: params.relationKey,
      completionId: params.completionId,
    };
    const registered = await loadOrRegisterDelivery(repository, registrationParams);
    if (registered.kind === "identity_mismatch") return false;
    if (registered.conflict) return false;
    const consumed = await repository.markConsumedByRelation(
      params.relationKey,
      params.completionId,
      `event:${task.lastEventId ?? "unknown"}`,
    );
    if (consumed?.state !== "consumed") return false;
    await discardConsumedRunnerIntervention(task, consumed.delivery_id);
    return true;
  }

  async discardIfConsumed(
    message: InterventionMessage,
    task: Task,
  ): Promise<boolean> {
    if (!this.enabled || !isControlledMessage(message) || !message.deliveryId) return false;
    const row = await this.requireRepository().get(message.deliveryId);
    if (!matchesConsumedDelivery(row, message)) return false;
    await discardConsumedRunnerIntervention(task, message.deliveryId);
    return true;
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
      if (isNotificationDeliveryIntent(admission.row.intent)) {
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
          const current = await repository.get(admission.deliveryId);
          const sameQueuedDelivery = current?.state === "queued"
            && current.delivery_id === admission.row.delivery_id
            && current.target_session_id === admission.row.target_session_id
            && current.intent === admission.row.intent
            && current.relation_key === admission.row.relation_key
            && current.completion_id === admission.row.completion_id
            && current.payload_hash === admission.row.payload_hash;
          if (!sameQueuedDelivery) {
            throw new Error(`Delivery ${admission.deliveryId} lost queued-state CAS`);
          }
        }
      }
      return;
    }
    if ("delivered" in result && result.delivered === true) {
      const leaseOwner = admission.row.lease_owner;
      if (!leaseOwner) {
        throw new Error(`Delivery ${admission.deliveryId} lost its dispatch lease`);
      }
      await repository.markQueued(
        admission.deliveryId,
        leaseOwner,
      );
      return;
    }
    const leaseOwner = admission.row.lease_owner;
    if (!leaseOwner) {
      throw new Error(`Delivery ${admission.deliveryId} lost its dispatch lease`);
    }
    if ("delivered" in result && result.delivered === null) {
      const retryExhausted =
        admission.row.attempt_count + 1 >= DELIVERY_NOTIFICATION_MAX_ATTEMPTS
        || admission.row.created_at <= notificationOldestAllowedCreatedAt();
      if (!retryExhausted) {
        const retried = await repository.retryLeasedDelivery(
          admission.deliveryId,
          leaseOwner,
          result.reason,
          deliveryRetryDelayMs(admission.row.attempt_count),
        );
        if (!retried) {
          throw new Error(`Delivery ${admission.deliveryId} lost retryable-state CAS`);
        }
        return;
      }
    }
    const uncertain = await repository.markUncertain(
      admission.deliveryId,
      leaseOwner,
      "delivered" in result && result.delivered === null
        ? `delivery retry budget exhausted: ${result.reason}`
        : "delivery_result_not_accepted",
    );
    if (!uncertain) {
      throw new Error(`Delivery ${admission.deliveryId} lost uncertain-state CAS`);
    }
  }

  /** Reserve a future retry without dispatching a session message. */
  async reserveRetry(
    admission: DeliveryLedgerAdmission,
    deliveryNextAttemptAt: string,
  ): Promise<void> {
    if (admission.kind !== "admitted") return;
    const leaseOwner = admission.row.lease_owner;
    if (!leaseOwner) {
      throw new Error(`Delivery ${admission.deliveryId} lost its retry reservation lease`);
    }
    const nextAttemptAt = new Date(deliveryNextAttemptAt);
    if (Number.isNaN(nextAttemptAt.getTime())) {
      throw new Error(`Delivery ${admission.deliveryId} has an invalid retry due time`);
    }
    const reserved = await this.requireRepository().retryLeasedDelivery(
      admission.deliveryId,
      leaseOwner,
      "scheduled_runtime_followup_retry",
      // The caller schedules against its own clock; only the remaining
      // interval survives the trip to the database's clock.
      Math.max(0, nextAttemptAt.getTime() - Date.now()),
    );
    if (!reserved) {
      throw new Error(`Delivery ${admission.deliveryId} lost retry reservation CAS`);
    }
  }

  async recordFailure(admission: DeliveryLedgerAdmission): Promise<void> {
    if (admission.kind !== "admitted") return;
    // The end-to-end coordinator owns retry scheduling. Keeping the lease
    // intact lets a cross-node fallback reuse the same fenced attempt token.
  }

  async recordReservationRetry(
    admission: DeliveryLedgerAdmission,
    retryAt: string,
  ): Promise<"scheduled" | "parked" | "lost"> {
    if (admission.kind !== "admitted") return "lost";
    const leaseOwner = admission.row.lease_owner;
    if (!leaseOwner) return "lost";
    const requestedDueAt = new Date(retryAt);
    if (!Number.isFinite(requestedDueAt.getTime())) {
      throw new Error(`Delivery ${admission.deliveryId} has an invalid reservation retry time`);
    }
    const exhausted =
      admission.row.attempt_count + 1 >= DELIVERY_NOTIFICATION_MAX_ATTEMPTS
      || admission.row.created_at <= notificationOldestAllowedCreatedAt();
    const repository = this.requireRepository();
    if (exhausted) {
      const parked = await repository.retryLeasedDelivery(
        admission.deliveryId,
        leaseOwner,
        "automatic ownership retry budget exhausted; explicit intent required",
        0,
      );
      return parked ? "parked" : "lost";
    }
    // All three candidates become durations before the minimum is taken: the
    // requested instant is the only one that came from another clock, and
    // mixing it with locally derived instants let skew pick the wrong bound.
    const retryDelayMs = Math.max(0, Math.min(
      requestedDueAt.getTime() - Date.now(),
      deliveryRetryDelayMs(admission.row.attempt_count),
      OWNERSHIP_CONFLICT_RETRY_MAX_DELAY_MS,
    ));
    const retried = await repository.retryLeasedDelivery(
      admission.deliveryId,
      leaseOwner,
      "reservation_in_flight",
      retryDelayMs,
    );
    return retried ? "scheduled" : "lost";
  }

  async recordNotificationPublished(
    admission: DeliveryLedgerAdmission,
    targetReceiptId: string,
  ): Promise<void> {
    if (admission.kind !== "admitted") return;
    if (!isNotificationDeliveryIntent(admission.row.intent)) return;
    const leaseOwner = admission.row.lease_owner;
    if (!leaseOwner) return;
    await projectNotificationReceipt(
      this.requireRepository().notifications,
      admission.deliveryId,
      leaseOwner,
      targetReceiptId,
    );
  }

  async recordNotificationFailure(
    admission: DeliveryLedgerAdmission,
    error: string,
  ): Promise<void> {
    if (admission.kind !== "admitted") return;
    if (!isNotificationDeliveryIntent(admission.row.intent)) return;
    const leaseOwner = admission.row.lease_owner;
    if (!leaseOwner) return;
    await this.requireRepository().notifications.retry(
      admission.deliveryId,
      leaseOwner,
      error,
      notificationRetryAt(admission.row.attempt_count),
      DELIVERY_NOTIFICATION_MAX_ATTEMPTS,
      notificationOldestAllowedCreatedAt(),
    );
  }

  async recordConsumed(
    message: InterventionMessage,
    task: Task,
    consumedTurnId?: string,
  ): Promise<void> {
    if (!this.enabled || !isControlledMessage(message)) return;
    const resolvedConsumedTurnId = consumedTurnId
      ?? `event:${task.lastEventId ?? "unknown"}`;
    const repository = this.requireRepository();
    if (isInlineChildCompletion(message)) {
      await repository.recordRelationConsumed({
        relationKey: message.relationKey,
        completionId: message.completionId,
        callerSessionId: task.agentSessionId,
        consumedTurnId: resolvedConsumedTurnId,
      });
    }
    if (message.deliveryId) {
      const consumed = await repository.markConsumed(
        message.deliveryId,
        resolvedConsumedTurnId,
      );
      if (!consumed && requiresExactDeliveryConsumption(message)) {
        const existing = await repository.get(message.deliveryId);
        if (existing?.state !== "consumed") {
          throw new Error(
            `Exact delivery consumption did not reach consumed state: ${message.deliveryId}`,
          );
        }
      }
    }
  }

  async recordPendingSuperseded(
    message: InterventionMessage,
    reason: string,
  ): Promise<boolean> {
    if (!this.enabled || !isControlledMessage(message) || !message.deliveryId) {
      return false;
    }
    const superseded = await this.requireRepository().markPendingSuperseded(
      message.deliveryId,
      reason,
    );
    return superseded?.state === "superseded";
  }

  async recordTurnStarted(
    message: InterventionMessage,
    _task: Task,
  ): Promise<void> {
    if (!this.enabled || !isControlledMessage(message) || !message.deliveryId) return;
    // Turn observation is an in-memory eligibility fact. The durable row stays
    // queued/pending until success consumes it, so a failed turn is replayable.
  }

  private requireRepository(): LedgerRepository {
    if (!this.repository) {
      throw new Error("Delivery ledger repository is required when runtime v2 is enabled");
    }
    return this.repository;
  }
}

function requiresExactDeliveryConsumption(message: InterventionMessage): boolean {
  return isControlledMessage(message)
    || message.source === "claude_runtime_task_followup";
}

export function isLedgerControlled(
  params: Pick<AddInterventionParams, "deliveryIntent">,
): params is Pick<AddInterventionParams, "deliveryIntent"> & {
  deliveryIntent: DeliveryIntent;
} {
  return isDeliveryIntent(params.deliveryIntent);
}

function isControlledMessage(
  message: Pick<InterventionMessage, "deliveryIntent">,
): boolean {
  return isDeliveryIntent(message.deliveryIntent);
}

export function isInlineChildCompletion(
  message: InterventionMessage,
): message is InterventionMessage & {
  completionId: string;
  relationKey: string;
} {
  return (
    message.deliveryIntent === "completion_notification" &&
    typeof message.completionId === "string" &&
    message.completionId.length > 0 &&
    typeof message.relationKey === "string" &&
    message.relationKey.startsWith("child_session:")
  );
}

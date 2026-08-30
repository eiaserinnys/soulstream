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

type LedgerRepository = Pick<
  SessionDeliveryRepository,
  "register" | "claimForTarget" | "beginDispatch" | "get" | "markQueued"
  | "markConsumedByRelation" | "retryLeasedDelivery"
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
    const consumed = await repository.markConsumedByRelation({
      deliveryId: params.deliveryId,
      relationKey: params.relationKey,
      completionId: params.completionId,
      callerSessionId: task.agentSessionId,
      consumedTurnId: `event:${task.lastEventId ?? "unknown"}`,
    });
    if (!consumed.deliveryConsumed) return false;
    await discardConsumedRunnerIntervention(task, params.deliveryId);
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
    // A rejected or ambiguous runtime result is not a delivery receipt. Keep
    // the exact claim intact; lease recovery may schedule the same delivery.
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
    // intact lets the next scheduled transport attempt reuse the same token.
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
    if (!message.deliveryId || !message.relationKey || !message.completionId) {
      throw new Error("Exact delivery relation identity is required for consumption");
    }
    const consumed = await repository.markConsumedByRelation({
      deliveryId: message.deliveryId,
      relationKey: message.relationKey,
      completionId: message.completionId,
      callerSessionId: task.agentSessionId,
      consumedTurnId: resolvedConsumedTurnId,
    });
    if (!consumed.deliveryConsumed) {
      const existing = await repository.get(message.deliveryId);
      if (existing?.state !== "consumed") {
        throw new Error(
          `Exact delivery consumption did not reach consumed state: ${message.deliveryId}`,
        );
      }
    }
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

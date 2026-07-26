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
import { hashDeliveryPayload } from "./delivery_identity.js";
import { isLedgerControlledDeliveryIntent } from "./delivery_contract.js";

export type DeliveryLedgerAdmission =
  | { kind: "legacy" }
  | { kind: "suppressed"; deliveryId: string; reason: string }
  | { kind: "admitted"; deliveryId: string; row: SessionDeliveryRow };

type LedgerRepository = Pick<
  SessionDeliveryRepository,
  "register" | "claimForTarget" | "claimForCurrentSupervisor" | "beginDispatch" | "get"
  | "markQueued" | "markDelivered"
  | "markUncertain" | "markConsumed" | "markConsumedByRelation"
>;

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
        registered.row.supervisor_role !== (params.supervisorRole ?? null)
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
          )
        : await repository.claimForTarget(
            registered.row.delivery_id,
            params.agentSessionId,
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
    if ("queued" in result) {
      await repository.markQueued(admission.deliveryId);
      return;
    }
    if ("autoResumed" in result) {
      await repository.markQueued(admission.deliveryId);
      return;
    }
    await repository.markUncertain(admission.deliveryId);
  }

  async recordFailure(admission: DeliveryLedgerAdmission): Promise<void> {
    if (admission.kind !== "admitted") return;
    await this.requireRepository().markUncertain(admission.deliveryId);
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
  return {
    deliveryId: params.deliveryId,
    targetSessionId: params.agentSessionId,
    relationKey: params.relationKey,
    completionId: params.completionId,
    intent: params.deliveryIntent,
    source: params.source ?? "unknown",
    producerTerminalRevision: params.producerTerminalRevision,
    parentDeliveryId: params.parentDeliveryId,
    callerTurnId: params.callerTurnId,
    supervisorRole: params.supervisorRole,
    payloadHash: hashDeliveryPayload({
      text: params.text,
      user: params.user,
      source: params.source ?? null,
      completion_id: params.completionId,
      relation_key: params.relationKey,
      attachment_paths: params.attachmentPaths ?? null,
      context: params.context ?? null,
      caller_info: params.callerInfo ?? null,
    }),
    payload: {
      text: params.text,
      user: params.user,
      attachment_paths: params.attachmentPaths ?? null,
      context: params.context ?? null,
      caller_info: params.callerInfo ?? null,
    },
    createdAt: parseCreatedAt(params.deliveryCreatedAt),
  };
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

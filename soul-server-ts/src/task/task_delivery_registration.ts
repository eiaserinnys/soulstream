import type {
  RegisterSessionDeliveryParams,
  RegisterSessionDeliveryResult,
  SessionDeliveryRow,
} from "../db/session_db_types.js";
import type { SessionDeliveryRepository } from
  "../db/repositories/session_delivery_repository.js";

import type { DeliveryIntent } from "./delivery_contract.js";
import type { AddInterventionParams } from "./task_intervention_route.js";
import { buildCanonicalDeliveryPayload } from "./delivery_payload.js";

type ControlledRegistrationParams = AddInterventionParams & {
  deliveryId: string;
  relationKey: string;
  completionId: string;
  deliveryIntent: DeliveryIntent;
};

export type LoadOrRegisterResult =
  | ({ kind: "registered" } & RegisterSessionDeliveryResult)
  | { kind: "identity_mismatch"; row: SessionDeliveryRow };

/** Preserves one immutable payload while entering the serialized runtime gate. */
export async function loadOrRegisterDelivery(
  repository: Pick<SessionDeliveryRepository, "register" | "get">,
  params: ControlledRegistrationParams,
): Promise<LoadOrRegisterResult> {
  if (params.deliveryIntent === "runtime_followup") {
    const existing = await repository.get(params.deliveryId);
    if (existing && !matchesImmutableIdentity(existing, params)) {
      return { kind: "identity_mismatch", row: existing };
    }
    const registration = buildRegistration(params);
    return {
      kind: "registered",
      ...await repository.register(existing
        ? {
            ...registration,
            payload: existing.payload,
            payloadHash: existing.payload_hash,
          }
        : registration),
    };
  }
  const existing = await repository.get(params.deliveryId);
  if (existing) {
    if (!matchesImmutableIdentity(existing, params)) {
      return { kind: "identity_mismatch", row: existing };
    }
    return { kind: "registered", row: existing, inserted: false, conflict: false };
  }
  return {
    kind: "registered",
    ...await repository.register(buildRegistration(params)),
  };
}

function matchesImmutableIdentity(
  row: SessionDeliveryRow,
  params: Pick<ControlledRegistrationParams, "relationKey" | "completionId" | "deliveryIntent">,
): boolean {
  return row.relation_key === params.relationKey
    && row.completion_id === params.completionId
    && row.intent === params.deliveryIntent;
}

function buildRegistration(
  params: ControlledRegistrationParams,
): RegisterSessionDeliveryParams {
  const source = params.source ?? "unknown";
  const canonical = storedCanonicalPayload(params)
    ?? buildCanonicalDeliveryPayload({
      text: params.text,
      user: params.user,
      source,
      completionId: params.completionId,
      relationKey: params.relationKey,
      attachmentPaths: params.attachmentPaths,
      context: params.context,
      callerInfo: params.callerInfo,
      followupKey: params.followupKey,
      followupAttempt: params.followupAttempt,
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
    payloadHash: canonical.payloadHash,
    payload: canonical.payload,
    createdAt: parseCreatedAt(params.deliveryCreatedAt),
  };
}

function storedCanonicalPayload(
  params: Pick<AddInterventionParams, "storedDeliveryPayload" | "storedDeliveryPayloadHash">,
): { payload: Record<string, unknown>; payloadHash: string } | undefined {
  const payload = params.storedDeliveryPayload;
  const payloadHash = params.storedDeliveryPayloadHash;
  if (payload === undefined && payloadHash === undefined) return undefined;
  if (payload === undefined || !payloadHash) {
    throw new Error("Stored delivery payload and hash must be provided together");
  }
  return { payload, payloadHash };
}

function parseCreatedAt(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

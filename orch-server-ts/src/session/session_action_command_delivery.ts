import { randomUUID } from "node:crypto";

import type { AttachmentPathBinding } from "@soulstream/wire-schema/attachments";
import {
  buildCanonicalDeliveryPayload,
} from "@soulstream/wire-schema/delivery";

import type {
  RegisterSessionDeliveryResult,
} from "@soulstream/wire-schema/session-delivery";
import type { RegisterSessionDeliveryRequest } from
  "../control_plane/repositories/session_delivery_relation_repository.js";

/**
 * The canonical durable payload for a human live-steer intervention.
 *
 * Both the HTTP intervention body and ExternalInputService assemble through
 * this one function so a retry after the admission commit registers the same
 * normalized payload hash. `register` is supplied by the caller so a caller can
 * bind it to its own transaction (`registerSessionDelivery(tx, params)` runs
 * in place when `tx` has no `begin`).
 */
export interface DurableHumanInterventionInput {
  agentSessionId: string;
  text: string;
  user: string;
  conversationText?: string;
  attachmentPaths?: readonly string[] | null;
  attachmentIds?: readonly string[] | null;
  attachmentBindings?: ReadonlyArray<AttachmentPathBinding> | null;
  contextItems?: ReadonlyArray<Record<string, unknown>> | null;
  callerInfo?: Record<string, unknown> | null;
  deliveryId?: string;
  completionId?: string;
  relationKey?: string;
  source?: string;
  createdAt?: string;
}

export interface DurableHumanInterventionRegistration {
  deliveryId: string;
  completionId: string;
  relationKey: string;
  source: string;
  createdAt: Date;
  payloadHash: string;
  payload: Record<string, unknown>;
  conflict: boolean;
}

export async function registerDurableHumanIntervention(
  register: (params: RegisterSessionDeliveryRequest) =>
    Promise<RegisterSessionDeliveryResult>,
  input: DurableHumanInterventionInput,
): Promise<DurableHumanInterventionRegistration> {
  const deliveryId = input.deliveryId ?? randomUUID();
  const completionId = input.completionId ?? `message:${deliveryId}`;
  const relationKey = input.relationKey
    ?? `user_message:${input.agentSessionId}:${deliveryId}`;
  const source = input.source ?? "user_message";
  const createdAt = parseDurableCreatedAt(input.createdAt);
  const canonical = buildCanonicalDeliveryPayload({
    text: input.text,
    conversationText: input.conversationText,
    user: input.user,
    source,
    completionId,
    relationKey,
    attachmentPaths: input.attachmentPaths,
    attachmentIds: input.attachmentIds,
    attachmentBindings: input.attachmentBindings,
    context: input.contextItems,
    callerInfo: input.callerInfo,
  });
  const registered = await register({
    deliveryId,
    targetSessionId: input.agentSessionId,
    relationKey,
    completionId,
    intent: "human_live_steer",
    source,
    payloadHash: canonical.payloadHash,
    payload: canonical.payload,
    createdAt,
  });
  return {
    deliveryId,
    completionId,
    relationKey,
    source,
    createdAt,
    payloadHash: canonical.payloadHash,
    payload: canonical.payload,
    conflict: registered.conflict,
  };
}

function parseDurableCreatedAt(value: string | undefined): Date {
  if (value === undefined) return new Date();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("created_at must be an ISO timestamp");
  }
  return parsed;
}


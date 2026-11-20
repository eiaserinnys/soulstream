import { randomUUID } from "node:crypto";
import { buildCanonicalDeliveryPayload } from "@soulstream/wire-schema/delivery";
import {
  DELIVERY_CLAIM_TTL_MS,
  isExplicitNodeRejection,
  nodeRejectionDetailsSuffix,
  releaseDeliveryAttemptAfterSendFailure,
} from "../control_plane/session_delivery_release.js";
import type { SessionDeliveryRepository } from "../control_plane/repositories/session_delivery_repository.js";
import type { SessionDeliveryRow } from "@soulstream/wire-schema/session-delivery";
import { PendingNodeCommandRejectedError } from "../node/pending_commands.js";
import type { InterveneNodeCommandPayload } from "../session/session_action_command_payloads.js";

/** Card callbacks do not re-claim queued deliveries. Other delivery policies remain unchanged. */
export async function sendCardChangeOnce(
  repository: Pick<SessionDeliveryRepository,
    "register" | "claim" | "get" | "retryDeliveryAttempt" | "markUncertain">,
  payload: InterveneNodeCommandPayload,
  send: (payload: InterveneNodeCommandPayload) => Promise<Record<string, unknown>>,
  registeredRow?: SessionDeliveryRow,
): Promise<void> {
  const id = payload.delivery_id!;
  if(registeredRow&&registeredRow.delivery_id!==id)throw new Error(`Card delivery identity mismatch: ${id}`);
  const registered=registeredRow?{row:registeredRow,conflict:false}:await register(repository,payload,id);
  if (registered.conflict) throw new Error(`Card delivery identity conflict: ${id}`);
  if (accepted(registered.row)) return;
  // This pending-only CAS closes the lookup→send race. The receiving ledger checks
  // this token and atomically moves claimed→dispatching before engine/queue admission.
  // The claim outlives the node command wait (card #1653); a shorter TTL let the
  // stale sweep revert an attempt we were still waiting on.
  const token = `card-change:${randomUUID()}`;
  const claimed = await repository.claim(id, token, DELIVERY_CLAIM_TTL_MS);
  if (!claimed) {
    if (accepted(await repository.get(id))) return;
    throw new Error(`Card delivery has no confirmed acceptance: ${id}`);
  }
  try {
    const response = await send({ ...payload, delivery_attempt_token: token });
    // Ack alone is insufficient: unknown/deferred and transport failures are not success.
    if (response.status === "error" || response.type === "error") {
      throw nodeRejection(payload, response);
    }
    if (!["delivered", "queued", "auto_resumed", "suppressed"].includes(String(response.outcome))
      || !accepted(await repository.get(id))) {
      throw new Error(`Card delivery acceptance unconfirmed: ${id} (${String(response.outcome)})`);
    }
  } catch (error) {
    // Only a rejection the node answered explicitly releases the claim. Timeouts,
    // response-less rejections and unconfirmed acceptance still wait for expiry.
    if (isExplicitNodeRejection(error)) {
      await releaseDeliveryAttemptAfterSendFailure({
        repository,
        deliveryId: id,
        attemptToken: token,
        error,
        failure: `card delivery ${id} dispatch failed: ${error.message}`
          + nodeRejectionDetailsSuffix(error),
        attemptCount: claimed.attempt_count,
      });
    }
    throw error;
  }
}

function nodeRejection(
  payload: InterveneNodeCommandPayload,
  response: Record<string, unknown>,
): PendingNodeCommandRejectedError {
  return new PendingNodeCommandRejectedError({
    commandType: payload.type,
    requestId: typeof response.requestId === "string" ? response.requestId : "",
    message: String(response.message ?? response.code ?? "Card delivery rejected"),
    response: {
      ...response,
      type: typeof response.type === "string" ? response.type : "error",
    },
  });
}

async function register(
  repository:Pick<SessionDeliveryRepository,"register">,
  payload:InterveneNodeCommandPayload,
  id:string,
){
  const canonical = buildCanonicalDeliveryPayload({
    text: payload.text, user: payload.user, source: payload.source!,
    relationKey: payload.relation_key!, completionId: payload.completion_id!,
    attachmentPaths: payload.attachment_paths,
    attachmentIds: payload.attachment_ids,
    attachmentBindings: payload.attachment_bindings,
    callerInfo: payload.caller_info,
  });
  return await repository.register({
    deliveryId: id, targetSessionId: payload.agentSessionId,
    relationKey: payload.relation_key!, completionId: payload.completion_id!,
    intent: "durable_next_turn", source: "card_change",
    payload: canonical.payload, payloadHash: canonical.payloadHash,
  });
}

function accepted(row: SessionDeliveryRow | null): boolean {
  return !!row && (row.state === "queued" || row.state === "delivered"
    || row.aggregate_state === "consumed");
}

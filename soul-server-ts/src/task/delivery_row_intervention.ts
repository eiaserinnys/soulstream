import type { SessionDeliveryRow } from "../db/session_db_types.js";
import { readCanonicalDeliveryPayload } from "./delivery_payload.js";
import type {
  AddInterventionParams,
  AddInterventionResult,
  StartExecutionCallback,
} from "./task_intervention_route.js";

export interface DeliveryInterventionTarget {
  addIntervention(
    params: AddInterventionParams,
    onResume: StartExecutionCallback,
  ): Promise<AddInterventionResult>;
}

/** Rebuilds an intervention exclusively from its canonical durable row. */
export function deliveryRowToInterventionParams(
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

/** Routes transcript-proven unseen content through the ordinary intervention owner. */
export async function redeliverStoredDeliveryContent(
  row: SessionDeliveryRow,
  target: DeliveryInterventionTarget,
  onResume: StartExecutionCallback,
): Promise<void> {
  const result = await target.addIntervention(
    {
      ...deliveryRowToInterventionParams(row, requiredLeaseOwner(row)),
      targetContentReceiptAbsent: true,
    },
    onResume,
  );
  if ("suppressed" in result) {
    throw new Error(
      `Stored delivery ${row.delivery_id} was suppressed: ${result.reason}`,
    );
  }
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

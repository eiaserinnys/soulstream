import { createHash } from "node:crypto";
import { buildCanonicalDeliveryPayload, buildDeterministicDeliveryIdentity } from "@soulstream/wire-schema/delivery";
import { readCardExecutionRegistration, type CardExecutionRequest } from "./card_execution_service.js";
import type { SessionDeliveryRow, SqlClient as DeliverySqlClient } from "../control_plane/control_plane_types.js";
import { registerSessionDelivery } from "../control_plane/repositories/session_delivery_relation_repository.js";
import type { RepositorySql } from "./control_plane/card_types.js";

export type ConfirmedWorkError = {
  operationId: string;
  cardId: string;
  workId: string;
  stage: "launch" | "restart" | "delivery" | "runtime";
  message: string;
  failureId: string;
};

export type CanonicalWorkError = {
  sessionId: string;
  eventId: number;
  executionCommandId: string;
  registrationId: string;
  applied: boolean;
  status: string;
  terminationReason: string;
  message: string;
};

type DispatchOperation = {
  id: string;
  target_kind: string;
  target_id: string;
  operation_type: string;
  actor_kind: string;
  actor_session_id: string | null;
  idempotency_key: string | null;
};

type DispatchRequest = CardExecutionRequest & {
  operation_id: string;
  card_id_from_operation: string;
  actor_session_id: string | null;
};

type DeliveryQueryRow = SessionDeliveryRow & Record<string, unknown>;

function canonicalWorkErrorRelationKey(sessionId: string, eventId: number): string {
  return `dispatch-work-error:runtime:${sessionId}:${eventId}`;
}

export function canonicalWorkErrorDeliveryId(sessionId: string, eventId: number): string {
  return buildDeterministicDeliveryIdentity({
    targetSessionId: sessionId,
    relationKey: canonicalWorkErrorRelationKey(sessionId, eventId),
    intent: "durable_next_turn",
  }).deliveryId;
}

export async function recordConfirmedErrorTx(sql: RepositorySql, failure: ConfirmedWorkError): Promise<SessionDeliveryRow | null> {
  if (!failure.operationId || !failure.cardId || !failure.workId || !failure.failureId || !failure.message) return null;
  const operation = (await sql<DispatchOperation[]>`
    SELECT id,target_kind,target_id,operation_type,actor_kind,actor_session_id,idempotency_key
    FROM folder_operations WHERE id=${failure.operationId}
  `)[0];
  if (!operation || operation.target_kind !== "card" || operation.target_id !== failure.cardId
    || operation.actor_kind !== "agent" || !operation.actor_session_id
    || !operation.idempotency_key?.startsWith(`dispatch-work:${operation.actor_session_id}:`)) return null;

  let runtimeSessionId: string | null = null;
  let runtimeEventId: number | null = null;
  if (failure.stage === "delivery") {
    if (operation.operation_type !== "add_card_comment") return null;
    const related = (await sql<{ delivery_id: string }[]>`
      SELECT delivery_id FROM session_deliveries
      WHERE delivery_id=${failure.workId} AND producer_id=${operation.id} AND source='card_change'
    `)[0];
    if (!related) return null;
  } else {
    if (operation.operation_type !== "create_card") return null;
    const related = (await sql<CardExecutionRequest[]>`
      SELECT * FROM card_execution_requests
      WHERE id=${failure.workId} AND card_id=${failure.cardId}
        AND idempotency_key=${`dispatch-work-execution:${operation.id}`}
    `)[0];
    if (!related) return null;
    if (failure.stage === "runtime") {
      const eventPrefix = `dispatch-work-error:runtime:${related.session_id}:`;
      const eventText = failure.failureId.startsWith(eventPrefix) ? failure.failureId.slice(eventPrefix.length) : "";
      const eventId = /^\d+$/.test(eventText) ? Number(eventText) : NaN;
      const registration = await readCardExecutionRegistration(sql, related);
      if (!Number.isInteger(eventId) || eventId <= 0 || !registration?.registrationId || !registration.executionCommandId
        || failure.failureId !== canonicalWorkErrorRelationKey(related.session_id, eventId)) return null;
      const terminal = (await sql<{ session_id: string }[]>`
        SELECT session_id FROM sessions WHERE session_id=${related.session_id}
          AND status='error' AND termination_reason='error_aborted' AND termination_event_id=${eventId}
      `)[0];
      if (!terminal) return null;
      runtimeSessionId = related.session_id;
      runtimeEventId = eventId;
    }
  }

  const identity = JSON.stringify([operation.id, failure.workId, failure.stage, failure.failureId]);
  const relationKey = failure.stage === "runtime" && runtimeSessionId && runtimeEventId !== null
    ? canonicalWorkErrorRelationKey(runtimeSessionId, runtimeEventId)
    : `dispatch_work_error:${createHash("sha256").update(identity, "utf8").digest("hex")}`;
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${relationKey}, 0))`;
  const existing = (await sql<DeliveryQueryRow[]>`
    SELECT * FROM session_deliveries WHERE relation_key=${relationKey}
  `)[0];
  if (existing) return existing;

  const deliveryIdentity = buildDeterministicDeliveryIdentity({
    targetSessionId: operation.actor_session_id,
    relationKey,
    intent: "durable_next_turn",
  });
  const deliveryId = failure.stage === "runtime" && runtimeSessionId && runtimeEventId !== null
    ? canonicalWorkErrorDeliveryId(runtimeSessionId, runtimeEventId)
    : deliveryIdentity.deliveryId;
  const text = `카드: ${failure.cardId}\n작업: ${failure.workId}\n단계: ${failure.stage}\n오류: ${failure.message}`;
  const canonical = buildCanonicalDeliveryPayload({
    text,
    user: "",
    source: "card_change",
    relationKey: deliveryIdentity.relationKey,
    completionId: deliveryIdentity.completionId,
    callerInfo: { source: "agent", session_id: operation.actor_session_id },
  });
  const registered = await registerSessionDelivery(sql as unknown as DeliverySqlClient, {
    deliveryId,
    targetSessionId: operation.actor_session_id,
    sourceSessionId: operation.actor_session_id,
    relationKey: deliveryIdentity.relationKey,
    completionId: deliveryIdentity.completionId,
    intent: "durable_next_turn",
    source: "card_change",
    producerKind: "card_work_error",
    producerId: operation.id,
    payloadHash: canonical.payloadHash,
    payload: canonical.payload,
    createdAt: new Date(),
  });
  if (registered.conflict) throw new Error("Confirmed error delivery identity conflict");
  return registered.row;
}

export async function relayCanonicalErrorTx(sql: RepositorySql, input: CanonicalWorkError): Promise<SessionDeliveryRow | null> {
  if (!input.applied || input.status !== "error" || input.terminationReason !== "error_aborted"
    || !Number.isInteger(input.eventId) || input.eventId <= 0
    || !input.sessionId || !input.executionCommandId || !input.registrationId || !input.message) return null;

  const session = (await sql<{ session_id: string }[]>`
    SELECT session_id FROM sessions
    WHERE session_id=${input.sessionId} AND status='error'
      AND termination_reason='error_aborted' AND termination_event_id=${input.eventId}
  `)[0];
  if (!session) return null;

  const candidates = await sql<DispatchRequest[]>`
    SELECT r.*,
      op.id AS operation_id,op.target_id AS card_id_from_operation,op.actor_session_id
    FROM card_execution_requests r
    JOIN folder_operations op ON r.idempotency_key='dispatch-work-execution:'||op.id
    WHERE r.session_id=${input.sessionId}
      AND op.operation_type='create_card' AND op.target_kind='card' AND op.actor_kind='agent'
      AND op.actor_session_id IS NOT NULL
  `;
  const matches: DispatchRequest[] = [];
  for (const candidate of candidates) {
    if (candidate.card_id !== candidate.card_id_from_operation) continue;
    const registration = await readCardExecutionRegistration(sql, candidate);
    if (registration?.registrationId === input.registrationId
      && registration.executionCommandId === input.executionCommandId) matches.push(candidate);
  }
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  return await recordConfirmedErrorTx(sql, {
    operationId: match.operation_id,
    cardId: match.card_id,
    workId: match.id,
    stage: "runtime",
    message: input.message,
    failureId: canonicalWorkErrorRelationKey(input.sessionId, input.eventId),
  });
}

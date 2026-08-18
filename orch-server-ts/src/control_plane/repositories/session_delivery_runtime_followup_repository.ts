import type {
  RegisterSessionDeliveryParams,
  RegisterSessionDeliveryResult,
  SessionDeliveryRow,
  SqlClient,
} from "../control_plane_types.js";
import { asPostgresJsonValue } from "../repository_helpers.js";
import { appendSessionDeliveryAttempt } from
  "./session_delivery_attempt_repository.js";

export interface RuntimeFollowupCandidate {
  followupKey: string;
  followupAttempt: number;
  createdAt: Date;
  /** null denotes the candidate currently entering the serialized admission gate. */
  enqueueSequence: bigint | null;
}

export async function registerRuntimeFollowupDelivery(
  transaction: SqlClient,
  params: RegisterSessionDeliveryParams,
  candidate: RuntimeFollowupCandidate,
): Promise<RegisterSessionDeliveryResult> {
  const targetSessionId = params.targetSessionId ?? null;
  await transaction`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`runtime_followup:${targetSessionId ?? "unresolved"}:${candidate.followupKey}`}, 0)
    )
  `;

  const exactRows = await transaction<SessionDeliveryRow[]>`
    SELECT * FROM session_deliveries WHERE delivery_id = ${params.deliveryId}
  `;
  const exact = exactRows[0];
  let resolvedExact: RegisterSessionDeliveryResult | undefined;
  if (exact) {
    resolvedExact = await resolveRegistrationConflict(transaction, params, exact);
    if (resolvedExact.conflict) return resolvedExact;
  }

  const pendingRows = await transaction<SessionDeliveryRow[]>`
    SELECT *
    FROM session_deliveries
    WHERE intent = 'runtime_followup'
      AND state = 'pending'
      AND target_session_id IS NOT DISTINCT FROM ${targetSessionId}
      AND payload->>'followup_key' = ${candidate.followupKey}
    ORDER BY
      CASE
        WHEN jsonb_typeof(payload->'followup_attempt') = 'number'
          THEN (payload->>'followup_attempt')::integer
        ELSE 1
      END DESC,
      created_at DESC,
      enqueue_sequence DESC
    FOR UPDATE
  `;
  const newestPending = pendingRows[0]
    ? runtimeFollowupCandidateFromRow(pendingRows[0])
    : undefined;
  if (exact && resolvedExact && resolvedExact.row.state !== "pending") {
    if (pendingRows[0]) {
      await supersedePendingRuntimeFollowupSiblings(
        transaction,
        params,
        targetSessionId,
        candidate.followupKey,
        pendingRows[0].delivery_id,
      );
    }
    return resolvedExact;
  }
  const candidateForOrder = exact
    ? runtimeFollowupCandidateFromRow(exact)
    : candidate;
  const candidateIsLatest = !newestPending
    || compareRuntimeFollowupCandidates(candidateForOrder, newestPending) >= 0;
  if (exact) {
    if (candidateIsLatest) {
      await supersedePendingRuntimeFollowupSiblings(
        transaction,
        params,
        targetSessionId,
        candidate.followupKey,
        params.deliveryId,
      );
      return { row: exact, inserted: false, conflict: false };
    }
    const supersededRows = await transaction<SessionDeliveryRow[]>`
      UPDATE session_deliveries
      SET
        state = 'superseded', aggregate_state = 'consumed',
        consumed_at = NOW(), consumed_reason = 'superseded by newer runtime follow-up',
        superseded_at = NOW(),
        superseded_terminal_revision = ${params.producerTerminalRevision ?? null},
        updated_at = NOW()
      WHERE delivery_id = ${params.deliveryId}
        AND state = 'pending'
      RETURNING *
    `;
    return {
      row: supersededRows[0] ?? exact,
      inserted: false,
      conflict: false,
    };
  }
  const initialState = candidateIsLatest ? "pending" : "superseded";
  const createdAt = candidate.createdAt;
  const insertedRows = await transaction<SessionDeliveryRow[]>`
    INSERT INTO session_deliveries (
      delivery_id, target_session_id, source_session_id, relation_key,
      completion_id, intent, source, producer_kind, producer_id,
      producer_terminal_revision, parent_delivery_id, caller_turn_id,
      payload_hash, payload, state, aggregate_state,
      created_at, updated_at, consumed_at, consumed_reason,
      superseded_at, superseded_terminal_revision
    ) VALUES (
      ${params.deliveryId}, ${targetSessionId},
      ${params.sourceSessionId ?? null}, ${params.relationKey},
      ${params.completionId ?? null}, ${params.intent}, ${params.source},
      ${params.producerKind ?? null}, ${params.producerId ?? null},
      ${params.producerTerminalRevision ?? null},
      ${params.parentDeliveryId ?? null}, ${params.callerTurnId ?? null},
      ${params.payloadHash},
      ${transaction.json(asPostgresJsonValue(params.payload))},
      ${initialState}, ${candidateIsLatest ? "pending" : "consumed"},
      ${createdAt}, ${createdAt},
      ${candidateIsLatest ? null : createdAt},
      ${candidateIsLatest ? null : "superseded by newer runtime follow-up"},
      ${candidateIsLatest ? null : createdAt},
      ${candidateIsLatest ? null : params.producerTerminalRevision ?? null}
    )
    ON CONFLICT DO NOTHING
    RETURNING *
  `;
  const inserted = insertedRows[0];
  if (!inserted) {
    const conflictRows = await transaction<SessionDeliveryRow[]>`
      SELECT *
      FROM session_deliveries
      WHERE delivery_id = ${params.deliveryId}
         OR relation_key = ${params.relationKey}
      ORDER BY CASE WHEN delivery_id = ${params.deliveryId} THEN 0 ELSE 1 END
      LIMIT 1
    `;
    const conflict = conflictRows[0];
    if (!conflict) {
      throw new Error(
        `Delivery disappeared after registration conflict: ${params.deliveryId}`,
      );
    }
    return await resolveRegistrationConflict(transaction, params, conflict);
  }
  if (candidateIsLatest) {
    await supersedePendingRuntimeFollowupSiblings(
      transaction,
      params,
      targetSessionId,
      candidate.followupKey,
      params.deliveryId,
    );
  }
  return { row: inserted, inserted: true, conflict: false };
}

async function supersedePendingRuntimeFollowupSiblings(
  transaction: SqlClient,
  params: RegisterSessionDeliveryParams,
  targetSessionId: string | null,
  followupKey: string,
  retainedDeliveryId: string,
): Promise<void> {
  await transaction`
    UPDATE session_deliveries
    SET
      state = 'superseded', aggregate_state = 'consumed',
      consumed_at = NOW(), consumed_reason = 'superseded by newer runtime follow-up',
      superseded_at = NOW(),
      superseded_terminal_revision = ${params.producerTerminalRevision ?? null},
      updated_at = NOW()
    WHERE intent = 'runtime_followup'
      AND state = 'pending'
      AND delivery_id <> ${retainedDeliveryId}
      AND target_session_id IS NOT DISTINCT FROM ${targetSessionId}
      AND payload->>'followup_key' = ${followupKey}
  `;
}

async function resolveRegistrationConflict(
  transaction: SqlClient,
  params: RegisterSessionDeliveryParams,
  existing: SessionDeliveryRow,
): Promise<RegisterSessionDeliveryResult> {
  const conflict =
    existing.delivery_id !== params.deliveryId
    || existing.relation_key !== params.relationKey
    || existing.payload_hash !== params.payloadHash
    || existing.intent !== params.intent
    || existing.completion_id !== (params.completionId ?? null);
  if (!conflict) {
    return { row: existing, inserted: false, conflict: false };
  }
  const uncertainRows = await transaction<SessionDeliveryRow[]>`
    UPDATE session_deliveries
    SET state = 'uncertain', aggregate_state = 'dead_letter',
        dead_letter_reason = 'delivery identity conflict',
        dead_lettered_at = NOW(), updated_at = NOW()
    WHERE delivery_id = ${existing.delivery_id}
      AND state NOT IN ('consumed', 'superseded')
    RETURNING *
  `;
  if (uncertainRows[0]) {
    await appendSessionDeliveryAttempt(transaction, {
      deliveryId: existing.delivery_id,
      outcome: "rejected",
      reason: "delivery identity conflict",
    });
  }
  return {
    row: uncertainRows[0] ?? existing,
    inserted: false,
    conflict: true,
  };
}

export function readRuntimeFollowupCandidate(
  params: RegisterSessionDeliveryParams,
): RuntimeFollowupCandidate | undefined {
  if (params.intent !== "runtime_followup") return undefined;
  const followupKey = params.payload.followup_key;
  const followupAttempt = params.payload.followup_attempt;
  if (
    typeof followupKey !== "string"
    || followupKey.length === 0
    || typeof followupAttempt !== "number"
    || !Number.isInteger(followupAttempt)
    || followupAttempt < 1
  ) {
    return undefined;
  }
  return {
    followupKey,
    followupAttempt,
    createdAt: params.createdAt ?? new Date(),
    enqueueSequence: null,
  };
}

function runtimeFollowupCandidateFromRow(
  row: SessionDeliveryRow,
): RuntimeFollowupCandidate {
  const attempt = row.payload.followup_attempt;
  return {
    followupKey: String(row.payload.followup_key),
    followupAttempt:
      typeof attempt === "number" && Number.isInteger(attempt) && attempt > 0
        ? attempt
        : 1,
    createdAt: row.created_at,
    enqueueSequence: BigInt(row.enqueue_sequence ?? 0),
  };
}

export function compareRuntimeFollowupCandidates(
  left: Pick<
    RuntimeFollowupCandidate,
    "followupAttempt" | "createdAt" | "enqueueSequence"
  >,
  right: Pick<
    RuntimeFollowupCandidate,
    "followupAttempt" | "createdAt" | "enqueueSequence"
  >,
): number {
  return left.followupAttempt - right.followupAttempt
    || left.createdAt.getTime() - right.createdAt.getTime()
    || compareEnqueueSequence(left.enqueueSequence, right.enqueueSequence);
}

function compareEnqueueSequence(left: bigint | null, right: bigint | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left > right ? 1 : -1;
}

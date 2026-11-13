import type {
  RecordObservedChildCompletionBatchResult,
  RecordObservedChildCompletionParams,
  RecordObservedChildCompletionResult,
  RecordSessionDeliveryRelationConsumptionParams,
  RecordSessionDeliveryRelationConsumptionResult,
  RegisterSessionDeliveryParams,
  RegisterSessionDeliveryResult,
  SessionDeliveryRelationConsumptionRow,
  SessionDeliveryRow,
  SqlClient,
} from "../control_plane_types.js";
import { asPostgresJsonValue } from "../repository_helpers.js";
import { appendSessionDeliveryAttempt } from
  "./session_delivery_attempt_repository.js";
import { discardSessionDeliveryNotificationProjections } from
  "./session_delivery_notification_projection_repository.js";
import {
  readRuntimeFollowupCandidate,
  registerRuntimeFollowupDelivery,
} from "./session_delivery_runtime_followup_repository.js";
import { isTerminalSessionStatus } from "../../session/session_status.js";

/**
 * 등록 요청. `reviveDeadLetter`는 보낸 쪽의 명시적 되살림 요청이다: 같은
 * relation_key의 행이 uncertain/dead_letter면 이번 등록의 내용과 새 재시도
 * 예산으로 pending에 되돌린다. 없으면 기존 동작이다.
 */
export type RegisterSessionDeliveryRequest = RegisterSessionDeliveryParams & {
  reviveDeadLetter?: boolean;
};

export { compareRuntimeFollowupCandidates } from
  "./session_delivery_runtime_followup_repository.js";

export async function registerSessionDelivery(
  sql: SqlClient,
  params: RegisterSessionDeliveryRequest,
): Promise<RegisterSessionDeliveryResult> {
  return await withTransaction(sql, async (transaction) => {
    const runtimeFollowup = readRuntimeFollowupCandidate(params);
    if (runtimeFollowup) {
      return await registerRuntimeFollowupDelivery(
        transaction,
        params,
        runtimeFollowup,
      );
    }
    let consumption: SessionDeliveryRelationConsumptionRow | undefined;
    if (isChildCompletionRelation(params)) {
      await lockRelation(transaction, params.relationKey);
      const rows = await transaction<SessionDeliveryRelationConsumptionRow[]>`
        SELECT *
        FROM session_delivery_relation_consumptions
        WHERE relation_key = ${params.relationKey}
      `;
      consumption = rows[0];
    }
    if (
      consumption &&
      consumption.completion_id !== (params.completionId ?? null)
    ) {
      throw new Error(
        `Completion relation identity conflict: ${params.relationKey}`,
      );
    }
    const createdAt = params.createdAt ?? new Date();
    const insertedRows = await transaction<SessionDeliveryRow[]>`
      INSERT INTO session_deliveries (
        delivery_id, target_session_id, source_session_id, relation_key,
        completion_id, intent, source, producer_kind, producer_id,
        producer_terminal_revision, parent_delivery_id, caller_turn_id,
        payload_hash, payload, state, aggregate_state,
        target_receipt_id, target_receipt_at,
        created_at, updated_at, consumed_at, consumed_reason
      ) VALUES (
        ${params.deliveryId}, ${params.targetSessionId ?? null},
        ${params.sourceSessionId ?? null}, ${params.relationKey},
        ${params.completionId ?? null}, ${params.intent}, ${params.source},
        ${params.producerKind ?? null}, ${params.producerId ?? null},
        ${params.producerTerminalRevision ?? null},
        ${params.parentDeliveryId ?? null}, ${params.callerTurnId ?? null},
        ${params.payloadHash},
        ${transaction.json(asPostgresJsonValue(params.payload))},
        ${consumption ? "consumed" : "pending"},
        ${consumption ? "consumed" : "pending"},
        ${consumption?.consumed_turn_id ?? null},
        ${consumption?.consumed_at ?? null},
        ${createdAt}, ${createdAt}, ${consumption?.consumed_at ?? null},
        ${consumption ? "relation already consumed" : null}
      )
      ON CONFLICT DO NOTHING
      RETURNING *
    `;
    const inserted = insertedRows[0];
    if (inserted) {
      return { row: inserted, inserted: true, conflict: false };
    }

    const existingRows = await transaction<SessionDeliveryRow[]>`
      SELECT *
      FROM session_deliveries
      WHERE delivery_id = ${params.deliveryId}
         OR relation_key = ${params.relationKey}
      ORDER BY CASE WHEN delivery_id = ${params.deliveryId} THEN 0 ELSE 1 END
      LIMIT 1
    `;
    const existing = existingRows[0];
    if (!existing) {
      throw new Error(
        `Delivery disappeared after registration conflict: ${params.deliveryId}`,
      );
    }
    const conflict =
      existing.delivery_id !== params.deliveryId ||
      existing.relation_key !== params.relationKey ||
      existing.payload_hash !== params.payloadHash ||
      existing.intent !== params.intent ||
      existing.completion_id !== (params.completionId ?? null);
    const revive = params.reviveDeadLetter === true;
    if (!conflict && !(revive && isDeadLetterRow(existing))) {
      return { row: existing, inserted: false, conflict: false };
    }

    let current = existing;
    // 되살림을 요청한 등록이 이미 죽은 행을 만나면 다시 죽이지 않고 곧장 되살린다.
    if (conflict && !(revive && isDeadLetterRow(existing))) {
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
      current = uncertainRows[0] ?? existing;
    }
    if (
      revive
      && current.relation_key === params.relationKey
      && isDeadLetterRow(current)
    ) {
      // 보낸 쪽이 같은 신원으로 명시한 되살림이다. 새 내용이 이기고 재시도
      // 예산(횟수와 나이)을 처음부터 다시 받는다. consumed/superseded는 닿지 않는다.
      const revivedRows = await transaction<SessionDeliveryRow[]>`
        UPDATE session_deliveries
        SET state = 'pending', aggregate_state = 'pending',
            payload_hash = ${params.payloadHash},
            payload = ${transaction.json(asPostgresJsonValue(params.payload))},
            completion_id = ${params.completionId ?? null},
            intent = ${params.intent}, source = ${params.source},
            attempt_count = 0, next_attempt_at = NOW(), created_at = NOW(),
            attempt_token = NULL, attempt_expires_at = NULL,
            claimed_at = NULL, dispatching_at = NULL, queued_at = NULL,
            delivered_at = NULL, target_receipt_id = NULL,
            target_receipt_at = NULL, last_error = NULL,
            dead_letter_reason = NULL, dead_lettered_at = NULL,
            updated_at = NOW()
        WHERE delivery_id = ${current.delivery_id}
          AND state NOT IN ('consumed', 'superseded')
          AND (state = 'uncertain' OR aggregate_state = 'dead_letter')
        RETURNING *
      `;
      if (revivedRows[0]) {
        // 알림 outbox 행(dead_letter/discarded, 때로는 published)이 남아 있으면
        // 다음 stage가 "notification outbox already exists"로 막히고, 남은 행의
        // payload도 새 내용과 어긋난다. 되살린 delivery 행을 먼저 갱신한 같은
        // 트랜잭션에서(락 순서: delivery 다음 outbox) 지워 새로 stage되게 한다.
        // 이 outbox를 참조하는 FK나 표는 없다.
        await transaction`
          DELETE FROM session_delivery_notification_outbox
          WHERE delivery_id = ${current.delivery_id}
        `;
        await appendSessionDeliveryAttempt(transaction, {
          deliveryId: current.delivery_id,
          outcome: "retryable",
          reason: "delivery revived by sender",
        });
        return { row: revivedRows[0], inserted: false, conflict: false };
      }
    }
    return { row: current, inserted: false, conflict };
  });
}

function isDeadLetterRow(row: SessionDeliveryRow): boolean {
  return row.state !== "consumed"
    && row.state !== "superseded"
    && (row.state === "uncertain" || row.aggregate_state === "dead_letter");
}

export async function getSessionDeliveryRelationConsumption(
  sql: SqlClient,
  relationKey: string,
): Promise<SessionDeliveryRelationConsumptionRow | null> {
  const rows = await sql<SessionDeliveryRelationConsumptionRow[]>`
    SELECT *
    FROM session_delivery_relation_consumptions
    WHERE relation_key = ${relationKey}
  `;
  return rows[0] ?? null;
}

export async function recordSessionDeliveryRelationConsumed(
  sql: SqlClient,
  params: RecordSessionDeliveryRelationConsumptionParams,
): Promise<RecordSessionDeliveryRelationConsumptionResult> {
  return await withTransaction(sql, async (transaction) =>
    await recordRelationConsumedInTransaction(transaction, params));
}

/**
 * Commits the observation tombstone against the exact child revision exposed
 * to the caller. The child row remains share-locked until the relation write
 * commits, so excerpt construction cannot race a later terminal revision into
 * a mismatched tombstone.
 */
export async function recordObservedChildCompletion(
  sql: SqlClient,
  params: RecordObservedChildCompletionParams,
): Promise<RecordObservedChildCompletionResult> {
  const result = await recordObservedChildCompletions(sql, [params]);
  return result.status;
}

/**
 * Validates every child revision before writing any tombstone, then records
 * the whole observation set in the same transaction. A stale member aborts
 * the batch without partially consuming another child returned by the same
 * query.
 */
export async function recordObservedChildCompletions(
  sql: SqlClient,
  params: RecordObservedChildCompletionParams[],
): Promise<RecordObservedChildCompletionBatchResult> {
  return await withTransaction(sql, async (transaction) => {
    const validationOrder = [...params].sort((left, right) =>
      left.childSessionId.localeCompare(right.childSessionId)
      || left.relationKey.localeCompare(right.relationKey));
    for (const observation of validationOrder) {
      const childRows = await transaction<Array<{
        caller_session_id: string | null;
        status: string | null;
        last_event_id: number | null;
      }>>`
        SELECT caller_session_id, status, last_event_id
        FROM sessions
        WHERE session_id = ${observation.childSessionId}
        FOR SHARE
      `;
      const child = childRows[0];
      if (!child) {
        return {
          status: "not_found",
          childSessionId: observation.childSessionId,
        };
      }
      if (child.caller_session_id !== observation.callerSessionId) {
        return {
          status: "not_child_caller",
          childSessionId: observation.childSessionId,
        };
      }
      if (!isTerminalStatus(child.status)) {
        return {
          status: "not_terminal",
          childSessionId: observation.childSessionId,
        };
      }
      if (child.last_event_id === null) {
        return {
          status: "missing_terminal_revision",
          childSessionId: observation.childSessionId,
        };
      }
      if (child.last_event_id !== observation.observedRevision) {
        return {
          status: "revision_mismatch",
          childSessionId: observation.childSessionId,
        };
      }
    }

    const writeOrder = [...params].sort((left, right) =>
      left.relationKey.localeCompare(right.relationKey));
    for (const observation of writeOrder) {
      // The child row was share-locked and validated against the canonical
      // parent above, so a tombstone left under the previous assignee follows
      // that parent instead of rejecting a legitimate observation.
      await recordRelationConsumedInTransaction(transaction, observation, {
        allowReassignedChildCaller: true,
      });
    }
    return { status: "recorded" };
  });
}

async function recordRelationConsumedInTransaction(
  transaction: SqlClient,
  params: RecordSessionDeliveryRelationConsumptionParams,
  options: { allowReassignedChildCaller?: boolean } = {},
): Promise<RecordSessionDeliveryRelationConsumptionResult> {
  await lockRelation(transaction, params.relationKey);
  const insertedRows =
    await transaction<SessionDeliveryRelationConsumptionRow[]>`
      INSERT INTO session_delivery_relation_consumptions (
        relation_key, completion_id, caller_session_id, consumed_turn_id
      ) VALUES (
        ${params.relationKey}, ${params.completionId},
        ${params.callerSessionId}, ${params.consumedTurnId}
      )
      ON CONFLICT (relation_key) DO NOTHING
      RETURNING *
    `;
  const relationRows = insertedRows[0]
    ? insertedRows
    : await transaction<SessionDeliveryRelationConsumptionRow[]>`
        SELECT *
        FROM session_delivery_relation_consumptions
        WHERE relation_key = ${params.relationKey}
      `;
  let relation = relationRows[0];
  if (
    relation &&
    options.allowReassignedChildCaller &&
    relation.completion_id === params.completionId &&
    relation.caller_session_id !== params.callerSessionId
  ) {
    const reassignedRows =
      await transaction<SessionDeliveryRelationConsumptionRow[]>`
        UPDATE session_delivery_relation_consumptions
        SET caller_session_id = ${params.callerSessionId}
        WHERE relation_key = ${params.relationKey}
          AND completion_id = ${params.completionId}
        RETURNING *
      `;
    relation = reassignedRows[0];
  }
  if (
    !relation ||
    relation.completion_id !== params.completionId ||
    relation.caller_session_id !== params.callerSessionId
  ) {
    throw new Error(
      `Completion relation identity conflict: ${params.relationKey}`,
    );
  }
  const consumedRows = await transaction<SessionDeliveryRow[]>`
    UPDATE session_deliveries
    SET
      state = 'consumed',
      aggregate_state = 'consumed',
      caller_turn_id = ${params.consumedTurnId},
      target_receipt_id = COALESCE(target_receipt_id, ${params.consumedTurnId}),
      target_receipt_at = COALESCE(target_receipt_at, ${relation.consumed_at}),
      consumed_at = ${relation.consumed_at},
      consumed_reason = 'exact relation receipt',
      attempt_token = NULL,
      attempt_expires_at = NULL,
      updated_at = NOW()
    WHERE relation_key = ${params.relationKey}
      AND completion_id = ${params.completionId}
      AND (
        state IN ('pending', 'claimed', 'delivered')
        OR (intent = 'runtime_followup' AND state IN ('dispatching', 'queued'))
      )
    RETURNING *
  `;
  await discardSessionDeliveryNotificationProjections(
    transaction,
    consumedRows.map((row) => row.delivery_id),
  );
  return {
    relation,
    relationInserted: Boolean(insertedRows[0]),
    deliveryConsumed: Boolean(consumedRows[0]),
  };
}

function isTerminalStatus(status: string | null): boolean {
  return isTerminalSessionStatus(status ?? undefined);
}

async function lockRelation(sql: SqlClient, relationKey: string): Promise<void> {
  await sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${relationKey}, 0))
  `;
}

async function withTransaction<T>(
  sql: SqlClient,
  operation: (transaction: SqlClient) => Promise<T>,
): Promise<T> {
  if (typeof sql.begin !== "function") {
    return await operation(sql);
  }
  return await sql.begin(async (transaction) =>
    await operation(transaction as unknown as SqlClient)) as T;
}

function isChildCompletionRelation(
  params: Pick<
    RegisterSessionDeliveryParams,
    "intent" | "completionId" | "relationKey"
  >,
): boolean {
  return (
    params.intent === "completion_notification" &&
    typeof params.completionId === "string" &&
    params.completionId.length > 0 &&
    params.relationKey.startsWith("child_session:")
  );
}

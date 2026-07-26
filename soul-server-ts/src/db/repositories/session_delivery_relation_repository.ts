import type {
  RecordSessionDeliveryRelationConsumptionParams,
  RecordSessionDeliveryRelationConsumptionResult,
  RegisterSessionDeliveryParams,
  RegisterSessionDeliveryResult,
  SessionDeliveryRelationConsumptionRow,
  SessionDeliveryRow,
  SqlClient,
} from "../session_db_types.js";
import { asPostgresJsonValue } from "./repository_helpers.js";

export async function registerSessionDelivery(
  sql: SqlClient,
  params: RegisterSessionDeliveryParams,
): Promise<RegisterSessionDeliveryResult> {
  return await withTransaction(sql, async (transaction) => {
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
        supervisor_role, payload_hash, payload, state, created_at, updated_at,
        consumed_at
      ) VALUES (
        ${params.deliveryId}, ${params.targetSessionId ?? null},
        ${params.sourceSessionId ?? null}, ${params.relationKey},
        ${params.completionId ?? null}, ${params.intent}, ${params.source},
        ${params.producerKind ?? null}, ${params.producerId ?? null},
        ${params.producerTerminalRevision ?? null},
        ${params.parentDeliveryId ?? null}, ${params.callerTurnId ?? null},
        ${params.supervisorRole ?? null}, ${params.payloadHash},
        ${transaction.json(asPostgresJsonValue(params.payload))},
        ${consumption ? "consumed" : "pending"}, ${createdAt}, ${createdAt},
        ${consumption?.consumed_at ?? null}
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
    if (!conflict) {
      return { row: existing, inserted: false, conflict: false };
    }

    const uncertainRows = await transaction<SessionDeliveryRow[]>`
      UPDATE session_deliveries
      SET state = 'uncertain', updated_at = NOW()
      WHERE delivery_id = ${existing.delivery_id}
        AND state <> 'consumed'
      RETURNING *
    `;
    return {
      row: uncertainRows[0] ?? { ...existing, state: "uncertain" },
      inserted: false,
      conflict: true,
    };
  });
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
  return await withTransaction(sql, async (transaction) => {
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
    const relation = relationRows[0];
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
        caller_turn_id = ${params.consumedTurnId},
        consumed_at = ${relation.consumed_at},
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = NOW()
      WHERE relation_key = ${params.relationKey}
        AND completion_id = ${params.completionId}
        AND state IN ('pending', 'claimed')
      RETURNING *
    `;
    return {
      relation,
      relationInserted: Boolean(insertedRows[0]),
      deliveryConsumed: Boolean(consumedRows[0]),
    };
  });
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

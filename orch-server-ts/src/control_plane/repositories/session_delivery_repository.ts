import type {
  DeliveryAggregateState,
  DeliveryIntent,
  RecordObservedChildCompletionBatchResult,
  RecordObservedChildCompletionParams,
  RecordObservedChildCompletionResult,
  RecordSessionDeliveryRelationConsumptionParams,
  RecordSessionDeliveryRelationConsumptionResult,
  RegisterSessionDeliveryParams,
  RegisterSessionDeliveryResult,
  SessionDeliveryRelationConsumptionRow,
  SessionDeliveryRow,
} from "@soulstream/wire-schema/session-delivery";
import type {
  SqlClient,
} from "../control_plane_types.js";
import { asPostgresJsonValue } from "../repository_helpers.js";
import { SessionDeliveryNotificationRepository } from "./session_delivery_notification_repository.js";
import { discardSessionDeliveryNotificationProjection } from
  "./session_delivery_notification_projection_repository.js";
import { SessionDeliveryRecoveryRepository } from
  "./session_delivery_recovery_repository.js";
import { markSessionDeliveryConsumed } from
  "./session_delivery_consumption_transition.js";
import { appendSessionDeliveryAttempt } from
  "./session_delivery_attempt_repository.js";
import {
  attemptOutcomeFor,
  deliveryRetryOrDeadLetterSet,
} from "./session_delivery_retry_policy.js";
import { settleTerminalTargetCompletionDeliveries } from
  "./session_delivery_terminal_target_transition.js";
import type { RegisterSessionDeliveryRequest } from "@soulstream/mcp-contract";
import {
  getSessionDeliveryRelationConsumption,
  recordObservedChildCompletion,
  recordObservedChildCompletions,
  recordSessionDeliveryRelationConsumed,
  registerSessionDelivery,
} from "./session_delivery_relation_repository.js";

const DEFAULT_DISPATCH_LEASE_MS = 120_000;

/**
 * 만료 sweep이 닫은 행의 투영. 이 메서드는 반환형이 개수(number)라 결과 행을
 * 밖으로 낼 수 없어, persistence host 디스패치가 선택적 관찰자로 행을 받는다.
 */
export type SessionDeliveryDeadLetterRow = {
  delivery_id: string;
  target_session_id: string | null;
  intent: DeliveryIntent;
  aggregate_state: DeliveryAggregateState;
  payload: Record<string, unknown>;
};

export class SessionDeliveryRepository {
  readonly notifications: SessionDeliveryNotificationRepository;
  readonly recovery: SessionDeliveryRecoveryRepository;

  constructor(private readonly sql: SqlClient) {
    this.notifications = new SessionDeliveryNotificationRepository(sql);
    this.recovery = new SessionDeliveryRecoveryRepository(sql);
  }

  async register(
    params: RegisterSessionDeliveryRequest,
  ): Promise<RegisterSessionDeliveryResult> {
    return await registerSessionDelivery(this.sql, params);
  }

  async get(deliveryId: string): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      SELECT * FROM session_deliveries WHERE delivery_id = ${deliveryId}
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

  async getByRelation(relationKey: string): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      SELECT *
      FROM session_deliveries
      WHERE relation_key = ${relationKey}
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

  async getRelationConsumption(
    relationKey: string,
  ): Promise<SessionDeliveryRelationConsumptionRow | null> {
    return await getSessionDeliveryRelationConsumption(this.sql, relationKey);
  }

  async recordRelationConsumed(
    params: RecordSessionDeliveryRelationConsumptionParams,
  ): Promise<RecordSessionDeliveryRelationConsumptionResult> {
    return await recordSessionDeliveryRelationConsumed(this.sql, params);
  }

  async recordObservedChildCompletion(
    params: RecordObservedChildCompletionParams,
  ): Promise<RecordObservedChildCompletionResult> {
    return await recordObservedChildCompletion(this.sql, params);
  }

  async recordObservedChildCompletions(
    params: RecordObservedChildCompletionParams[],
  ): Promise<RecordObservedChildCompletionBatchResult> {
    return await recordObservedChildCompletions(this.sql, params);
  }

  async claim(
    deliveryId: string,
    attemptToken = "legacy",
    attemptTtlMs = 15_000,
  ): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries
      SET
        state = 'claimed',
        claimed_at = NOW(),
        attempt_token = ${attemptToken},
        attempt_expires_at = NOW() + (${attemptTtlMs}::double precision * INTERVAL '1 millisecond'),
        updated_at = NOW()
      WHERE delivery_id = ${deliveryId} AND state = 'pending'
      RETURNING *
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

  async claimAttemptForTarget(
    deliveryId: string,
    targetSessionId: string,
    attemptToken = "legacy",
    attemptTtlMs = 15_000,
  ): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries
      SET
        target_session_id = ${targetSessionId},
        state = 'claimed',
        claimed_at = NOW(),
        attempt_token = ${attemptToken},
        attempt_expires_at = NOW() + (${attemptTtlMs}::double precision * INTERVAL '1 millisecond'),
        updated_at = NOW()
      WHERE delivery_id = ${deliveryId}
        AND state IN ('pending', 'queued')
        AND EXISTS (
          SELECT 1 FROM sessions WHERE session_id = ${targetSessionId}
        )
      RETURNING *
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

  async beginDispatch(
    deliveryId: string,
    attemptToken?: string,
    dispatchLeaseMs = DEFAULT_DISPATCH_LEASE_MS,
  ): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries AS delivery
      SET
        state = 'dispatching',
        dispatching_at = NOW(),
        attempt_expires_at = NOW()
          + (${dispatchLeaseMs}::double precision * INTERVAL '1 millisecond'),
        updated_at = NOW()
      WHERE delivery.delivery_id = ${deliveryId}
        AND delivery.state = 'claimed'
        AND (${attemptToken ?? null}::text IS NULL OR delivery.attempt_token = ${attemptToken ?? null})
        AND (
          delivery.attempt_expires_at IS NULL
          OR delivery.attempt_expires_at > NOW()
        )
        AND (
          delivery.intent <> 'completion_notification'
          OR delivery.source <> 'completion_notifier'
          OR EXISTS (
            SELECT 1
            FROM sessions AS source_session
            WHERE source_session.session_id = delivery.source_session_id
              AND source_session.status IN ('completed', 'error', 'interrupted')
              AND source_session.termination_event_id IS NOT NULL
              AND source_session.termination_event_id::text
                = delivery.producer_terminal_revision
          )
        )
      RETURNING delivery.*
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

  async claimRecoverableCompletionDeliveries(
    attemptToken: string,
    limit = 100,
    attemptTtlMs = 15_000,
  ): Promise<SessionDeliveryRow[]> {
    return await this.recovery.claimRecoverableCompletionDeliveries(
      attemptToken,
      limit,
      attemptTtlMs,
    );
  }

  async deferPending(
    deliveryId: string,
    error: string,
    retryDelayMs: number,
  ): Promise<SessionDeliveryRow | null> {
    return await withDeliveryTransaction(this.sql, async (transaction) => {
      const rows = await transaction<SessionDeliveryRow[]>`
        UPDATE session_deliveries
        SET ${deliveryRetryOrDeadLetterSet(transaction as unknown as SqlClient, {
          reason: error,
          retryState: "pending",
          retryDelayMs,
        })}
        WHERE delivery_id = ${deliveryId}
          AND state = 'pending'
        RETURNING *
      `;
      const row = rows[0];
      if (!row) return null;
      await appendSessionDeliveryAttempt(transaction as unknown as SqlClient, {
        deliveryId,
        outcome: attemptOutcomeFor(row),
        reason: error,
      });
      return normalizeDeliveryRow(row);
    });
  }

  async retryDeliveryAttempt(
    deliveryId: string,
    attemptToken: string,
    error: string,
    retryDelayMs: number,
  ): Promise<SessionDeliveryRow | null> {
    return await withDeliveryTransaction(this.sql, async (transaction) => {
      const rows = await transaction<SessionDeliveryRow[]>`
        UPDATE session_deliveries
        SET ${deliveryRetryOrDeadLetterSet(transaction as unknown as SqlClient, {
          reason: error,
          retryState: "pending",
          retryDelayMs,
        })}
        WHERE delivery_id = ${deliveryId}
          AND attempt_token = ${attemptToken}
          AND state IN ('claimed', 'dispatching', 'queued')
        RETURNING *
      `;
      const row = rows[0];
      if (!row) return null;
      await appendSessionDeliveryAttempt(transaction as unknown as SqlClient, {
        deliveryId,
        outcome: attemptOutcomeFor(row),
        reason: error,
        attemptToken,
      });
      return normalizeDeliveryRow(row);
    });
  }

  async markPendingSuperseded(
    deliveryId: string,
    supersededTerminalRevision: string,
  ): Promise<SessionDeliveryRow | null> {
    return await withDeliveryTransaction(this.sql, async (transaction) => {
      const rows = await transaction<SessionDeliveryRow[]>`
        UPDATE session_deliveries
        SET
          state = 'superseded',
          aggregate_state = 'consumed',
          consumed_reason = ${supersededTerminalRevision},
          consumed_at = NOW(),
          superseded_at = NOW(),
          superseded_terminal_revision = ${supersededTerminalRevision},
          updated_at = NOW()
        WHERE delivery_id = ${deliveryId}
          AND state = 'pending'
        RETURNING *
      `;
      if (!rows[0]) return null;
      await discardSessionDeliveryNotificationProjection(transaction, deliveryId);
      return normalizeDeliveryRow(rows[0]);
    });
  }

  async expireStaleDeliveryAttempts(
    onDeadLetterRow?: (row: SessionDeliveryDeadLetterRow) => void,
  ): Promise<number> {
    return await withDeliveryTransaction(this.sql, async (transaction) => {
      // The retry SET clears attempt_token before RETURNING, so read the token the
      // attempt was claimed with before the update (card #1653). The suffix of the
      // token (route:, card-change:, node-ready:, maintenance:) tells who held it.
      const rows = await transaction<Array<SessionDeliveryDeadLetterRow & {
        attempt_token_snapshot: string | null;
      }>>`
        WITH candidate AS MATERIALIZED (
          SELECT delivery_id, attempt_token AS attempt_token_snapshot
          FROM session_deliveries
          WHERE state IN ('claimed', 'dispatching')
            AND attempt_expires_at <= NOW()
          FOR UPDATE
        )
        UPDATE session_deliveries AS delivery
        SET ${deliveryRetryOrDeadLetterSet(transaction as unknown as SqlClient, {
          reason: "delivery attempt expired",
          retryState: "pending",
          preserveExistingError: true,
        })}
        FROM candidate
        WHERE delivery.delivery_id = candidate.delivery_id
        RETURNING delivery.delivery_id, candidate.attempt_token_snapshot,
          delivery.aggregate_state, delivery.target_session_id, delivery.intent,
          delivery.payload
      `;
      for (const row of rows) {
        await appendSessionDeliveryAttempt(transaction as unknown as SqlClient, {
          deliveryId: row.delivery_id,
          outcome: attemptOutcomeFor(row),
          reason: "delivery attempt expired",
          attemptToken: row.attempt_token_snapshot,
        });
        // 재시도 예산이 남아 pending으로 돌아간 행은 실패가 아니다.
        if (row.aggregate_state === "dead_letter") onDeadLetterRow?.(row);
      }
      // 대상 세션이 지워지면 FK ON DELETE SET NULL이 target을 비우고, pending을
      // 집는 쿼리는 모두 세션과 조인해 이 줄을 다시 집지 않는다. 재시도 예산도
      // 호출이 없으면 계산되지 않아 영원히 pending으로 남는다. 24시간 지난 줄만
      // 소진과 같은 쌍(uncertain/dead_letter)으로 닫는다.
      const orphaned = await transaction<Array<SessionDeliveryDeadLetterRow & {
        attempt_token: string | null;
      }>>`
        UPDATE session_deliveries
        SET
          state = 'uncertain',
          aggregate_state = 'dead_letter',
          attempt_count = attempt_count + 1,
          attempt_token = NULL,
          attempt_expires_at = NULL,
          last_error = 'target_session_missing',
          dead_letter_reason = 'target_session_missing',
          dead_lettered_at = NOW(),
          updated_at = NOW()
        WHERE target_session_id IS NULL
          AND state = 'pending'
          AND aggregate_state = 'pending'
          AND updated_at <= NOW() - INTERVAL '24 hours'
        RETURNING delivery_id, attempt_token, aggregate_state,
          target_session_id, intent, payload
      `;
      for (const row of orphaned) {
        await appendSessionDeliveryAttempt(transaction as unknown as SqlClient, {
          deliveryId: row.delivery_id,
          outcome: attemptOutcomeFor(row),
          reason: "target_session_missing",
          attemptToken: row.attempt_token,
        });
        onDeadLetterRow?.(row);
      }
      await settleTerminalTargetCompletionDeliveries(transaction);
      return rows.length;
    });
  }

  async markQueued(
    deliveryId: string,
    attemptToken?: string,
  ): Promise<SessionDeliveryRow | null> {
    return await withDeliveryTransaction(this.sql, async (transaction) => {
      const rows = await transaction<SessionDeliveryRow[]>`
        UPDATE session_deliveries
        SET state = 'queued', aggregate_state = 'pending',
            queued_at = NOW(), updated_at = NOW()
        WHERE delivery_id = ${deliveryId}
          AND state = 'dispatching'
          AND (${attemptToken ?? null}::text IS NULL OR attempt_token = ${attemptToken ?? null})
        RETURNING *
      `;
      const row = rows[0];
      if (!row) return null;
      await appendSessionDeliveryAttempt(transaction as unknown as SqlClient, {
        deliveryId,
        outcome: "accepted",
        reason: "durable local admission",
        attemptToken: row.attempt_token,
      });
      return normalizeDeliveryRow(row);
    });
  }

  async markDelivered(
    deliveryId: string,
    callerTurnId: string,
  ): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries
      SET
        state = 'delivered',
        aggregate_state = 'delivered',
        caller_turn_id = ${callerTurnId},
        target_receipt_id = ${callerTurnId},
        target_receipt_at = NOW(),
        delivered_at = NOW(),
        updated_at = NOW()
      WHERE delivery_id = ${deliveryId}
        AND aggregate_state = 'pending'
        AND state IN ('dispatching', 'claimed', 'queued')
      RETURNING *
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

  async markConsumed(
    deliveryId: string,
    consumedTurnId: string,
  ): Promise<SessionDeliveryRow | null> {
    const consumed = await markSessionDeliveryConsumed(
      this.sql,
      deliveryId,
      consumedTurnId,
    );
    return consumed ? normalizeDeliveryRow(consumed) : null;
  }

  async markConsumedByRelation(
    relationKey: string,
    completionId: string,
    callerTurnId: string,
  ): Promise<SessionDeliveryRow | null> {
    return await withDeliveryTransaction(this.sql, async (transaction) => {
      const rows = await transaction<SessionDeliveryRow[]>`
        UPDATE session_deliveries
        SET
          state = 'consumed',
          aggregate_state = 'consumed',
          caller_turn_id = ${callerTurnId},
          target_receipt_id = COALESCE(target_receipt_id, ${callerTurnId}),
          target_receipt_at = COALESCE(target_receipt_at, NOW()),
          consumed_at = NOW(),
          updated_at = NOW()
        WHERE relation_key = ${relationKey}
          AND completion_id = ${completionId}
          AND aggregate_state IN ('pending', 'delivered')
          AND state IN ('pending', 'claimed', 'delivered')
        RETURNING *
      `;
      if (!rows[0]) return null;
      await discardSessionDeliveryNotificationProjection(transaction, rows[0].delivery_id);
      return normalizeDeliveryRow(rows[0]);
    });
  }

  async markUncertain(
    deliveryId: string,
    attemptToken?: string,
    error?: string,
  ): Promise<SessionDeliveryRow | null> {
    return await withDeliveryTransaction(this.sql, async (transaction) => {
      const reason = error ?? "delivery result rejected";
      const rows = await transaction<Array<SessionDeliveryRow & {
        attempt_token_snapshot: string | null;
      }>>`
        WITH candidate AS MATERIALIZED (
          SELECT delivery_id, attempt_token AS attempt_token_snapshot
          FROM session_deliveries
          WHERE delivery_id = ${deliveryId}
            AND aggregate_state NOT IN ('consumed', 'dead_letter')
            AND state NOT IN ('consumed', 'superseded')
            AND (
              ${attemptToken ?? null}::text IS NULL
              OR (attempt_token = ${attemptToken ?? null}
                AND state IN ('claimed', 'dispatching', 'queued'))
            )
          FOR UPDATE
        )
        UPDATE session_deliveries AS delivery
        SET
          state = 'uncertain',
          aggregate_state = 'dead_letter',
          attempt_token = NULL,
          attempt_expires_at = NULL,
          attempt_count = delivery.attempt_count + 1,
          last_error = ${reason},
          dead_letter_reason = ${reason},
          dead_lettered_at = NOW(),
          updated_at = NOW()
        FROM candidate
        WHERE delivery.delivery_id = candidate.delivery_id
        RETURNING delivery.*, candidate.attempt_token_snapshot
      `;
      const row = rows[0];
      if (!row) return null;
      await appendSessionDeliveryAttempt(transaction as unknown as SqlClient, {
        deliveryId,
        outcome: "rejected",
        reason,
        attemptToken: row.attempt_token_snapshot,
      });
      await discardSessionDeliveryNotificationProjection(
        transaction,
        deliveryId,
        reason,
      );
      return normalizeDeliveryRow(row);
    });
  }

}

export async function insertSessionDeliveryRow(
  transaction: SqlClient,
  params: RegisterSessionDeliveryParams,
  consumption: SessionDeliveryRelationConsumptionRow | undefined,
): Promise<SessionDeliveryRow[]> {
  const createdAt = params.createdAt ?? new Date();
  return await transaction<SessionDeliveryRow[]>`
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
}

export async function markDeliveryIdentityConflict(
  transaction: SqlClient,
  existing: SessionDeliveryRow,
): Promise<SessionDeliveryRow | null> {
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
  return uncertainRows[0] ?? null;
}

function normalizeDeliveryRow(row: SessionDeliveryRow): SessionDeliveryRow {
  return row;
}

async function withDeliveryTransaction<T>(
  sql: SqlClient,
  operation: (transaction: SqlClient) => Promise<T>,
): Promise<T> {
  const begin = (sql as SqlClient & {
    begin?: (callback: (transaction: SqlClient) => Promise<T>) => Promise<T>;
  }).begin;
  return begin
    ? await begin.call(sql, operation)
    : await operation(sql);
}

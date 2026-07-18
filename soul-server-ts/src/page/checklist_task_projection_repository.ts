import type { SqlClient } from "../db/session_db.js";

export type ChecklistProjectionActorKind = "agent" | "user" | "system";

export interface ChecklistProjectionOutboxRow {
  block_id: string;
  page_id: string;
  source_hash: string;
  actor_kind: ChecklistProjectionActorKind;
  actor_session_id: string | null;
  actor_user_id: string | null;
  routing_session_id: string;
  attempts: number;
}

const DEFAULT_LEASE_MS = 30_000;

/** Durable lease/retry boundary for checklist projection work shared by all workers. */
export class ChecklistTaskProjectionRepository {
  constructor(
    private readonly sql: SqlClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async claimDue(
    nodeId: string,
    limit = 20,
    leaseMs = DEFAULT_LEASE_MS,
  ): Promise<ChecklistProjectionOutboxRow[]> {
    return await this.sql.begin(async (sql) => {
      const localSessions = await sql<Array<{ session_id: string }>>`
        SELECT session_id
        FROM sessions
        WHERE node_id = ${nodeId}
        ORDER BY updated_at DESC, session_id
        LIMIT 1
      `;
      const localSessionId = localSessions[0]?.session_id;
      if (!localSessionId) return [];
      const now = this.now();
      const leaseExpiresAt = new Date(now.getTime() + leaseMs);
      const rows = await sql<ChecklistProjectionOutboxRow[]>`
        WITH due AS (
          SELECT outbox.block_id
          FROM checklist_task_projection_outbox outbox
          LEFT JOIN sessions actor_session
            ON actor_session.session_id = outbox.actor_session_id
          LEFT JOIN sessions routing_session
            ON routing_session.session_id = outbox.routing_session_id
          WHERE outbox.processed_hash IS DISTINCT FROM outbox.source_hash
            AND outbox.next_retry_at <= ${now}
            AND (
              outbox.lease_expires_at IS NULL
              OR outbox.lease_expires_at <= ${now}
            )
            AND (
              routing_session.node_id = ${nodeId}
              OR (
                outbox.routing_session_id IS NULL
                AND (outbox.actor_session_id IS NULL OR actor_session.node_id = ${nodeId})
              )
            )
          ORDER BY outbox.next_retry_at, outbox.updated_at, outbox.block_id
          FOR UPDATE OF outbox SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE checklist_task_projection_outbox outbox
        SET routing_session_id = COALESCE(
              outbox.routing_session_id,
              outbox.actor_session_id,
              ${localSessionId}
            ),
            lease_owner_node_id = ${nodeId},
            lease_expires_at = ${leaseExpiresAt},
            updated_at = ${now}
        FROM due
        WHERE outbox.block_id = due.block_id
        RETURNING
          outbox.block_id, outbox.page_id, outbox.source_hash,
          outbox.actor_kind, outbox.actor_session_id, outbox.actor_user_id,
          outbox.routing_session_id, outbox.attempts
      `;
      return rows.map(normalizeRow);
    });
  }

  async markSuccess(row: ChecklistProjectionOutboxRow, nodeId: string): Promise<boolean> {
    const rows = await this.sql<Array<{ block_id: string }>>`
      UPDATE checklist_task_projection_outbox
      SET processed_hash = source_hash,
          attempts = 0,
          last_error = NULL,
          next_retry_at = NOW(),
          lease_owner_node_id = NULL,
          lease_expires_at = NULL,
          updated_at = NOW()
      WHERE block_id = ${row.block_id}
        AND source_hash = ${row.source_hash}
        AND lease_owner_node_id = ${nodeId}
      RETURNING block_id
    `;
    return rows.length === 1;
  }

  async markFailure(
    row: ChecklistProjectionOutboxRow,
    nodeId: string,
    error: string,
  ): Promise<void> {
    const attempts = row.attempts + 1;
    const delayMs = Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 8));
    const nextRetryAt = new Date(this.now().getTime() + delayMs);
    await this.sql`
      UPDATE checklist_task_projection_outbox
      SET attempts = ${attempts},
          last_error = ${error},
          next_retry_at = ${nextRetryAt},
          lease_owner_node_id = NULL,
          lease_expires_at = NULL,
          updated_at = NOW()
      WHERE block_id = ${row.block_id}
        AND source_hash = ${row.source_hash}
        AND lease_owner_node_id = ${nodeId}
    `;
  }
}

function normalizeRow(row: ChecklistProjectionOutboxRow): ChecklistProjectionOutboxRow {
  return { ...row, attempts: Number(row.attempts) };
}

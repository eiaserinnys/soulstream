import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import { BoardYjsSqlResolver } from "./board_yjs_sql.js";
import type { ChecklistProjectionOutboxRow } from "./board_projection_types.js";

const DEFAULT_LEASE_MS = 30_000;

export class ChecklistProjectionRepository {
  private readonly sqlResolver: BoardYjsSqlResolver;

  constructor(
    resolver: LiveDbSqlResolver,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.sqlResolver = new BoardYjsSqlResolver(resolver);
  }

  async claimDue(
    nodeId: string,
    limit = 20,
    leaseMs = DEFAULT_LEASE_MS,
  ): Promise<ChecklistProjectionOutboxRow[]> {
    const sql = await this.sqlResolver.resolveSql();
    return await sql.begin(async (transaction) => {
      const localSessions = await transaction<readonly { session_id: string }[]>`
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
      const rows = await transaction<readonly ChecklistProjectionOutboxRow[]>`
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
      return rows.map((row) => ({ ...row, attempts: Number(row.attempts) }));
    });
  }

  async markSuccess(
    row: ChecklistProjectionOutboxRow,
    nodeId: string,
  ): Promise<boolean> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql<readonly { block_id: string }[]>`
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
    const sql = await this.sqlResolver.resolveSql();
    await sql`
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

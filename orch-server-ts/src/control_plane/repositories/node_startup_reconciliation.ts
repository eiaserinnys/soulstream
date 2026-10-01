import type { SqlClient } from "../control_plane_types.js";

/** Server-owned revision: PostgreSQL text retains sub-millisecond precision. */
export type NodeStartupTarget = {
  sessionId: string;
  updatedAt: string;
  status: "running" | "initializing";
  executionRegistrationId: string | null;
  executionCommandId: string | null;
};

export async function captureNodeStartupTargets(sql: SqlClient, nodeId: string): Promise<NodeStartupTarget[]> {
  return await sql<NodeStartupTarget[]>`
    SELECT session_id AS "sessionId", updated_at::text AS "updatedAt", status,
           execution_registration_id AS "executionRegistrationId",
           execution_command_id AS "executionCommandId"
    FROM sessions
    WHERE node_id = ${nodeId}
      AND (status = 'running' OR (status = 'initializing' AND execution_registration_id IS NULL))
    ORDER BY session_id
  `;
}

/** Only a server-request snapshot authorizes absence; unsolicited inventory can restore. */
export async function reconcileNodeStartup(
  sql: SqlClient, nodeId: string, runningSessionIds: string[], updatedAt: Date,
  targets: NodeStartupTarget[] = [],
) {
  return await sql.begin(async (sql) => {
    const interruptedRows = await sql<Array<ReconciledSessionRow>>`
      UPDATE sessions AS session
      SET status = 'interrupted', was_running_at_shutdown = TRUE,
          termination_reason = 'killed', termination_detail = 'startup_reconciliation',
          review_state = CASE
            WHEN review_required THEN 'needs_review'
            ELSE 'acknowledged'
          END,
          updated_at = ${updatedAt}
      FROM jsonb_to_recordset(${sql.json(targets as never)}::jsonb) AS target(
        "sessionId" text, "updatedAt" timestamptz, status text,
        "executionRegistrationId" text, "executionCommandId" text
      )
      WHERE session.node_id = ${nodeId}
        AND session.session_id = target."sessionId"
        AND session.updated_at = target."updatedAt"
        AND session.status = target.status
        AND session.execution_registration_id IS NOT DISTINCT FROM target."executionRegistrationId"
        AND session.execution_command_id IS NOT DISTINCT FROM target."executionCommandId"
        AND NOT (session.session_id = ANY(${sql.array(runningSessionIds)}::text[]))
        AND (
          session.status = 'running'
          OR (session.status = 'initializing' AND session.execution_registration_id IS NULL)
        )
      RETURNING session.session_id, session.status, session.termination_reason,
                session.termination_detail, session.review_state, session.updated_at
    `;
    await sql`
      SELECT id FROM worktrees
      WHERE id IN (
        SELECT worktree_id FROM sessions
        WHERE node_id = ${nodeId}
          AND session_id = ANY(${sql.array(runningSessionIds)}::text[])
          AND worktree_id IS NOT NULL
      )
      FOR UPDATE
    `;
    const restoredRows = await sql<Array<ReconciledSessionRow>>`
      UPDATE sessions
      SET status = 'running', was_running_at_shutdown = FALSE,
          termination_reason = NULL, termination_detail = NULL,
          review_state = 'not_required',
          updated_at = ${updatedAt}
      WHERE node_id = ${nodeId}
        AND session_id = ANY(${sql.array(runningSessionIds)}::text[])
        AND status IN ('completed', 'error', 'interrupted')
        AND termination_event_id IS NULL
        AND updated_at <= ${updatedAt}
        AND (
          worktree_id IS NULL
          OR (
            EXISTS (
              SELECT 1 FROM worktrees
              WHERE worktrees.id = sessions.worktree_id
                AND worktrees.state = 'ready'
                AND (NOT worktrees.setup_required OR worktrees.setup_status = 'ready')
            )
            AND NOT EXISTS (
              SELECT 1 FROM sessions AS active
              WHERE active.worktree_id = sessions.worktree_id
                AND active.session_id <> sessions.session_id
                AND active.status IN ('initializing', 'running')
            )
          )
        )
      RETURNING session_id, status, termination_reason, termination_detail,
                review_state, updated_at
    `;
    return {
      interrupted: interruptedRows.length,
      restored: restoredRows.length,
      updates: [...interruptedRows, ...restoredRows].map(mapReconciledSessionRow),
    };
  });
}

export type ReconciledSessionRow = {
  session_id: string;
  status: "interrupted" | "running";
  termination_reason: string | null;
  termination_detail: string | null;
  review_state: string;
  updated_at: Date | string;
};

export function mapReconciledSessionRow(row: ReconciledSessionRow) {
  return {
    sessionId: row.session_id,
    status: row.status,
    terminationReason: row.termination_reason,
    terminationDetail: row.termination_detail,
    reviewState: row.review_state,
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  };
}

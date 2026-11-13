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
  sql: SqlClient, nodeId: string, runningSessionIds: string[], updatedAt: Date, targets: NodeStartupTarget[] = [],
) {
  return await sql.begin(async (sql) => {
    await lockInterruptTargetsInOrder(sql, nodeId, runningSessionIds, targets);
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
    // Lock order is session, then worktree, each table in key order. The ingress
    // gate (event_session_gate.ts) and the SQL functions take the same order, so
    // this transaction cannot deadlock with them on one session and its worktree.
    // The locks only precede the restore UPDATE below; they write nothing, so the
    // pinned session write lines (session-machine-inventory test) stay unchanged.
    await lockRestorableSessionsThenWorktrees(
      sql,
      nodeId,
      runningSessionIds,
    );
    const restoredRows = await sql<Array<ReconciledSessionRow>>`
      UPDATE sessions
      SET status = 'running', was_running_at_shutdown = FALSE,
          termination_reason = NULL, termination_detail = NULL,
          review_state = 'not_required',
          updated_at = ${updatedAt}
      WHERE node_id = ${nodeId}
        AND session_id = ANY(${sql.array(runningSessionIds)}::text[])
        AND status = 'interrupted'
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

/**
 * The interrupt UPDATE below joins the targets in no defined order, so it would take its
 * session row locks in whatever order the join yields. Taking the same rows first in
 * session_id order keeps this transaction from crossing another one that locks several
 * sessions in key order. Those rows are only ever updated here, never deleted, so the
 * lock does not need to block foreign key checks (FOR NO KEY UPDATE).
 */
async function lockInterruptTargetsInOrder(
  sql: import("postgres").TransactionSql<any>, nodeId: string, runningSessionIds: string[],
  targets: NodeStartupTarget[],
) {
  if (targets.length === 0) return;
  await sql`
    SELECT session_id FROM sessions
    WHERE node_id = ${nodeId}
      AND session_id = ANY(${sql.array(targets.map((target) => target.sessionId))}::text[])
      AND NOT (session_id = ANY(${sql.array(runningSessionIds)}::text[]))
    ORDER BY session_id
    FOR NO KEY UPDATE
  `;
}

async function lockRestorableSessionsThenWorktrees(
  sql: import("postgres").TransactionSql<any>, nodeId: string, runningSessionIds: string[],
) {
  await sql`
    SELECT session_id FROM sessions
    WHERE node_id = ${nodeId}
      AND session_id = ANY(${sql.array(runningSessionIds)}::text[])
    ORDER BY session_id
    FOR UPDATE
  `;
  await sql`
    SELECT id FROM worktrees
    WHERE id IN (
      SELECT worktree_id FROM sessions
      WHERE node_id = ${nodeId}
        AND session_id = ANY(${sql.array(runningSessionIds)}::text[])
        AND worktree_id IS NOT NULL
    )
    ORDER BY id
    FOR UPDATE
  `;
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

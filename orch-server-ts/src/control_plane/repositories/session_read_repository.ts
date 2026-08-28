import type { SqlClient } from "../control_plane_types.js";

export interface HostSessionRow extends Record<string, unknown> {
  session_id: string;
  folder_id: string | null;
  predecessor_session_id: string | null;
}

export interface HostSessionSummaryRow extends Record<string, unknown> {
  session_id: string;
  display_name: string | null;
  updated_at: Date;
}

export interface HostOwnerNullRunningSessionRow extends Record<string, unknown> {
  session_id: string;
  node_id: string | null;
  updated_at: Date;
  reconciliation_kind: "owner_null_running" | "terminal_active_ownership";
  status: string;
  termination_reason: string | null;
  manifest_id: string | null;
  registration_id: string | null;
  pid: number | null;
  start_identity: string | null;
  execution_command_id: string | null;
}

export class SessionReadRepository {
  constructor(private readonly sql: SqlClient) {}

  async getSession(sessionId: string): Promise<HostSessionRow | null> {
    const rows = await this.sql<HostSessionRow[]>`
      SELECT * FROM session_get(${sessionId})
    `;
    return rows[0] ?? null;
  }

  async listSessionsSummary(params: {
    search?: string | null;
    limit: number;
    offset: number;
    folderId?: string | null;
    nodeId?: string | null;
  }): Promise<{ sessions: HostSessionSummaryRow[]; total: number }> {
    const rows = await this.sql<Array<HostSessionSummaryRow & {
      event_count: string | number;
      last_event_id: string | number | null;
      last_read_event_id: string | number | null;
      total_count: string | number;
    }>>`
      WITH paged AS (
        SELECT
          s.session_id,
          s.display_name,
          s.status,
          s.session_type,
          s.created_at,
          s.updated_at,
          s.away_summary,
          s.caller_session_id,
          s.last_event_id,
          s.last_read_event_id,
          s.node_id,
          s.model_preset,
          s.model,
          s.predecessor_session_id,
          COUNT(*) OVER()::BIGINT AS total_count
        FROM sessions s
        WHERE (
          ${params.search ?? null}::text IS NULL
          OR s.display_name ILIKE '%' || ${params.search ?? null} || '%'
        )
          AND (
            ${params.folderId ?? null}::text IS NULL
            OR s.folder_id = ${params.folderId ?? null}
          )
          AND (
            ${params.nodeId ?? null}::text IS NULL
            OR s.node_id = ${params.nodeId ?? null}
          )
        ORDER BY s.updated_at DESC, s.session_id DESC
        LIMIT ${params.limit} OFFSET ${params.offset}
      )
      SELECT
        paged.*,
        (
          SELECT COUNT(*)::BIGINT
          FROM events
          WHERE events.session_id = paged.session_id
        ) AS event_count
      FROM paged
      ORDER BY paged.updated_at DESC, paged.session_id DESC
    `;
    return {
      sessions: rows.map(({ total_count: _totalCount, ...row }) => ({
        ...row,
        event_count: Number(row.event_count),
        last_event_id: row.last_event_id == null ? null : Number(row.last_event_id),
        last_read_event_id:
          row.last_read_event_id == null ? null : Number(row.last_read_event_id),
      })),
      total: rows[0] ? Number(rows[0].total_count) : 0,
    };
  }

  async listSessionsForUpstreamDump(params: {
    limit: number;
    offset: number;
    nodeId: string;
  }): Promise<{ sessions: Array<Record<string, unknown>>; total: number }> {
    const rows = await this.sql<Array<Record<string, unknown> & { session_id: string }>>`
      SELECT
        s.session_id,
        s.display_name,
        s.status,
        s.session_type,
        s.created_at,
        s.updated_at,
        (SELECT COUNT(*)::int FROM events e WHERE e.session_id = s.session_id) AS event_count,
        s.away_summary,
        s.caller_session_id,
        s.predecessor_session_id,
        s.last_event_id,
        s.last_read_event_id,
        s.node_id,
        s.agent_id,
        s.model_preset,
        s.model,
        s.prompt,
        s.folder_id,
        s.metadata,
        s.last_message,
        s.client_id,
        s.review_required,
        s.review_state
      FROM sessions s
      WHERE s.node_id = ${params.nodeId}
      ORDER BY s.updated_at DESC, s.session_id DESC
      LIMIT ${params.limit} OFFSET ${params.offset}
    `;
    const counts = await this.sql<Array<{ count: string | number }>>`
      SELECT COUNT(*) AS count
      FROM sessions
      WHERE node_id = ${params.nodeId}
    `;
    return {
      sessions: rows.map((row) => ({ ...row, binding_warnings: [] })),
      total: Number(counts[0]?.count ?? 0),
    };
  }

  async listRunningSessionsSummary(params: {
    limit: number;
    excludeSessionId?: string | null;
  }): Promise<{ sessions: Array<Record<string, unknown>>; total: number }> {
    const rows = await this.sql<Array<Record<string, unknown> & {
      session_id: string;
      updated_at: Date;
      total_count: string | number;
    }>>`
      WITH filtered AS (
        SELECT
          s.session_id,
          s.display_name,
          s.node_id,
          s.folder_id,
          f.name AS folder_name,
          s.updated_at
        FROM sessions s
        LEFT JOIN folders f ON f.id = s.folder_id
        WHERE s.status = 'running'
          AND (
            ${params.excludeSessionId ?? null}::text IS NULL
            OR s.session_id <> ${params.excludeSessionId ?? null}
          )
      )
      SELECT f.*, (SELECT COUNT(*) FROM filtered)::BIGINT AS total_count
      FROM filtered f
      ORDER BY f.updated_at DESC, f.session_id DESC
      LIMIT ${params.limit}
    `;
    return {
      sessions: rows.map(({ total_count: _totalCount, ...row }) => row),
      total: rows[0] ? Number(rows[0].total_count) : 0,
    };
  }

  async listOwnerNullRunningInventory(params: {
    nodeId: string;
    limit: number;
  }): Promise<HostOwnerNullRunningSessionRow[]> {
    return await this.sql<HostOwnerNullRunningSessionRow[]>`
      WITH restart_reconciliation_inventory AS (
        SELECT inventory.session_id,
               inventory.node_id,
               inventory.updated_at,
               'owner_null_running'::TEXT AS reconciliation_kind,
               session.status,
               session.termination_reason,
               NULL::TEXT AS manifest_id,
               NULL::TEXT AS registration_id,
               NULL::INTEGER AS pid,
               NULL::TEXT AS start_identity,
               NULL::TEXT AS execution_command_id
        FROM session_owner_null_running_inventory AS inventory
        JOIN sessions AS session ON session.session_id = inventory.session_id
        WHERE inventory.node_id = ${params.nodeId}
          AND session.execution_manifest_id IS NULL

        UNION ALL

        SELECT session.session_id,
               session.node_id,
               GREATEST(session.updated_at, ownership.activated_at) AS updated_at,
               'terminal_active_ownership'::TEXT AS reconciliation_kind,
               session.status,
               session.termination_reason,
               ownership.manifest_id,
               ownership.registration_id,
               ownership.pid,
               ownership.start_identity,
               ownership.execution_command_id
        FROM sessions AS session
        JOIN session_execution_ownerships AS ownership
          ON ownership.session_id = session.session_id
         AND ownership.phase = 'active'
        WHERE session.node_id = ${params.nodeId}
          AND session.status IN ('completed', 'error', 'interrupted')
      )
      SELECT *
      FROM restart_reconciliation_inventory
      ORDER BY updated_at, session_id
      LIMIT ${params.limit}
    `;
  }
}

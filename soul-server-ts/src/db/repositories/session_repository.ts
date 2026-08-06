import type {
  ListSessionSummaryRow,
  RunningSessionSummaryRow,
  SessionRow,
  SqlClient,
  UpstreamSessionDumpRow,
} from "../session_db_types.js";

export class SessionRepository {
  constructor(private readonly sql: SqlClient) {}

  async ensureStableSessionOrderIndex(): Promise<void> {
    const existing = await this.sql<Array<{ indisvalid: boolean; indisready: boolean }>>`
      SELECT i.indisvalid, i.indisready
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.oid = to_regclass('idx_sessions_updated_at_session_id')
    `;
    const state = existing[0];
    if (state && (!state.indisvalid || !state.indisready)) {
      await this.sql`
        DROP INDEX CONCURRENTLY idx_sessions_updated_at_session_id
      `;
    }

    await this.sql`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_updated_at_session_id
      ON sessions (updated_at DESC, session_id DESC)
    `;
  }

  async getSession(sessionId: string): Promise<SessionRow | null> {
    const rows = await this.sql<SessionRow[]>`
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
  }): Promise<{
    sessions: ListSessionSummaryRow[];
    total: number;
  }> {
    const rows = await this.sql<
      Array<{
        session_id: string;
        display_name: string | null;
        status: string | null;
        session_type: string | null;
        created_at: Date;
        updated_at: Date;
        event_count: string | number;
        away_summary: string | null;
        caller_session_id: string | null;
        predecessor_session_id: string | null;
        last_event_id: string | number | null;
        last_read_event_id: string | number | null;
        node_id: string | null;
        model_preset: string | null;
        model: string | null;
        total_count: string | number;
      }>
    >`
      SELECT summary.*, sessions.predecessor_session_id
      FROM session_list_summary(
        ${params.search ?? null},
        ${null},
        ${params.limit},
        ${params.offset},
        ${params.folderId ?? null},
        ${params.nodeId ?? null}
      ) AS summary
      JOIN sessions ON sessions.session_id = summary.session_id
      ORDER BY summary.updated_at DESC, summary.session_id DESC
    `;
    const total = rows.length > 0 && rows[0] ? Number(rows[0].total_count) : 0;
    const sessions = rows.map((r) => ({
      session_id: r.session_id,
      display_name: r.display_name,
      status: r.status,
      session_type: r.session_type,
      created_at: r.created_at,
      updated_at: r.updated_at,
      event_count: Number(r.event_count),
      away_summary: r.away_summary,
      caller_session_id: r.caller_session_id,
      predecessor_session_id: r.predecessor_session_id,
      last_event_id: r.last_event_id == null ? null : Number(r.last_event_id),
      last_read_event_id:
        r.last_read_event_id == null ? null : Number(r.last_read_event_id),
      node_id: r.node_id,
      model_preset: r.model_preset,
      model: r.model,
    }));
    return { sessions, total };
  }

  async listSessionsForUpstreamDump(params: {
    limit: number;
    offset: number;
    nodeId: string;
  }): Promise<{ sessions: UpstreamSessionDumpRow[]; total: number }> {
    // Reconnect inventory needs the Python session wire inputs, not the smaller
    // dashboard summary and not private session columns such as claude_session_id.
    const rows = await this.sql<UpstreamSessionDumpRow[]>`
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
    const sessions = rows.map((row) => ({ ...row, binding_warnings: [] }));
    const counts = await this.sql<Array<{ count: string | number }>>`
      SELECT COUNT(*) AS count
      FROM sessions
      WHERE node_id = ${params.nodeId}
    `;
    return { sessions, total: Number(counts[0]?.count ?? 0) };
  }

  async listRunningSessionsSummary(params: {
    limit: number;
    excludeSessionId?: string | null;
  }): Promise<{
    sessions: RunningSessionSummaryRow[];
    total: number;
  }> {
    const rows = await this.sql<
      Array<{
        session_id: string;
        display_name: string | null;
        node_id: string | null;
        folder_id: string | null;
        folder_name: string | null;
        updated_at: Date;
        total_count: string | number;
      }>
    >`
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
    const total = rows.length > 0 && rows[0] ? Number(rows[0].total_count) : 0;
    return {
      sessions: rows.map((r) => ({
        session_id: r.session_id,
        display_name: r.display_name,
        node_id: r.node_id,
        folder_id: r.folder_id,
        folder_name: r.folder_name,
        updated_at: r.updated_at,
      })),
      total,
    };
  }
}

import type {
  LastMessageRow,
  ListSessionSummaryRow,
  RegisterSessionParams,
  RunningSessionSummaryRow,
  SessionRow,
  SessionUpdateFields,
  SqlClient,
  UpstreamSessionDumpRow,
  AcknowledgeReviewOutcome,
} from "../session_db_types.js";

/**
 * `session_update` stored procedure 화이트리스트 (schema.sql L257-262).
 *
 * 위반 키 포함 시 stored proc이 RAISE EXCEPTION — TS는 진입 가드로 같은 검증을
 * 미리 수행하여 runtime 폭발을 명시 throw로 격상.
 */
const SESSION_UPDATE_ALLOWED = new Set([
  "folder_id",
  "display_name",
  "status",
  "prompt",
  "client_id",
  "last_message",
  "metadata",
  "was_running_at_shutdown",
  "last_event_id",
  "last_read_event_id",
  "termination_reason",
  "termination_detail",
  "review_state",
]);

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

  /** Python `session_register` stored procedure 호출 (schema.sql L196-218). */
  async registerSession(params: RegisterSessionParams): Promise<void> {
    await this.sql`
      SELECT session_register_with_review(
        ${params.sessionId},
        ${params.nodeId},
        ${params.agentId},
        ${params.claudeSessionId},
        ${params.sessionType},
        ${params.prompt},
        ${params.clientId},
        ${params.status},
        ${params.createdAt},
        ${params.updatedAt},
        ${params.callerSessionId},
        ${params.notifyCompletion ?? true},
        ${params.reviewRequired ?? false},
        ${params.reviewState ?? "not_required"}
      )
    `;
  }

  async acknowledgeSessionReview(
    sessionId: string,
  ): Promise<AcknowledgeReviewOutcome> {
    const rows = await this.sql<Array<{ outcome: AcknowledgeReviewOutcome }>>`
      SELECT session_acknowledge_review(${sessionId}, ${new Date()}) AS outcome
    `;
    return rows[0]?.outcome ?? "not_found";
  }

  async updateSession(
    sessionId: string,
    fields: SessionUpdateFields,
  ): Promise<void> {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;

    const columns: string[] = [];
    const values: (string | null)[] = [];

    for (const [col, val] of entries) {
      if (!SESSION_UPDATE_ALLOWED.has(col)) {
        throw new Error(
          `SessionDB.updateSession: column "${col}" not in session_update whitelist`,
        );
      }
      columns.push(col);
      values.push(stringifyForStoredProc(col, val));
    }

    await this.sql`
      SELECT session_update(
        ${sessionId},
        ${this.sql.array(columns)},
        ${this.sql.array(values)},
        ${new Date()}
      )
    `;
  }

  async interruptRunningSessionsForNode(nodeId: string): Promise<number> {
    const rows = await this.sql<Array<{ interrupted_count: string | number }>>`
      WITH updated AS (
        UPDATE sessions
        SET status = 'interrupted',
            was_running_at_shutdown = FALSE,
            termination_reason = 'unknown',
            review_state = CASE
              WHEN review_required THEN 'needs_review'
              ELSE 'not_required'
            END,
            updated_at = NOW()
        WHERE node_id = ${nodeId}
          AND status = 'running'
        RETURNING 1
      )
      SELECT COUNT(*) AS interrupted_count FROM updated
    `;
    return Number(rows[0]?.interrupted_count ?? 0);
  }

  async setClaudeSessionId(
    sessionId: string,
    claudeSessionId: string,
  ): Promise<void> {
    await this.sql`
      SELECT session_set_claude_id(${sessionId}, ${claudeSessionId})
    `;
  }

  async updateLastMessage(
    sessionId: string,
    lastMessage: LastMessageRow,
  ): Promise<void> {
    await this.sql`
      SELECT session_update_last_message(
        ${sessionId},
        ${JSON.stringify(lastMessage)},
        ${new Date()}
      )
    `;
  }

  async getSession(sessionId: string): Promise<SessionRow | null> {
    const rows = await this.sql<SessionRow[]>`
      SELECT * FROM session_get(${sessionId})
    `;
    return rows[0] ?? null;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.sql`SELECT session_delete(${sessionId})`;
  }

  async appendMetadata(
    sessionId: string,
    entry: Record<string, unknown>,
  ): Promise<number> {
    const now = new Date();
    const entryJson = JSON.stringify([entry]);
    const searchable = `${String(entry.type ?? "")}: ${String(entry.value ?? "")} ${String(entry.label ?? "")}`;
    const eventPayload = JSON.stringify({
      type: "metadata",
      metadata_type: entry.type,
      value: entry.value,
      label: entry.label,
    });
    const rows = await this.sql<{ session_append_metadata: number }[]>`
      SELECT session_append_metadata(
        ${sessionId},
        ${entryJson},
        ${"metadata"},
        ${eventPayload},
        ${searchable},
        ${now}
      )
    `;
    return rows[0]?.session_append_metadata ?? 0;
  }

  async renameSession(
    sessionId: string,
    displayName: string | null,
  ): Promise<void> {
    await this.sql`SELECT session_rename(${sessionId}, ${displayName})`;
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
        last_event_id: string | number | null;
        last_read_event_id: string | number | null;
        node_id: string | null;
        total_count: string | number;
      }>
    >`
      SELECT * FROM session_list_summary(
        ${params.search ?? null},
        ${null},
        ${params.limit},
        ${params.offset},
        ${params.folderId ?? null},
        ${params.nodeId ?? null}
      )
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
      last_event_id: r.last_event_id == null ? null : Number(r.last_event_id),
      last_read_event_id:
        r.last_read_event_id == null ? null : Number(r.last_read_event_id),
      node_id: r.node_id,
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
    const sessions = await this.sql<UpstreamSessionDumpRow[]>`
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
        s.last_event_id,
        s.last_read_event_id,
        s.node_id,
        s.agent_id,
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

/**
 * stored proc은 모든 컬럼을 TEXT[]로 받음 — JSON·boolean·integer 변환 책임은 호출자.
 */
function stringifyForStoredProc(col: string, val: unknown): string | null {
  if (val === null) return null;
  if (col === "last_message" || col === "metadata") {
    return JSON.stringify(val);
  }
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);
  return String(val);
}

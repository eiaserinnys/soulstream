import { formatCardReference } from "@soulstream/mcp-contract";

import { readSessionReferences } from "../../cards/card_reference_repository.js";
import type { RepositorySql } from "../../cards/control_plane/card_types.js";
import type { SqlClient } from "../control_plane_types.js";
import type { SessionReadPeriod } from "@soulstream/mcp-contract";

type SessionSummaryQueryRow = HostSessionSummaryRow & {
  event_count: string | number;
  last_event_id: string | number | null;
  last_read_event_id: string | number | null;
  total_count: string | number;
};

export interface HostSessionRow extends Record<string, unknown> {
  session_id: string;
  folder_id: string | null;
  predecessor_session_id: string | null;
}

export interface HostSessionSummaryRow extends Record<string, unknown> {
  session_id: string;
  display_name: string | null;
  agent_id: string | null;
  updated_at: Date;
}

export interface HostPersistentSessionRow extends Record<string, unknown> {
  session_id: string;
  display_name: string | null;
  node_id: string | null;
  folder_id: string | null;
  agent_id: string | null;
  session_type: string | null;
  model_preset: string | null;
  model: string | null;
  reasoning_effort: string | null;
  metadata: unknown;
  created_at: Date;
}

export class SessionReadRepository {
  constructor(private readonly sql: SqlClient) {}

  async getSession(sessionId: string): Promise<HostSessionRow | null> {
    const rows = await this.sql<HostSessionRow[]>`
      SELECT * FROM session_get(${sessionId})
    `;
    return rows[0] ?? null;
  }

  /**
   * Every session whose `persistent_session` marker is on, oldest first. Filtered in
   * SQL so a long tail of ordinary sessions can never push a persistent one out.
   */
  async listPersistentSessions(): Promise<HostPersistentSessionRow[]> {
    return await this.sql<HostPersistentSessionRow[]>`
      SELECT
        s.session_id,
        s.display_name,
        s.node_id,
        s.folder_id,
        s.agent_id,
        s.session_type,
        s.model_preset,
        s.model,
        s.reasoning_effort,
        s.metadata,
        s.created_at
      FROM sessions s
      WHERE s.metadata @> '[{"type":"persistent_session","value":{"enabled":true}}]'::jsonb
      ORDER BY s.created_at ASC, s.session_id ASC
    `;
  }

  async listSessionsSummary(params: {
    search?: string | null;
    limit: number;
    offset: number;
    folderId?: string | null;
    nodeId?: string | null;
    period?: SessionReadPeriod;
  }): Promise<{ sessions: HostSessionSummaryRow[]; total: number }> {
    let rows: SessionSummaryQueryRow[];
    if (params.period) {
      rows = await this.sql<SessionSummaryQueryRow[]>`
        WITH paged AS (
          SELECT
            s.session_id,
            s.card_id,
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
            s.agent_id,
            s.model_preset,
            s.model,
            NULLIF(s.reasoning_effort, 'auto') AS reasoning_effort,
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
            AND EXISTS (
              SELECT 1 FROM events e
              WHERE e.session_id = s.session_id
                AND e.created_at >= ${params.period.since}::timestamptz
                AND e.created_at < ${params.period.until}::timestamptz
            )
          ORDER BY s.session_id ASC
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
        ORDER BY paged.session_id ASC
      `;
    } else {
      rows = await this.sql<SessionSummaryQueryRow[]>`
      WITH paged AS (
        SELECT
          s.session_id,
          s.card_id,
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
          s.agent_id,
          s.model_preset,
          s.model,
          -- "auto" is a DB-internal marker meaning "resolved to no effort"
          -- (see soul-server-ts/src/task/session_effort_storage.ts). Public
          -- projections report it the way an unspecified effort always was.
          -- getSession() deliberately keeps the raw value: node hydration must
          -- tell a pre-089 NULL apart from a recorded "auto".
          NULLIF(s.reasoning_effort, 'auto') AS reasoning_effort,
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
    }
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
        NULLIF(s.reasoning_effort, 'auto') AS reasoning_effort,
        s.prompt,
        s.folder_id,
        s.card_id,
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
          s.card_id,
          s.display_name,
          s.node_id,
          s.folder_id,
        s.card_id,
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

  async listActiveChildSessionsSummary(callerSessionId: string): Promise<{
    sessions: Array<{
      session_id: string;
      display_name: string | null;
      agent_id: string | null;
      model_preset: string | null;
      status: "initializing" | "running";
      card_id: string | null;
      /** `#412.s2` when the session is on a card that has a number, otherwise null. */
      reference: string | null;
      created_at: Date;
    }>;
    total: number;
  }> {
    const rows = await this.sql<Array<{
      session_id: string;
      display_name: string | null;
      agent_id: string | null;
      model_preset: string | null;
      status: "initializing" | "running";
      card_id: string | null;
      created_at: Date;
      total_count: string | number;
    }>>`
      WITH active_children AS (
        SELECT
          s.session_id,
          s.display_name,
          s.agent_id,
          s.model_preset,
          s.status,
          s.card_id,
          s.created_at
        FROM sessions s
        WHERE s.caller_session_id = ${callerSessionId}
          AND s.status IN ('initializing', 'running')
      )
      SELECT active_children.*, COUNT(*) OVER ()::integer AS total_count
      FROM active_children
      ORDER BY created_at DESC, session_id COLLATE "C"
    `;
    // persistence_host_runtime.ts passes the board-yjs query adapter typed as the driver's client; this is that adapter.
    const references = await readSessionReferences(
      this.sql as unknown as RepositorySql,
      rows.map((row) => row.session_id),
    );
    return {
      sessions: rows.map(({ total_count: _totalCount, ...session }) => {
        const reference = references.get(session.session_id);
        return {
          ...session,
          reference: reference
            ? formatCardReference(reference.cardNumber, { kind: "session", ordinal: reference.ordinal })
            : null,
        };
      }),
      total: Number(rows[0]?.total_count ?? 0),
    };
  }

}

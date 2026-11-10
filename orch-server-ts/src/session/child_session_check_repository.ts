import type { SqlClient } from "../control_plane/control_plane_types.js";

/**
 * 무응답 감시 대상과 마지막 유효 응답. 세션마다 유효 응답 이벤트 중 최신 한 건만 LATERAL로 붙인다.
 * 대상은 진행 중이고 담당(호출) 세션이 자기 자신이 아니며 완료 알림이 켜진 세션 전부다.
 */
export const CHILD_SESSION_CHECK_TARGETS_SQL = `
  SELECT
    s.session_id,
    s.caller_session_id,
    s.display_name,
    s.agent_id,
    s.model_preset,
    s.node_id,
    date_part('epoch', s.created_at) * 1000 AS session_created_at_ms,
    latest.id AS last_valid_event_id,
    latest.event_type AS last_valid_event_type,
    date_part('epoch', latest.created_at) * 1000 AS last_valid_event_at_ms
  FROM sessions s
  LEFT JOIN LATERAL (
    SELECT e.id, e.event_type, e.created_at
    FROM events e
    WHERE e.session_id = s.session_id
      AND (
        e.event_type IN (
          'user_message', 'intervention_sent', 'assistant_message', 'thinking',
          'tool_start', 'tool_result', 'result', 'complete', 'session_ended',
          'error', 'assistant_error'
        )
        OR (
          e.event_type = 'progress'
          AND jsonb_typeof(e.payload -> 'foreground_tool_use_id') = 'string'
          AND COALESCE(e.payload ->> 'foreground_tool_use_id', '') <> ''
        )
      )
    ORDER BY e.id DESC
    LIMIT 1
  ) latest ON TRUE
  WHERE s.status = 'running'
    AND s.caller_session_id IS NOT NULL
    AND s.caller_session_id <> s.session_id
    AND s.notify_completion = TRUE
`;

export type ChildSessionCheckTarget = {
  readonly childSessionId: string;
  readonly callerSessionId: string;
  readonly displayName: string | null;
  readonly agentId: string | null;
  readonly modelPreset: string | null;
  readonly nodeId: string | null;
  readonly sessionCreatedAtMs: number;
  readonly lastValidEventId: number | null;
  readonly lastValidEventType: string | null;
  readonly lastValidEventAtMs: number | null;
};

export type ChildSessionCheckEvent = {
  readonly id: number;
  readonly eventType: string;
  readonly createdAtMs: number;
  readonly payload: Record<string, unknown> | null;
};

export type ChildSessionCheckToolStart = {
  readonly id: number;
  readonly toolUseId: string | null;
  readonly toolName: string | null;
  readonly command: string | null;
  readonly startedAtMs: number;
  readonly answered: boolean;
};

export type ChildSessionCheckExistingDelivery = {
  readonly deliveryId: string;
  readonly createdAtMs: number;
};

/** 검사에 필요한 읽기와 중복 판정. 단위 시험이 SQL 없이 대체할 수 있게 좁게 둔다. */
export type ChildSessionCheckStore = {
  listTargets(): Promise<readonly ChildSessionCheckTarget[]>;
  latestEvent(sessionId: string): Promise<ChildSessionCheckEvent | null>;
  openToolStarts(sessionId: string): Promise<readonly ChildSessionCheckToolStart[]>;
  lastError(sessionId: string): Promise<ChildSessionCheckEvent | null>;
  findCheckDeliveries(input: {
    childSessionId: string;
    callerSessionId: string;
  }): Promise<readonly ChildSessionCheckExistingDelivery[]>;
  deliveryExists(deliveryId: string): Promise<boolean>;
};

type TargetRow = {
  session_id: string;
  caller_session_id: string;
  display_name: string | null;
  agent_id: string | null;
  model_preset: string | null;
  node_id: string | null;
  session_created_at_ms: number;
  last_valid_event_id: number | null;
  last_valid_event_type: string | null;
  last_valid_event_at_ms: number | null;
};

type EventRow = {
  id: number;
  event_type: string;
  payload: unknown;
  created_at_ms: number;
};

type ToolStartRow = {
  id: number;
  tool_use_id: string | null;
  tool_name: string | null;
  command: string | null;
  started_at_ms: number;
  answered: boolean;
};

type DeliveryRow = {
  delivery_id: string;
  created_at_ms: number;
};

export class ChildSessionCheckRepository implements ChildSessionCheckStore {
  constructor(private readonly resolveSql: () => Promise<SqlClient>) {}

  async listTargets(): Promise<readonly ChildSessionCheckTarget[]> {
    const sql = await this.resolveSql();
    const rows = await sql.unsafe<TargetRow[]>(CHILD_SESSION_CHECK_TARGETS_SQL);
    return rows.map((row) => ({
      childSessionId: row.session_id,
      callerSessionId: row.caller_session_id,
      displayName: row.display_name,
      agentId: row.agent_id,
      modelPreset: row.model_preset,
      nodeId: row.node_id,
      sessionCreatedAtMs: row.session_created_at_ms,
      lastValidEventId: row.last_valid_event_id,
      lastValidEventType: row.last_valid_event_type,
      lastValidEventAtMs: row.last_valid_event_at_ms,
    }));
  }

  async latestEvent(sessionId: string): Promise<ChildSessionCheckEvent | null> {
    const sql = await this.resolveSql();
    const rows = await sql<EventRow[]>`
      SELECT id, event_type, payload, date_part('epoch', created_at) * 1000 AS created_at_ms
      FROM events
      WHERE session_id = ${sessionId}
      ORDER BY id DESC
      LIMIT 1
    `;
    return toEvent(rows[0]);
  }

  async openToolStarts(sessionId: string): Promise<readonly ChildSessionCheckToolStart[]> {
    const sql = await this.resolveSql();
    const rows = await sql<ToolStartRow[]>`
      WITH boundary AS (
        SELECT COALESCE(MAX(id), 0) AS id
        FROM events
        WHERE session_id = ${sessionId} AND event_type = 'session_ended'
      )
      SELECT
        e.id,
        e.payload ->> 'tool_use_id' AS tool_use_id,
        COALESCE(e.payload ->> 'tool_name', e.payload ->> 'name') AS tool_name,
        e.payload -> 'tool_input' ->> 'command' AS command,
        date_part('epoch', e.created_at) * 1000 AS started_at_ms,
        EXISTS (
          SELECT 1
          FROM events r
          WHERE r.session_id = e.session_id
            AND r.event_type = 'tool_result'
            AND r.id > e.id
            AND e.payload ->> 'tool_use_id' IS NOT NULL
            AND r.payload ->> 'tool_use_id' = e.payload ->> 'tool_use_id'
        ) AS answered
      FROM events e, boundary b
      WHERE e.session_id = ${sessionId}
        AND e.event_type = 'tool_start'
        AND e.id > b.id
      ORDER BY e.id DESC
      LIMIT 20
    `;
    return rows.map((row) => ({
      id: row.id,
      toolUseId: row.tool_use_id,
      toolName: row.tool_name,
      command: row.command,
      startedAtMs: row.started_at_ms,
      answered: row.answered === true,
    }));
  }

  async lastError(sessionId: string): Promise<ChildSessionCheckEvent | null> {
    const sql = await this.resolveSql();
    const rows = await sql<EventRow[]>`
      SELECT id, event_type, payload, date_part('epoch', created_at) * 1000 AS created_at_ms
      FROM events
      WHERE session_id = ${sessionId}
        AND (
          event_type IN ('error', 'assistant_error')
          OR (event_type = 'tool_result' AND payload -> 'is_error' = 'true'::jsonb)
        )
      ORDER BY id DESC
      LIMIT 1
    `;
    return toEvent(rows[0]);
  }

  async findCheckDeliveries(input: {
    childSessionId: string;
    callerSessionId: string;
  }): Promise<readonly ChildSessionCheckExistingDelivery[]> {
    const sql = await this.resolveSql();
    const prefix = `child-check:${input.childSessionId}:${input.callerSessionId}:`;
    const rows = await sql<DeliveryRow[]>`
      SELECT delivery_id, date_part('epoch', created_at) * 1000 AS created_at_ms
      FROM session_deliveries
      WHERE target_session_id = ${input.callerSessionId}
        AND source = 'child_session_check'
        AND starts_with(delivery_id, ${prefix})
    `;
    return rows.map((row) => ({
      deliveryId: row.delivery_id,
      createdAtMs: row.created_at_ms,
    }));
  }

  async deliveryExists(deliveryId: string): Promise<boolean> {
    const sql = await this.resolveSql();
    const rows = await sql`SELECT 1 FROM session_deliveries WHERE delivery_id = ${deliveryId} LIMIT 1`;
    return rows.length > 0;
  }
}

function toEvent(row: EventRow | undefined): ChildSessionCheckEvent | null {
  if (row === undefined) return null;
  const payload = typeof row.payload === "object" && row.payload !== null
    ? row.payload as Record<string, unknown>
    : null;
  return {
    id: row.id,
    eventType: row.event_type,
    createdAtMs: row.created_at_ms,
    payload,
  };
}

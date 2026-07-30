import type {
  LiveDbSqlResolver,
} from "../runtime/live_db_sql.js";

export interface SessionStoryDigest {
  readonly sessionId: string;
  readonly narrative: string;
  readonly highlight: string;
  readonly narrativeThroughEventId: number;
  readonly foldCount: number;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface UnfoldedTurnSummary {
  readonly eventId: number;
  readonly turnNumber: number;
  readonly content: string;
  readonly turnStartEventId: number | null;
  readonly finalResponseEventId: number | null;
  readonly createdAt: Date;
}

export interface StoreSessionStoryDigestInput {
  readonly sessionId: string;
  readonly narrative: string;
  readonly highlight: string;
  readonly narrativeThroughEventId: number;
  readonly expectedVersion: number;
}

export interface SessionStoryRepositoryPort {
  loadDigest(sessionId: string): Promise<SessionStoryDigest | null>;
  countUnfoldedSummaries(
    sessionId: string,
    afterEventId: number | null,
  ): Promise<number>;
  loadUnfoldedSummaries(
    sessionId: string,
    afterEventId: number | null,
    limit: number,
  ): Promise<UnfoldedTurnSummary[]>;
  storeDigest(input: StoreSessionStoryDigestInput): Promise<boolean>;
}

export class SessionStoryRepository implements SessionStoryRepositoryPort {
  constructor(private readonly sqlResolver: LiveDbSqlResolver) {}

  async loadDigest(sessionId: string): Promise<SessionStoryDigest | null> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql`
      SELECT
        session_id,
        narrative,
        highlight,
        narrative_through_event_id,
        fold_count,
        version,
        created_at,
        updated_at
      FROM session_digests
      WHERE session_id = ${sessionId}
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) return null;
    return normalizeDigest(row);
  }

  async countUnfoldedSummaries(
    sessionId: string,
    afterEventId: number | null,
  ): Promise<number> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql`
      SELECT COUNT(*)::integer AS count
      FROM events
      WHERE session_id = ${sessionId}
        AND event_type = 'turn_summary'
        AND id > ${afterEventId ?? 0}
    `;
    return numberValue(rows[0]?.count) ?? 0;
  }

  async loadUnfoldedSummaries(
    sessionId: string,
    afterEventId: number | null,
    limit: number,
  ): Promise<UnfoldedTurnSummary[]> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql`
      WITH ordered_summaries AS (
        SELECT
          id,
          payload,
          created_at,
          ROW_NUMBER() OVER (ORDER BY id ASC)::integer AS turn_number
        FROM events
        WHERE session_id = ${sessionId}
          AND event_type = 'turn_summary'
      )
      SELECT id, payload, created_at, turn_number
      FROM ordered_summaries
      WHERE id > ${afterEventId ?? 0}
      ORDER BY id ASC
      LIMIT ${limit}
    `;
    return rows
      .map(normalizeUnfoldedSummary)
      .filter((value): value is UnfoldedTurnSummary => value !== null);
  }

  async storeDigest(input: StoreSessionStoryDigestInput): Promise<boolean> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql`
      INSERT INTO session_digests (
        session_id,
        narrative,
        highlight,
        narrative_through_event_id,
        fold_count,
        version,
        created_at,
        updated_at
      )
      VALUES (
        ${input.sessionId},
        ${input.narrative},
        ${input.highlight},
        ${input.narrativeThroughEventId},
        1,
        1,
        NOW(),
        NOW()
      )
      ON CONFLICT (session_id) DO UPDATE
      SET
        narrative = EXCLUDED.narrative,
        highlight = EXCLUDED.highlight,
        narrative_through_event_id = EXCLUDED.narrative_through_event_id,
        fold_count = session_digests.fold_count + 1,
        version = session_digests.version + 1,
        updated_at = NOW()
      WHERE session_digests.version = ${input.expectedVersion}
      RETURNING version
    `;
    return rows.length === 1;
  }
}

function normalizeDigest(row: Record<string, unknown>): SessionStoryDigest {
  return {
    sessionId: String(row.session_id),
    narrative: String(row.narrative ?? ""),
    highlight: String(row.highlight ?? ""),
    narrativeThroughEventId:
      numberValue(row.narrative_through_event_id) ?? 0,
    foldCount: numberValue(row.fold_count) ?? 0,
    version: numberValue(row.version) ?? 0,
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
  };
}

function normalizeUnfoldedSummary(
  row: Record<string, unknown>,
): UnfoldedTurnSummary | null {
  const payload = recordValue(row.payload);
  const eventId = numberValue(row.id);
  const turnNumber = numberValue(row.turn_number);
  const content = stringValue(payload.content);
  if (eventId === null || turnNumber === null || content === null) return null;
  return {
    eventId,
    turnNumber,
    content,
    turnStartEventId: numberValue(payload.turn_start_event_id),
    finalResponseEventId: numberValue(payload.final_response_event_id),
    createdAt: dateValue(row.created_at),
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function numberValue(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

function dateValue(value: unknown): Date {
  if (value instanceof Date) return value;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid session story timestamp: ${String(value)}`);
  }
  return date;
}

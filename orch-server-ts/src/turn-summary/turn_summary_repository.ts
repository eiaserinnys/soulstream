import type {
  LiveDbSqlResolver,
  LivePostgresSql,
} from "../runtime/live_db_sql.js";

const TURN_EVENT_TYPES = [
  "user_message",
  "intervention_sent",
  "session_notification",
  "assistant_message",
  "error",
  "complete",
] as const;

const TURN_START_EVENT_TYPES = new Set<string>([
  "user_message",
  "intervention_sent",
  "session_notification",
]);

export interface TurnSummaryEventRow {
  readonly id: number;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface TurnSummaryTurn {
  readonly sessionId: string;
  readonly folderId: string | null;
  readonly metadata: unknown;
  readonly turnStartEventId: number;
  readonly finalResponseEventId: number;
  readonly userText: string;
  readonly assistantText: string;
}

export interface TurnSummaryAppendResult {
  readonly inserted: boolean;
  readonly eventId: number;
}

export interface TurnSummaryRepositoryPort {
  loadTurn(
    sessionId: string,
    completeEventId: number,
  ): Promise<TurnSummaryTurn | null>;
  hasSummary(
    sessionId: string,
    turnStartEventId: number,
    finalResponseEventId: number,
  ): Promise<boolean>;
  loadPreviousSummaries(sessionId: string, limit: number): Promise<string[]>;
  isSessionSummarizable(sessionId: string): Promise<boolean>;
  appendSummary(
    sessionId: string,
    payload: Record<string, unknown>,
    dedupeKey: string,
  ): Promise<TurnSummaryAppendResult>;
  loadGapEvents(
    sessionId: string,
    afterEventId: number,
    beforeEventId: number,
  ): Promise<Record<string, unknown>[]>;
}

export class TurnSummaryRepository implements TurnSummaryRepositoryPort {
  constructor(private readonly sqlResolver: LiveDbSqlResolver) {}

  async loadTurn(
    sessionId: string,
    completeEventId: number,
  ): Promise<TurnSummaryTurn | null> {
    const sql = await this.sqlResolver.resolveSql();
    const sessionRows = await sql`
      SELECT folder_id, metadata
      FROM sessions
      WHERE session_id = ${sessionId}
      LIMIT 1
    `;
    const session = sessionRows[0];
    if (session === undefined) return null;
    const eventRows = await sql`
      SELECT id, event_type, payload, created_at
      FROM events
      WHERE session_id = ${sessionId}
        AND id <= ${completeEventId}
        AND event_type = ANY(${TURN_EVENT_TYPES}::text[])
      ORDER BY id ASC
    `;
    const reconstructed = reconstructTurnFromEvents(
      eventRows.map(normalizeEventRow).filter(isDefined),
      completeEventId,
    );
    if (reconstructed === null) return null;
    return {
      sessionId,
      folderId: nullableString(session.folder_id),
      metadata: parseJsonValue(session.metadata),
      ...reconstructed,
    };
  }

  async hasSummary(
    sessionId: string,
    turnStartEventId: number,
    finalResponseEventId: number,
  ): Promise<boolean> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql`
      SELECT EXISTS (
        SELECT 1
        FROM events
        WHERE session_id = ${sessionId}
          AND dedupe_key = ${summaryDedupeKey(
            turnStartEventId,
            finalResponseEventId,
          )}
        LIMIT 1
      ) AS exists
    `;
    return rows[0]?.exists === true;
  }

  async loadPreviousSummaries(
    sessionId: string,
    limit: number,
  ): Promise<string[]> {
    if (limit === 0) return [];
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql`
      SELECT payload
      FROM events
      WHERE session_id = ${sessionId}
        AND event_type = 'turn_summary'
      ORDER BY id DESC
      LIMIT ${limit}
    `;
    return rows
      .map((row) => stringValue(recordValue(parseJsonValue(row.payload)).content))
      .filter((content): content is string => content !== null)
      .reverse();
  }

  async isSessionSummarizable(sessionId: string): Promise<boolean> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql`
      SELECT status, termination_reason
      FROM sessions
      WHERE session_id = ${sessionId}
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) return false;
    const status = stringValue(row.status)?.toLowerCase() ?? "";
    if (
      ["error", "interrupted", "failed", "stopped", "killed"].includes(status)
    ) {
      return false;
    }
    const terminationReason =
      stringValue(row.termination_reason)?.toLowerCase() ?? "";
    return !["killed", "limit_hit", "error_aborted"].includes(
      terminationReason,
    );
  }

  async appendSummary(
    sessionId: string,
    payload: Record<string, unknown>,
    dedupeKey: string,
  ): Promise<TurnSummaryAppendResult> {
    const sql = await this.sqlResolver.resolveSql();
    const existing = await findEventIdByDedupe(sql, sessionId, dedupeKey);
    if (existing !== null) return { inserted: false, eventId: existing };
    const rows = await sql`
      SELECT event_append(
        ${sessionId},
        'turn_summary',
        ${JSON.stringify(payload)},
        ${stringValue(payload.content) ?? ""},
        ${new Date()},
        ${dedupeKey}
      ) AS event_append
    `;
    const eventId = numberValue(rows[0]?.event_append);
    if (eventId === null) {
      throw new Error("event_append returned no event id for turn summary");
    }
    return { inserted: true, eventId };
  }

  async loadGapEvents(
    sessionId: string,
    afterEventId: number,
    beforeEventId: number,
  ): Promise<Record<string, unknown>[]> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql`
      SELECT id, event_type, payload
      FROM events
      WHERE session_id = ${sessionId}
        AND id > ${afterEventId}
        AND id < ${beforeEventId}
      ORDER BY id ASC
    `;
    return rows.map((row) => ({
      type: "event",
      agentSessionId: sessionId,
      event: {
        ...recordValue(parseJsonValue(row.payload)),
        type: String(row.event_type ?? ""),
        _event_id: numberValue(row.id) ?? 0,
      },
    }));
  }
}

export function reconstructTurnFromEvents(
  rows: readonly TurnSummaryEventRow[],
  completeEventId: number,
): Omit<TurnSummaryTurn, "sessionId" | "folderId" | "metadata"> | null {
  const complete = rows.find(
    (row) => row.id === completeEventId && row.eventType === "complete",
  );
  if (complete === undefined) return null;
  const previousCompleteEventId = rows.reduce(
    (latest, row) =>
      row.eventType === "complete" &&
        row.id < completeEventId &&
        row.id > latest
        ? row.id
        : latest,
    0,
  );
  const start = rows.reduce<TurnSummaryEventRow | undefined>(
    (latest, row) =>
      TURN_START_EVENT_TYPES.has(row.eventType) &&
        row.id > previousCompleteEventId &&
        row.id < completeEventId &&
        (latest === undefined || row.id > latest.id)
        ? row
        : latest,
    undefined,
  );
  if (start === undefined) return null;
  const interval = rows.filter(
    (row) => row.id >= start.id && row.id <= completeEventId,
  );
  if (
    interval.some(
      (row) => row.eventType === "error" && row.payload.fatal !== false,
    )
  ) {
    return null;
  }
  const assistants = interval.filter(
    (row) =>
      row.eventType === "assistant_message" &&
      stringValue(row.payload.content)?.trim(),
  );
  const finalResponse = assistants.at(-1);
  const userText = stringValue(start.payload.text)?.trim();
  const assistantText = stringValue(finalResponse?.payload.content)?.trim();
  if (!userText || !assistantText || finalResponse === undefined) return null;
  return {
    turnStartEventId: start.id,
    finalResponseEventId: finalResponse.id,
    userText,
    assistantText,
  };
}

export function summaryDedupeKey(
  turnStartEventId: number,
  finalResponseEventId: number,
): string {
  return `turn_summary:${turnStartEventId}:${finalResponseEventId}`;
}

async function findEventIdByDedupe(
  sql: LivePostgresSql,
  sessionId: string,
  dedupeKey: string,
): Promise<number | null> {
  const rows = await sql`
    SELECT id
    FROM events
    WHERE session_id = ${sessionId}
      AND dedupe_key = ${dedupeKey}
    LIMIT 1
  `;
  return numberValue(rows[0]?.id);
}

function normalizeEventRow(row: Record<string, unknown>): TurnSummaryEventRow | null {
  const id = numberValue(row.id);
  if (id === null) return null;
  return {
    id,
    eventType: String(row.event_type ?? ""),
    payload: recordValue(parseJsonValue(row.payload)),
    createdAt: dateValue(row.created_at),
  };
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function dateValue(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}

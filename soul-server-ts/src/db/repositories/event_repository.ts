import type { AppendEventParams, SqlClient } from "../session_db_types.js";

export class EventRepository {
  constructor(private readonly sql: SqlClient) {}

  async countEvents(sessionId: string): Promise<number> {
    const rows = await this.sql<Array<{ event_count: string | number }>>`
      SELECT event_count(${sessionId}) AS event_count
    `;
    return Number(rows[0]?.event_count ?? 0);
  }

  async readEvents(
    sessionId: string,
    afterId: number,
    limit: number,
    eventTypes?: string[],
  ): Promise<
    Array<{
      id: number;
      session_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      searchable_text: string;
      created_at: Date;
    }>
  > {
    const types = eventTypes && eventTypes.length > 0 ? eventTypes : null;
    const rows = await this.sql<
      Array<{
        id: number;
        session_id: string;
        event_type: string;
        payload: unknown;
        searchable_text: string;
        created_at: Date;
      }>
    >`
      SELECT * FROM event_read(
        ${sessionId},
        ${afterId},
        ${limit},
        ${types as unknown as string[] | null}
      )
    `;
    return rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      event_type: r.event_type,
      payload:
        r.payload && typeof r.payload === "object"
          ? (r.payload as Record<string, unknown>)
          : {},
      searchable_text: r.searchable_text,
      created_at: r.created_at,
    }));
  }

  async readOneEvent(
    sessionId: string,
    eventId: number,
  ): Promise<{
    id: number;
    session_id: string;
    event_type: string;
    parent_event_id: number | null;
    payload: Record<string, unknown>;
    searchable_text: string;
    created_at: Date;
  } | null> {
    const rows = await this.sql<
      Array<{
        id: number;
        session_id: string;
        event_type: string;
        parent_event_id: number | null;
        payload: unknown;
        searchable_text: string;
        created_at: Date;
      }>
    >`
      SELECT * FROM event_read_one(${sessionId}, ${eventId})
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      session_id: row.session_id,
      event_type: row.event_type,
      parent_event_id: row.parent_event_id,
      payload:
        row.payload && typeof row.payload === "object"
          ? (row.payload as Record<string, unknown>)
          : {},
      searchable_text: row.searchable_text,
      created_at: row.created_at,
    };
  }

  async streamEventsRaw(
    sessionId: string,
    afterId = 0,
  ): Promise<
    Array<{ id: number; event_type: string; payload_text: string }>
  > {
    const rows = await this.sql<
      Array<{ id: number; event_type: string; payload_text: string }>
    >`
      SELECT * FROM event_stream_raw(${sessionId}, ${afterId})
    `;
    return rows;
  }

  async searchEvents(
    query: string,
    sessionIds: string[] | null,
    limit: number,
    eventTypes?: string[] | null,
  ): Promise<
    Array<{
      id: number;
      session_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      searchable_text: string;
      created_at: Date;
      score: number;
    }>
  > {
    const ids = sessionIds && sessionIds.length > 0 ? sessionIds : null;
    const types = eventTypes && eventTypes.length > 0 ? eventTypes : null;
    const rows = await this.sql<
      Array<{
        id: number;
        session_id: string;
        event_type: string;
        payload: unknown;
        searchable_text: string;
        created_at: Date;
        score: number;
      }>
    >`
      SELECT * FROM event_search(
        ${query},
        ${ids as unknown as string[] | null},
        ${limit},
        ${types as unknown as string[] | null}
      )
    `;
    return rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      event_type: r.event_type,
      payload:
        r.payload && typeof r.payload === "object"
          ? (r.payload as Record<string, unknown>)
          : {},
      searchable_text: r.searchable_text,
      created_at: r.created_at,
      score: Number(r.score),
    }));
  }

  async searchEventsBySessionId(
    query: string,
    eventTypes: string[] | null,
    limit: number,
  ): Promise<
    Array<{
      id: number;
      session_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      searchable_text: string;
      created_at: Date;
      score: number;
    }>
  > {
    const types = eventTypes && eventTypes.length > 0 ? eventTypes : null;
    const rows = await this.sql<
      Array<{
        id: number;
        session_id: string;
        event_type: string;
        payload: unknown;
        searchable_text: string;
        created_at: Date;
        score: number;
      }>
    >`
      SELECT * FROM session_id_search(
        ${query},
        ${types as unknown as string[] | null},
        ${limit}
      )
    `;
    return rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      event_type: r.event_type,
      payload:
        r.payload && typeof r.payload === "object"
          ? (r.payload as Record<string, unknown>)
          : {},
      searchable_text: r.searchable_text,
      created_at: r.created_at,
      score: Number(r.score),
    }));
  }

  async appendEvent(params: AppendEventParams): Promise<number> {
    const rows = await this.sql<{ event_append: number }[]>`
      SELECT event_append(
        ${params.sessionId},
        ${params.eventType},
        ${params.payload},
        ${params.searchableText},
        ${params.createdAt}
      ) AS event_append
    `;
    const id = rows[0]?.event_append;
    if (typeof id !== "number") {
      throw new Error(
        `event_append returned non-number: ${JSON.stringify(rows[0])}`,
      );
    }
    return id;
  }
}

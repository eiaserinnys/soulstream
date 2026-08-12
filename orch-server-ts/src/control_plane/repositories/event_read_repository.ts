import type { SqlClient } from "../control_plane_types.js";

export interface HostEventRow {
  id: number;
  session_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  searchable_text: string;
  created_at: Date;
}

export interface HostEventSearchRow extends HostEventRow {
  score: number;
}

export class EventReadRepository {
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
  ): Promise<HostEventRow[]> {
    const types = eventTypes && eventTypes.length > 0 ? eventTypes : null;
    const rows = await this.sql<Array<Omit<HostEventRow, "payload"> & { payload: unknown }>>`
      SELECT * FROM event_read(
        ${sessionId},
        ${afterId},
        ${limit},
        ${types as unknown as string[] | null}
      )
    `;
    return rows.map(normalizeEvent);
  }

  async readRecentEvents(
    sessionId: string,
    limit: number,
    eventTypes?: string[],
  ): Promise<HostEventRow[]> {
    const types = eventTypes && eventTypes.length > 0 ? eventTypes : null;
    const rows = await this.sql<Array<Omit<HostEventRow, "payload"> & { payload: unknown }>>`
      SELECT id, session_id, event_type, payload, searchable_text, created_at
      FROM events
      WHERE session_id = ${sessionId}
        AND (
          ${types as unknown as string[] | null}::text[] IS NULL
          OR event_type = ANY(${types as unknown as string[] | null}::text[])
        )
      ORDER BY id DESC
      LIMIT ${limit}
    `;
    return rows.map(normalizeEvent).reverse();
  }

  async readOneEvent(
    sessionId: string,
    eventId: number,
  ): Promise<(HostEventRow & { parent_event_id: number | null }) | null> {
    const rows = await this.sql<Array<Omit<HostEventRow, "payload"> & {
      parent_event_id: number | null;
      payload: unknown;
    }>>`
      SELECT * FROM event_read_one(${sessionId}, ${eventId})
    `;
    const row = rows[0];
    return row ? { ...normalizeEvent(row), parent_event_id: row.parent_event_id } : null;
  }

  async streamEventsRaw(
    sessionId: string,
    afterId = 0,
  ): Promise<Array<{ id: number; event_type: string; payload_text: string }>> {
    return await this.sql<Array<{ id: number; event_type: string; payload_text: string }>>`
      SELECT * FROM event_stream_raw(${sessionId}, ${afterId})
    `;
  }

  async searchEvents(
    query: string,
    sessionIds: string[] | null,
    limit: number,
    eventTypes?: string[] | null,
  ): Promise<HostEventSearchRow[]> {
    const ids = sessionIds && sessionIds.length > 0 ? sessionIds : null;
    const types = eventTypes && eventTypes.length > 0 ? eventTypes : null;
    const rows = await this.sql<Array<Omit<HostEventSearchRow, "payload"> & { payload: unknown }>>`
      SELECT * FROM event_search(
        ${query},
        ${ids as unknown as string[] | null},
        ${limit},
        ${types as unknown as string[] | null}
      )
    `;
    return rows.map((row) => ({ ...normalizeEvent(row), score: Number(row.score) }));
  }

  async searchEventsBySessionId(
    query: string,
    eventTypes: string[] | null,
    limit: number,
  ): Promise<HostEventSearchRow[]> {
    const types = eventTypes && eventTypes.length > 0 ? eventTypes : null;
    const rows = await this.sql<Array<Omit<HostEventSearchRow, "payload"> & { payload: unknown }>>`
      SELECT * FROM session_id_search(
        ${query},
        ${types as unknown as string[] | null},
        ${limit}
      )
    `;
    return rows.map((row) => ({ ...normalizeEvent(row), score: Number(row.score) }));
  }
}

function normalizeEvent(
  row: Omit<HostEventRow, "payload"> & { payload: unknown },
): HostEventRow {
  return {
    id: Number(row.id),
    session_id: row.session_id,
    event_type: row.event_type,
    payload: row.payload && typeof row.payload === "object"
      ? row.payload as Record<string, unknown>
      : {},
    searchable_text: row.searchable_text,
    created_at: row.created_at,
  };
}

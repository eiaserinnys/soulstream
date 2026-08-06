import type { AppendEventParams, SqlClient } from "../session_db_types.js";
import type { RepositorySql } from "./repository_helpers.js";

export class EventRepository {
  constructor(private readonly sql: SqlClient) {}

  async appendEvent(params: AppendEventParams): Promise<number> {
    return await appendEventWithSql(this.sql, params);
  }

  async appendEventTx(
    sql: RepositorySql,
    params: AppendEventParams,
  ): Promise<number> {
    return await appendEventWithSql(sql, params);
  }
}

async function appendEventWithSql(
  sql: RepositorySql,
  params: AppendEventParams,
): Promise<number> {
  const rows = await sql<{ event_append: number }[]>`
    SELECT event_append(
      ${params.sessionId},
      ${params.eventType},
      ${params.payload},
      ${params.searchableText},
      ${params.createdAt},
      ${params.dedupeKey ?? null}
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

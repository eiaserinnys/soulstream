import type {
  AppendEventParams,
  SqlClient,
} from "../../src/db/session_db.js";

/** Test-fixture helper. Production event writes are orchestrator-hosted. */
export async function appendTestEvent(
  sql: SqlClient,
  params: AppendEventParams,
): Promise<number> {
  const rows = await sql<Array<{ event_append: string | number }>>`
    SELECT event_append(
      ${params.sessionId},
      ${params.eventType},
      ${params.payload},
      ${params.searchableText},
      ${params.createdAt},
      ${params.dedupeKey ?? null}
    ) AS event_append
  `;
  const eventId = Number(rows[0]?.event_append);
  if (!Number.isFinite(eventId)) {
    throw new Error(`event_append returned non-number: ${JSON.stringify(rows[0])}`);
  }
  return eventId;
}

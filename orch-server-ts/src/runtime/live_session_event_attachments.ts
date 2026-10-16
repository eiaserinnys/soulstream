import type { SessionEventAttachmentResponse } from "@soulstream/wire-schema/attachments";

import { createLiveAttachmentReadRepository } from "./live_attachment_read_repository.js";
import type { LiveDbSqlResolver } from "./live_db_sql.js";
import { projectSessionEventAttachments } from "../session/session_event_attachment_projection.js";

export async function readLiveSessionEventAttachments(
  sqlResolver: LiveDbSqlResolver,
  sessionId: string,
  eventId: number,
): Promise<SessionEventAttachmentResponse | null> {
  const sql = await sqlResolver.resolveSql();
  const rows = await sql<{
    readonly event_type: string;
    readonly payload: unknown;
    readonly session_node_id: string | null;
  }[]>`
    SELECT s.node_id AS session_node_id, e.event_type, e.payload
    FROM sessions s
    JOIN events e ON e.session_id = s.session_id
    WHERE s.session_id = ${sessionId} AND e.id = ${eventId}
    LIMIT 1
  `;
  const event = rows[0];
  if (event === undefined) return null;

  return await projectSessionEventAttachments({
    sessionId,
    eventId,
    eventType: event.event_type,
    payload: objectPayload(event.payload),
    nodeId: nonEmptyString(event.session_node_id),
  }, createLiveAttachmentReadRepository(sqlResolver));
}

function objectPayload(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function nonEmptyString(value: string | null): string | null {
  return value !== null && value.length > 0 ? value : null;
}

import type { SoulstreamSchedule, SqlClient } from "./schedule_types.js";

export type ResumeScheduleIdentity = Pick<
  SoulstreamSchedule,
  "scheduleId" | "sessionId" | "sourceTool" | "toolUseId"
>;

type LimitEvent = { event_type: string; payload: Record<string, unknown> };

interface HistoryRow extends Record<string, unknown> {
  original_previous: number;
  current_previous: number;
  id: number | null;
  event_type: string | null;
  payload: Record<string, unknown> | null;
}

export function latestValidResetAt(events: LimitEvent[]): string | null {
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    const payload = event.payload;
    const isRejectedCredential = event.event_type === "credential_alert" && payload.status === "rejected";
    const isRateLimitError = event.event_type === "error"
      && payload.error_code === "claude_rate_limit_stop_failure"
      && payload.fatal === true;
    if (!isRejectedCredential && !isRateLimitError) continue;
    if (typeof payload.resets_at !== "string") continue;
    const resetMs = Date.parse(payload.resets_at);
    if (!Number.isFinite(resetMs)) continue;
    latestMs = Math.max(latestMs, resetMs);
  }
  return Number.isFinite(latestMs) ? new Date(latestMs).toISOString() : null;
}

/** The orchestrator store owns the continuity policy for both routes and dispatch. */
export async function hasContinuousLimitWindow(
  sql: SqlClient,
  schedule: ResumeScheduleIdentity,
  expectedCurrentTerminalId: number,
): Promise<boolean> {
  const originalTerminalId = originalTerminalEventId(schedule);
  if (originalTerminalId === null || !Number.isSafeInteger(expectedCurrentTerminalId)
    || expectedCurrentTerminalId < originalTerminalId) return false;

  const rows = await sql<HistoryRow[]>`
    WITH candidate AS (
      SELECT session.session_id
      FROM soulstream_schedules schedule
      JOIN sessions session ON session.session_id = schedule.session_id
      WHERE schedule.schedule_id = ${schedule.scheduleId}
        AND schedule.session_id = ${schedule.sessionId}
        AND schedule.source_tool = 'ResumeAfterLimit'
        AND schedule.tool_use_id = ${schedule.toolUseId}
        AND schedule.status IN ('active', 'dispatching', 'firing', 'orphaned')
        AND NOT (session.card_id IS NOT NULL AND EXISTS (SELECT 1 FROM system_settings WHERE setting_key='card_orchestration' AND (value->>'enabled')::boolean))
        AND session.status = 'error'
        AND session.termination_reason = 'limit_hit'
        AND session.termination_event_id = ${expectedCurrentTerminalId}
    ), bounds AS (
      SELECT candidate.session_id,
        COALESCE((
          SELECT MAX(id) FROM events
          WHERE session_id = candidate.session_id
            AND event_type = 'session_ended' AND id < ${originalTerminalId}
        ), 0) AS original_previous,
        COALESCE((
          SELECT MAX(id) FROM events
          WHERE session_id = candidate.session_id
            AND event_type = 'session_ended' AND id < ${expectedCurrentTerminalId}
        ), 0) AS current_previous
      FROM candidate
    )
    SELECT bounds.original_previous, bounds.current_previous,
      event.id, event.event_type, event.payload
    FROM bounds
    LEFT JOIN events event ON event.session_id = bounds.session_id
      AND event.id > bounds.original_previous
      AND event.id <= ${expectedCurrentTerminalId}
      AND event.event_type IN ('session_ended', 'credential_alert', 'error')
    ORDER BY event.id
  `;
  const first = rows[0];
  if (!first) return false;

  const terminals = rows.filter((row) => row.event_type === "session_ended");
  if (terminals[0]?.id !== originalTerminalId
    || terminals.at(-1)?.id !== expectedCurrentTerminalId
    || terminals.some((row) => row.payload?.termination_reason !== "limit_hit")) return false;
  if (originalTerminalId === expectedCurrentTerminalId) return true;

  const resetEvents = (start: number, end: number): LimitEvent[] => rows
    .filter((row) => row.id !== null && row.id > start && row.id < end
      && (row.event_type === "credential_alert" || row.event_type === "error"))
    .map((row) => ({ event_type: row.event_type!, payload: row.payload ?? {} }));
  const originalReset = latestValidResetAt(resetEvents(first.original_previous, originalTerminalId));
  const currentReset = latestValidResetAt(resetEvents(first.current_previous, expectedCurrentTerminalId));
  return originalReset !== null && originalReset === currentReset;
}

function originalTerminalEventId(schedule: ResumeScheduleIdentity): number | null {
  if (schedule.sourceTool !== "ResumeAfterLimit") return null;
  const match = /^ResumeAfterLimit:(\d+)$/.exec(schedule.toolUseId ?? "");
  if (!match) return null;
  const eventId = Number(match[1]);
  if (!Number.isSafeInteger(eventId) || eventId <= 0) return null;
  const prefix = `resume-after-limit:${schedule.sessionId}:${eventId}:`;
  if (!schedule.scheduleId.startsWith(prefix)) return null;
  const generation = schedule.scheduleId.slice(prefix.length);
  const parsedGeneration = Number(generation);
  return Number.isSafeInteger(parsedGeneration) && parsedGeneration >= 0 ? eventId : null;
}

import { latestValidResetAt } from "../schedule/resume_after_limit_continuity.js";
import { isUsageLimitTermination } from "../session/session_limit_termination.js";
import type { RepositorySql } from "./control_plane/card_types.js";

/** A card assignee is only woken automatically when its quota resets inside this window. */
export const SHORT_LIMIT_WINDOW_MS = 5 * 60 * 60 * 1000;

export type LimitResumeOwner = {
    session_id: string;
    status: string | null;
    termination_reason: string | null;
    termination_event_id: number | null;
};

type LimitEventRow = {
    id: number;
    event_type: string;
    payload: Record<string, unknown> | null;
    created_at: Date;
};

/**
 * The instant the limited card assignee can be woken again, or null when the
 * termination is not a short quota stop. Read only when entering limit-blocked;
 * subsequent resume decisions use the persisted card reservation.
 */
export async function readLimitAutoResumeAt(
    sql: RepositorySql,
    owner: LimitResumeOwner,
): Promise<Date | null> {
    if (!isUsageLimitTermination(owner)) return null;
    const terminalEventId = Number(owner.termination_event_id);
    const rows = await sql<LimitEventRow[]>`
      WITH bounds AS (
        SELECT COALESCE((
          SELECT MAX(id) FROM events
          WHERE session_id = ${owner.session_id}
            AND event_type = 'session_ended' AND id < ${terminalEventId}
        ), 0) AS previous_terminal
      )
      SELECT event.id, event.event_type, event.payload, event.created_at
      FROM bounds
      JOIN events event ON event.session_id = ${owner.session_id}
        AND event.id > bounds.previous_terminal
        AND event.id <= ${terminalEventId}
        AND event.event_type IN ('session_ended', 'credential_alert', 'error')
      ORDER BY event.id
    `;
    const terminal = rows.find((row) => row.id === terminalEventId);
    if (!terminal) return null;
    const resetsAt = latestValidResetAt(rows.map((row) => ({
        event_type: row.event_type,
        payload: row.payload ?? {},
    })));
    if (resetsAt === null) return null;
    const resetMs = Date.parse(resetsAt);
    const endedMs = new Date(terminal.created_at).getTime();
    if (!Number.isFinite(resetMs) || !Number.isFinite(endedMs)) return null;
    if (resetMs <= endedMs) return null;
    if (resetMs - endedMs > SHORT_LIMIT_WINDOW_MS) return null;
    return new Date(resetMs);
}

const resumeClock = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
});

export function formatLimitResumeClock(date: Date): string {
    return resumeClock.format(date);
}

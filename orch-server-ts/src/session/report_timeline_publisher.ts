import {
  REPORT_TIMELINE_EVENT_TYPE,
  REPORT_TIMELINE_QUESTION_CLOSED_EVENT_TYPE,
  type ReportTimelineLine,
  type ReportTimelineQuestionClosed,
} from "@soulstream/wire-schema/persistent-report";
import type { LivePostgresSql } from "../runtime/live_db_sql.js";
import type { RuntimeSessionEventHub } from "../runtime/session_event_hub.js";
import { sessionEventEnvelopeFromRow } from "../turn-summary/turn_summary_repository.js";

/** report_timeline 이벤트는 줄 하나, report_timeline_question_closed 이벤트는 닫힘 목록을 싣는다. */
export type ReportTimelineAppendEvent =
  | ({ type: typeof REPORT_TIMELINE_EVENT_TYPE } & ReportTimelineLine)
  | { type: typeof REPORT_TIMELINE_QUESTION_CLOSED_EVENT_TYPE; closures: ReportTimelineQuestionClosed[] };

export type AppendReportTimeline = (
  sessionId: string,
  event: ReportTimelineAppendEvent,
) => Promise<void>;

export function createReportTimelineAppender(deps: {
  readonly resolveSql: () => Promise<LivePostgresSql>;
  readonly eventHub: Pick<RuntimeSessionEventHub, "publish">;
  readonly warn: (message: string) => void;
}): AppendReportTimeline {
  return async (sessionId, event) => {
    try {
      const sql = await deps.resolveSql();
      const sessions = await sql<{ node_id: string | null }[]>`
        SELECT node_id FROM sessions WHERE session_id = ${sessionId}
      `;
      const nodeId = sessions[0]?.node_id;
      if (typeof nodeId !== "string") {
        throw new Error("session node_id is missing");
      }

      const payload = event;
      const appended = await sql<{ event_id: number }[]>`
        SELECT event_append(
          ${sessionId},
          ${event.type},
          ${JSON.stringify(payload)},
          '',
          NOW(),
          NULL
        ) AS event_id
      `;
      const eventId = Number(appended[0]?.event_id);
      if (!Number.isInteger(eventId) || eventId < 1) {
        throw new Error("event_append returned no event id");
      }

      // Publish the database gap first so this event cannot advance the SSE cursor past it.
      // Only just-stored events can be overtaken. An older `complete` replayed here would clear
      // the hub's live text snapshot for a turn that is streaming now.
      const preceding = await sql<Record<string, unknown>[]>`
        SELECT id, event_type, payload
        FROM events
        WHERE session_id = ${sessionId} AND id < ${eventId}
          AND created_at >= NOW() - INTERVAL '5 seconds'
        ORDER BY id DESC
        LIMIT 20
      `;
      for (const row of [...preceding].reverse()) {
        deps.eventHub.publish({
          nodeId,
          data: sessionEventEnvelopeFromRow(sessionId, row),
        });
      }
      deps.eventHub.publish({
        nodeId,
        data: {
          type: "event",
          agentSessionId: sessionId,
          event: { ...payload, _event_id: eventId },
        },
      });
    } catch (error) {
      deps.warn(`report_timeline append or publish failed for ${sessionId}: ${String(error)}`);
    }
  };
}

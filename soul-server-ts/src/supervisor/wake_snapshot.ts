import type { Logger } from "pino";

import type { SessionDB } from "../db/session_db.js";

import {
  hasCriticalSupervisorSnapshotSignal,
  shouldDispatchSupervisorWakeCandidate,
  type SupervisorWakeSourceCandidate,
} from "./wake_source_filter.js";
import {
  type SupervisorWakeSessionSummary,
  wakeSessionSummaryFromRow,
} from "./wake_text.js";

export type SupervisorWakeCandidateFilter = (
  candidate: SupervisorWakeSourceCandidate,
) => boolean;

export async function buildSupervisorSnapshotSessionSummaries(
  supervisorId: string,
  db: Pick<SessionDB, "listSessionsSummary" | "getSession">,
  logger: Pick<Logger, "warn">,
  shouldDispatchCandidate: SupervisorWakeCandidateFilter =
    shouldDispatchSupervisorWakeCandidate,
): Promise<SupervisorWakeSessionSummary[]> {
  const summaries: SupervisorWakeSessionSummary[] = [];
  const pageSize = 100;
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;

  while (offset < total) {
    const page = await db.listSessionsSummary({
      limit: pageSize,
      offset,
    });
    total = page.total;
    if (page.sessions.length === 0) break;

    for (const session of page.sessions) {
      try {
        const row = await db.getSession(session.session_id);
        const summary: SupervisorWakeSessionSummary = {
          ...(row
            ? wakeSessionSummaryFromRow(session.session_id, row)
            : {
                sessionId: session.session_id,
                title: session.display_name,
                status: session.status,
                updatedAt: session.updated_at,
              }),
          eventCount: session.event_count,
        };
        if (!shouldDispatchCandidate({
          supervisorId,
          sourceAgentId: row?.agent_id ?? null,
          callerSource: summary.callerSource,
          critical: hasCriticalSupervisorSnapshotSignal(summary),
        })) {
          continue;
        }
        summaries.push(summary);
      } catch (err) {
        logger.warn(
          { err, sessionId: session.session_id },
          "Supervisor snapshot session summary lookup failed",
        );
        const summary: SupervisorWakeSessionSummary = {
          sessionId: session.session_id,
          title: session.display_name,
          status: session.status,
          updatedAt: session.updated_at,
          eventCount: session.event_count,
        };
        if (!shouldDispatchCandidate({
          supervisorId,
          sourceAgentId: null,
          callerSource: null,
          critical: hasCriticalSupervisorSnapshotSignal(summary),
        })) {
          continue;
        }
        summaries.push(summary);
      }
    }

    offset += page.sessions.length;
  }

  return summaries;
}

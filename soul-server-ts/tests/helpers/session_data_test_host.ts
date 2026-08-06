import { EventReadRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/event_read_repository.js";
import { SessionReadCompositeRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_read_composite.js";
import { SessionReadRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_read_repository.js";
import { SessionStoryReadRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_story_read_repository.js";
import type { SessionDataHost } from
  "../../src/control_plane/session_data_host_client.js";
import { SessionDB, type SqlClient } from "../../src/db/session_db.js";

/**
 * PostgreSQL integration tests keep the production ownership boundary: reads
 * run through the orchestrator repositories even when both packages share one
 * in-process test database.
 */
export function configureTestSessionDataHost(
  db: SessionDB,
  sql: SqlClient,
): void {
  const sessions = new SessionReadRepository(sql as never);
  const events = new EventReadRepository(sql as never);
  const stories = new SessionStoryReadRepository(sql as never);
  const composites = new SessionReadCompositeRepository(
    sessions,
    events,
    stories,
  );

  db.configureSessionDataHost({
    getSession: (sessionId) => sessions.getSession(sessionId),
    listSessionsSummary: (params) => sessions.listSessionsSummary(params),
    listRunningSessionsSummary: (params) =>
      sessions.listRunningSessionsSummary(params),
    listSessionsForUpstreamDump: (params) =>
      sessions.listSessionsForUpstreamDump(params),
    countEvents: (sessionId) => events.countEvents(sessionId),
    readEvents: (sessionId, afterId, limit, eventTypes) =>
      events.readEvents(sessionId, afterId, limit, eventTypes),
    readOneEvent: (sessionId, eventId) =>
      events.readOneEvent(sessionId, eventId),
    streamEventsRaw: (sessionId, afterId) =>
      events.streamEventsRaw(sessionId, afterId),
    searchEvents: (query, sessionIds, limit, eventTypes) =>
      events.searchEvents(query, sessionIds, limit, eventTypes),
    searchEventsBySessionId: (query, eventTypes, limit) =>
      events.searchEventsBySessionId(query, eventTypes, limit),
    getSessionSearchMetadata: async (sessionIds) =>
      new Map(await stories.getSessionSearchMetadata(sessionIds)),
    countTurnSummaries: (sessionId) =>
      stories.countTurnSummaries(sessionId),
    loadTurnSummaryRange: (sessionId, fromTurnNumber, toTurnNumber, limit) =>
      stories.loadTurnSummaryRange(
        sessionId,
        fromTurnNumber,
        toTurnNumber,
        limit,
      ),
    searchSessionDigests: (
      query,
      sessionIds,
      limit,
      includeHighlight,
      includeStory,
    ) => stories.searchSessionDigests(
      query,
      sessionIds,
      limit,
      includeHighlight,
      includeStory,
    ),
    getSessionStory: (sessionId) => stories.getSessionStory(sessionId),
    getTurnExcerpt: (sessionId, maxResponseChars) =>
      composites.getTurnExcerpt(sessionId, maxResponseChars),
    getResumeContext: (sessionId, limit) =>
      composites.getResumeContext(sessionId, limit),
  } as unknown as SessionDataHost);
}

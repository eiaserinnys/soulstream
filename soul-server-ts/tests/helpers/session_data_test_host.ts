import { EventReadRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/event_read_repository.js";
import { SessionReadCompositeRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_read_composite.js";
import { SessionReadRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_read_repository.js";
import { SessionStoryReadRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_story_read_repository.js";
import type { SessionDataHost, SessionHistorySearchParams } from
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
    getSession: (sessionId: Parameters<SessionDataHost["getSession"]>[0]) => sessions.getSession(sessionId),
    getSessionOwnerNode: (sessionId: Parameters<SessionDataHost["getSessionOwnerNode"]>[0]) => sessions.getSessionOwnerNode(sessionId),
    listSessionsSummary: (params: Parameters<SessionDataHost["listSessionsSummary"]>[0]) => sessions.listSessionsSummary(params),
    listRunningSessionsSummary: (params: Parameters<SessionDataHost["listRunningSessionsSummary"]>[0]) =>
      sessions.listRunningSessionsSummary(params),
    listSessionsForUpstreamDump: (params: Parameters<SessionDataHost["listSessionsForUpstreamDump"]>[0]) =>
      sessions.listSessionsForUpstreamDump(params),
    countEvents: (sessionId: Parameters<SessionDataHost["countEvents"]>[0]) => events.countEvents(sessionId),
    readEvents: (sessionId: Parameters<SessionDataHost["readEvents"]>[0], afterId: Parameters<SessionDataHost["readEvents"]>[1], limit: Parameters<SessionDataHost["readEvents"]>[2], eventTypes: Parameters<SessionDataHost["readEvents"]>[3], period: Parameters<SessionDataHost["readEvents"]>[4], metadataTypes: Parameters<SessionDataHost["readEvents"]>[5], order: Parameters<SessionDataHost["readEvents"]>[6]) =>
      events.readEvents(sessionId, afterId, limit, eventTypes, period, metadataTypes, order),
    readOneEvent: (sessionId: Parameters<SessionDataHost["readOneEvent"]>[0], eventId: Parameters<SessionDataHost["readOneEvent"]>[1]) =>
      events.readOneEvent(sessionId, eventId),
    streamEventsRaw: (sessionId: Parameters<SessionDataHost["streamEventsRaw"]>[0], afterId: Parameters<SessionDataHost["streamEventsRaw"]>[1]) =>
      events.streamEventsRaw(sessionId, afterId),
    searchEvents: (query: Parameters<SessionDataHost["searchEvents"]>[0], sessionIds: Parameters<SessionDataHost["searchEvents"]>[1], limit: Parameters<SessionDataHost["searchEvents"]>[2], eventTypes: Parameters<SessionDataHost["searchEvents"]>[3]) =>
      events.searchEvents(query, sessionIds, limit, eventTypes),
    searchEventsBySessionId: (query: Parameters<SessionDataHost["searchEventsBySessionId"]>[0], eventTypes: Parameters<SessionDataHost["searchEventsBySessionId"]>[1], limit: Parameters<SessionDataHost["searchEventsBySessionId"]>[2]) =>
      events.searchEventsBySessionId(query, eventTypes, limit),
    searchSessionHistory: async (params: SessionHistorySearchParams) => ({
      events: await events.searchEvents(
        params.query,
        params.sessionIds,
        params.limit,
        params.eventTypes,
      ),
      sessionIdEvents: params.searchSessionId
        ? await events.searchEventsBySessionId(
            params.query,
            params.eventTypes,
            params.limit,
          )
        : [],
      digests: params.includeHighlight || params.includeStory
        ? await stories.searchSessionDigests(
            params.query,
            params.sessionIds,
            params.limit,
            params.includeHighlight,
            params.includeStory,
          )
        : [],
    }),
    getSessionSearchMetadata: async (sessionIds: Parameters<SessionDataHost["getSessionSearchMetadata"]>[0]) =>
      new Map(await stories.getSessionSearchMetadata(sessionIds)),
    countTurnSummaries: (sessionId: Parameters<SessionDataHost["countTurnSummaries"]>[0]) =>
      stories.countTurnSummaries(sessionId),
    loadTurnSummaryRange: (sessionId: Parameters<SessionDataHost["loadTurnSummaryRange"]>[0], fromTurnNumber: Parameters<SessionDataHost["loadTurnSummaryRange"]>[1], toTurnNumber: Parameters<SessionDataHost["loadTurnSummaryRange"]>[2], limit: Parameters<SessionDataHost["loadTurnSummaryRange"]>[3]) =>
      stories.loadTurnSummaryRange(
        sessionId,
        fromTurnNumber,
        toTurnNumber,
        limit,
      ),
    searchSessionDigests: (
      query: Parameters<SessionDataHost["searchSessionDigests"]>[0],
      sessionIds: Parameters<SessionDataHost["searchSessionDigests"]>[1],
      limit: Parameters<SessionDataHost["searchSessionDigests"]>[2],
      includeHighlight: Parameters<SessionDataHost["searchSessionDigests"]>[3],
      includeStory: Parameters<SessionDataHost["searchSessionDigests"]>[4],
    ) => stories.searchSessionDigests(
      query,
      sessionIds,
      limit,
      includeHighlight,
      includeStory,
    ),
    getSessionStory: (sessionId: Parameters<SessionDataHost["getSessionStory"]>[0]) => stories.getSessionStory(sessionId),
    getTurnExcerpt: (sessionId: Parameters<SessionDataHost["getTurnExcerpt"]>[0], maxResponseChars: Parameters<SessionDataHost["getTurnExcerpt"]>[1]) =>
      composites.getTurnExcerpt(sessionId, maxResponseChars),
    getResumeContext: (sessionId: Parameters<SessionDataHost["getResumeContext"]>[0], limit: Parameters<SessionDataHost["getResumeContext"]>[1]) =>
      composites.getResumeContext(sessionId, limit),
  } as unknown as SessionDataHost);
}

import type {
  SessionEventSearchRow,
  SessionHistorySearchParams,
  SessionHistorySearchResult,
} from "@soulstream/mcp-contract";
import {
  withLiveSearchDbConnection,
  type LiveSearchDbConnectionFactory,
} from "../../runtime/live_db_sql.js";
import { EventReadRepository } from "./event_read_repository.js";
import {
  SessionStoryReadRepository,
} from "./session_story_read_repository.js";

export class SessionHistorySearchDeadlineError extends Error {
  readonly statusCode = 504;

  constructor() {
    super("session history search exceeded its database time limit");
    this.name = "SessionHistorySearchDeadlineError";
  }
}

export class SessionHistorySearchRepository {
  constructor(
    private readonly searchConnectionFactory: LiveSearchDbConnectionFactory,
    private readonly events: EventReadRepository,
    private readonly stories: SessionStoryReadRepository,
    private readonly onSearchCancelError: (error: unknown) => void = () => undefined,
  ) {}

  async search(
    params: SessionHistorySearchParams,
    signal: AbortSignal,
  ): Promise<SessionHistorySearchResult> {
    try {
      return await withLiveSearchDbConnection(
        this.searchConnectionFactory,
        signal,
        this.onSearchCancelError,
        async (runQuery) => {
          const events = await this.events.searchEventsOnConnection(
            params.query,
            params.sessionIds,
            params.limit,
            params.eventTypes,
            runQuery,
          );
          const sessionIdEvents = params.searchSessionId
            ? await this.events.searchEventsBySessionIdOnConnection(
                params.query,
                params.eventTypes,
                params.limit,
                runQuery,
              )
            : [];
          const digests = params.includeHighlight || params.includeStory
            ? await this.stories.searchSessionDigestsOnConnection(
                params.query,
                params.sessionIds,
                params.limit,
                params.includeHighlight,
                params.includeStory,
                runQuery,
              )
            : [];
          return { events, sessionIdEvents, digests };
        },
      );
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? new Error("session history search was cancelled");
      if (isPostgresStatementTimeout(error)) throw new SessionHistorySearchDeadlineError();
      throw error;
    }
  }
}

function isPostgresStatementTimeout(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "57014"
    && error.message === "canceling statement due to statement timeout";
}

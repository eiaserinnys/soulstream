import type { EventReadRepository } from "./event_read_repository.js";
import type { SessionReadRepository } from "./session_read_repository.js";
import type {
  HostSessionStoryView,
  SessionStoryReadRepository,
} from "./session_story_read_repository.js";

const TURN_EXCERPT_EVENT_TYPES = [
  "user_message",
  "assistant_message",
  "user_text",
  "assistant_text",
];

export class SessionReadCompositeRepository {
  constructor(
    private readonly sessions: SessionReadRepository,
    private readonly events: EventReadRepository,
    private readonly stories: SessionStoryReadRepository,
  ) {}

  async getTurnExcerpt(sessionId: string, maxResponseChars = 500): Promise<{
    totalEvents: number;
    turns: Array<{
      event_id: number;
      event_type: string;
      text: string;
      created_at: string;
    }>;
  }> {
    const totalEvents = await this.events.countEvents(sessionId);
    const events = await this.events.readEvents(
      sessionId,
      0,
      Math.min(totalEvents, 200),
      TURN_EXCERPT_EVENT_TYPES,
    );
    return {
      totalEvents,
      turns: events.map((event) => ({
        event_id: event.id,
        event_type: event.event_type,
        text: truncate(
          extractText(event.payload),
          maxResponseChars > 0 ? maxResponseChars : undefined,
        ),
        created_at: event.created_at.toISOString(),
      })),
    };
  }

  async getResumeContext(sessionId: string, limit: number) {
    const [session, runningSessions] = await Promise.all([
      this.sessions.getSession(sessionId),
      this.sessions.listRunningSessionsSummary({
        limit,
        excludeSessionId: sessionId,
      }),
    ]);
    if (!session) {
      return {
        session: null,
        folderSessions: { sessions: [], total: 0 },
        runningSessions,
        predecessor: null,
      };
    }

    const [folderSessions, predecessor] = await Promise.all([
      session.folder_id
        ? this.sessions.listSessionsSummary({
            limit,
            offset: 0,
            folderId: session.folder_id,
          })
        : Promise.resolve({ sessions: [], total: 0 }),
      this.readPredecessor(session.predecessor_session_id),
    ]);
    return { session, folderSessions, runningSessions, predecessor };
  }

  private async readPredecessor(predecessorId: string | null) {
    if (!predecessorId) return null;
    const predecessor = await this.sessions.getSession(predecessorId);
    if (!predecessor) return null;
    const story = await this.stories.getSessionStory(predecessorId);
    const excerpt = hasStoryContent(story)
      ? null
      : await this.getTurnExcerpt(predecessorId);
    return { session: predecessor, story, excerpt };
  }
}

function hasStoryContent(story: HostSessionStoryView): boolean {
  return story.narrative !== null || story.unfoldedTurnSummaries.length > 0;
}

function extractText(payload: Record<string, unknown>): string {
  for (const key of ["text", "content", "message", "value"]) {
    const value = payload[key];
    if (typeof value === "string") return value;
  }
  return JSON.stringify(payload);
}

function truncate(value: string, limit?: number): string {
  if (limit === undefined || limit === 0) return value;
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

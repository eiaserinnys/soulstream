import type { EventReadRepository } from "./event_read_repository.js";
import type { SessionReadRepository } from "./session_read_repository.js";
import type {
  HostSessionStoryView,
  SessionStoryReadRepository,
} from "./session_story_read_repository.js";
import type { GenerationCheckpointMaterial, GenerationCheckpointReadLimits } from "@soulstream/mcp-contract";

const TURN_EXCERPT_EVENT_TYPES = [
  "user_message",
  "assistant_message",
  "user_text",
  "assistant_text",
];
const TURN_EXCERPT_EVENT_LIMIT = 200;
const GENERATION_CHECKPOINT_EVENT_TYPES = [
  "user_message",
  "intervention_sent",
  "session_notification",
  "assistant_message",
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
    const events = await this.events.readRecentEvents(
      sessionId,
      Math.min(totalEvents, TURN_EXCERPT_EVENT_LIMIT),
      TURN_EXCERPT_EVENT_TYPES,
    );
    const turns = boundedRecentTurns(events, maxResponseChars);
    return {
      totalEvents,
      turns,
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

  async getGenerationCheckpointMaterial(
    sessionId: string,
    limits: GenerationCheckpointReadLimits,
  ): Promise<GenerationCheckpointMaterial> {
    const [story, eventTotal, summaryTotals, childSessionResult] = await Promise.all([
      this.stories.getSessionStory(sessionId),
      this.events.countEvents(sessionId),
      this.stories.countTurnSummaries(sessionId),
      this.sessions.listActiveChildSessionsSummary(sessionId),
    ]);
    const latestUnfoldedSummary = story.unfoldedTurnSummaries.at(-1);
    let lastSummarizedFinalResponseEventId = latestUnfoldedSummary?.finalResponseEventId ?? null;
    if (!latestUnfoldedSummary && story.narrativeThroughEventId !== null) {
      const foldedSummary = await this.events.readOneEvent(sessionId, story.narrativeThroughEventId);
      lastSummarizedFinalResponseEventId = readFinalResponseEventId(foldedSummary?.payload);
    }

    const [unsummarizedResult, recentEvents] = await Promise.all([
      this.events.readRecentEventsAfter(
        sessionId,
        lastSummarizedFinalResponseEventId ?? 0,
        limits.unsummarizedEventLimit,
        GENERATION_CHECKPOINT_EVENT_TYPES,
      ),
      lastSummarizedFinalResponseEventId === null
        ? Promise.resolve([])
        : this.events.readRecentEventsBefore(
            sessionId,
            lastSummarizedFinalResponseEventId,
            limits.recentEventLimit,
            GENERATION_CHECKPOINT_EVENT_TYPES,
          ),
    ]);
    const recordsById = new Map<number, GenerationCheckpointMaterial["recent"]["records"][number]>();
    for (const event of recentEvents) {
      if (lastSummarizedFinalResponseEventId === null || event.id > lastSummarizedFinalResponseEventId) continue;
      recordsById.set(event.id, checkpointEventRecord(event));
    }
    for (const event of unsummarizedResult.events) {
      if (lastSummarizedFinalResponseEventId !== null && event.id <= lastSummarizedFinalResponseEventId) continue;
      recordsById.set(event.id, checkpointEventRecord(event));
    }

    return {
      story,
      lastSummarizedFinalResponseEventId,
      recent: {
        records: [...recordsById.values()].sort((left, right) => left.event_id - right.event_id),
        omittedUnsummarized: unsummarizedResult.total - unsummarizedResult.events.length,
      },
      childSessions: childSessionResult.sessions.map((child) => ({
        sessionId: child.session_id,
        displayName: child.display_name,
        agentId: child.agent_id,
        modelPreset: child.model_preset,
        status: child.status,
        cardId: child.card_id,
        reference: child.reference,
        createdAt: child.created_at.toISOString(),
      })),
      childSessionTotal: childSessionResult.total,
      totals: {
        events: eventTotal,
        turnSummaries: summaryTotals.totalCount,
      },
    };
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

function boundedRecentTurns(
  events: Array<{
    id: number;
    event_type: string;
    payload: Record<string, unknown>;
    created_at: Date;
  }>,
  maxResponseChars: number,
): Array<{ event_id: number; event_type: string; text: string; created_at: string }> {
  let remaining = maxResponseChars > 0 ? maxResponseChars : Number.POSITIVE_INFINITY;
  const turns: Array<{
    event_id: number;
    event_type: string;
    text: string;
    created_at: string;
  }> = [];
  for (let index = events.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    const text = truncate(extractText(event.payload), remaining);
    turns.unshift({
      event_id: event.id,
      event_type: event.event_type,
      text,
      created_at: event.created_at.toISOString(),
    });
    remaining -= text.length;
  }
  return turns;
}

function truncate(value: string, limit?: number): string {
  if (limit === undefined || limit === 0) return value;
  if (value.length <= limit) return value;
  if (limit <= 1) return "…".slice(0, limit);
  return `${value.slice(0, limit - 1)}…`;
}

function readFinalResponseEventId(payload: Record<string, unknown> | undefined): number | null {
  const value = payload?.final_response_event_id;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function checkpointEventRecord(event: {
  id: number;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}): GenerationCheckpointMaterial["recent"]["records"][number] {
  return {
    event_id: event.id,
    event_type: event.event_type,
    text: extractText(event.payload),
    created_at: event.created_at.toISOString(),
  };
}

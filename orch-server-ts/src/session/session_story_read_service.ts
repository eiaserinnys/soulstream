import {
  serializeSessionStoryView,
  type SessionStoryViewResponse,
} from "@soulstream/mcp-contract";
import type {
  SessionStoryRepositoryPort,
} from "../turn-summary/session_story_repository.js";

type SessionStoryReadRepository = Pick<
  SessionStoryRepositoryPort,
  "loadDigest" | "countUnfoldedSummaries" | "loadUnfoldedSummaries"
>;

export class SessionStoryReadService {
  constructor(private readonly repository: SessionStoryReadRepository) {}

  async readStory(sessionId: string): Promise<SessionStoryViewResponse> {
    const digest = await this.repository.loadDigest(sessionId);
    const watermark = digest?.narrativeThroughEventId ?? null;
    const unfoldedCount = await this.repository.countUnfoldedSummaries(
      sessionId,
      watermark,
    );
    const unfolded = unfoldedCount === 0
      ? []
      : await this.repository.loadUnfoldedSummaries(
          sessionId,
          watermark,
          unfoldedCount,
        );

    return serializeSessionStoryView({
      highlight: digest?.highlight ?? null,
      narrative: digest?.narrative ?? null,
      unfoldedTurnSummaries: unfolded,
      narrativeThroughEventId: digest?.narrativeThroughEventId ?? null,
      foldCount: digest?.foldCount ?? 0,
      updatedAt: digest?.updatedAt ?? null,
    });
  }
}

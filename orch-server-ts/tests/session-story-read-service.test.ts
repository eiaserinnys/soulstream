import { describe, expect, it, vi } from "vitest";

import { SessionStoryReadService } from "../src/session/session_story_read_service.js";

describe("SessionStoryReadService", () => {
  it("assembles the digest and every unfolded summary with MCP-compatible keys", async () => {
    const repository = {
      loadDigest: vi.fn(async () => ({
        sessionId: "sess-1",
        narrative: "[T1-T4] 접힌 줄거리",
        highlight: "핵심 하이라이트",
        narrativeThroughEventId: 40,
        foldCount: 2,
        version: 3,
        createdAt: new Date("2026-07-30T16:00:00.000Z"),
        updatedAt: new Date("2026-07-30T16:30:00.000Z"),
      })),
      countUnfoldedSummaries: vi.fn(async () => 1),
      loadUnfoldedSummaries: vi.fn(async () => [{
        eventId: 45,
        turnNumber: 5,
        content: "최근 턴",
        turnStartEventId: 41,
        finalResponseEventId: 44,
        createdAt: new Date("2026-07-30T17:00:00.000Z"),
      }]),
    };

    const story = await new SessionStoryReadService(repository)
      .readStory("sess-1");

    expect(story).toEqual({
      highlight: "핵심 하이라이트",
      narrative: "[T1-T4] 접힌 줄거리",
      unfolded_turn_summaries: [{
        event_id: 45,
        turn_number: 5,
        content: "최근 턴",
        turn_start_event_id: 41,
        final_response_event_id: 44,
        created_at: "2026-07-30T17:00:00.000Z",
      }],
      narrative_through_event_id: 40,
      fold_count: 2,
      updated_at: "2026-07-30T16:30:00.000Z",
    });
    expect(repository.countUnfoldedSummaries).toHaveBeenCalledWith(
      "sess-1",
      40,
    );
    expect(repository.loadUnfoldedSummaries).toHaveBeenCalledWith(
      "sess-1",
      40,
      1,
    );
  });

  it("returns the empty digest fallback without issuing a zero-limit query", async () => {
    const repository = {
      loadDigest: vi.fn(async () => null),
      countUnfoldedSummaries: vi.fn(async () => 0),
      loadUnfoldedSummaries: vi.fn(),
    };

    await expect(
      new SessionStoryReadService(repository).readStory("sess-empty"),
    ).resolves.toEqual({
      highlight: null,
      narrative: null,
      unfolded_turn_summaries: [],
      narrative_through_event_id: null,
      fold_count: 0,
      updated_at: null,
    });
    expect(repository.countUnfoldedSummaries).toHaveBeenCalledWith(
      "sess-empty",
      null,
    );
    expect(repository.loadUnfoldedSummaries).not.toHaveBeenCalled();
  });
});

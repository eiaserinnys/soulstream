import { describe, expect, it, vi } from "vitest";

import { searchSessionEvents } from "../../src/search/session_search.js";

describe("searchSessionEvents derived-text scope", () => {
  it("preserves the existing event search when all new flags are omitted", async () => {
    const searchEvents = vi.fn(async () => []);
    const searchSessionDigests = vi.fn(async () => []);
    const db = {
      searchEvents,
      searchEventsBySessionId: vi.fn(async () => []),
      searchSessionDigests,
    };

    await expect(searchSessionEvents(db as never, {
      query: "needle",
      limit: 10,
    })).resolves.toEqual([]);

    expect(searchSessionDigests).not.toHaveBeenCalled();
    expect(searchEvents.mock.calls[0]?.[3]).not.toContain("turn_summary");
  });

  it("adds turn summaries and merges highlight/story matches with explicit sources", async () => {
    const db = {
      searchEvents: vi.fn(async () => [{
        id: 30,
        session_id: "sess-1",
        event_type: "turn_summary",
        searchable_text: "needle turn",
        score: 0.9,
      }]),
      searchEventsBySessionId: vi.fn(async () => []),
      searchSessionDigests: vi.fn(async () => [
        {
          id: 24,
          session_id: "sess-1",
          event_type: "session_highlight",
          searchable_text: "needle highlight",
          score: 0.8,
          match_source: "highlight",
        },
        {
          id: 24,
          session_id: "sess-1",
          event_type: "session_story",
          searchable_text: "needle story",
          score: 0.7,
          match_source: "story",
        },
      ]),
    };

    const results = await searchSessionEvents(db as never, {
      query: "needle",
      includeTurnSummaries: true,
      includeHighlight: true,
      includeStory: true,
    });

    expect(db.searchEvents.mock.calls[0]?.[3]).toContain("turn_summary");
    expect(db.searchSessionDigests).toHaveBeenCalledWith(
      "needle",
      null,
      10,
      true,
      true,
    );
    expect(results.map((result) => result.match_source)).toEqual([
      "turn_summary",
      "highlight",
      "story",
    ]);
  });
});

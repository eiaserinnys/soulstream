import { describe, expect, it, vi } from "vitest";

import { searchSessionEvents } from "../../src/search/session_search.js";

describe("searchSessionEvents derived-text scope", () => {
  it("forwards cancellation through one combined host search request", async () => {
    const caller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const searchSessionHistory = vi.fn(async (_params, signal: AbortSignal) => {
      receivedSignal = signal;
      caller.abort(new Error("caller stopped search"));
      throw signal.reason;
    });

    await expect(searchSessionEvents({
      searchSessionHistory,
    } as never, {
      query: "needle",
      searchSessionId: true,
      includeHighlight: true,
      signal: caller.signal,
    })).rejects.toThrow("caller stopped search");

    expect(receivedSignal?.aborted).toBe(true);
    expect(searchSessionHistory).toHaveBeenCalledTimes(1);
  });

  it("preserves the existing event search when all new flags are omitted", async () => {
    const searchSessionHistory = vi.fn(async () => ({
      events: [],
      sessionIdEvents: [],
      digests: [],
    }));

    await expect(searchSessionEvents({ searchSessionHistory } as never, {
      query: "needle",
      limit: 10,
    })).resolves.toEqual([]);

    expect(searchSessionHistory).toHaveBeenCalledWith({
      query: "needle",
      sessionIds: null,
      limit: 10,
      eventTypes: expect.not.arrayContaining(["turn_summary"]),
      searchSessionId: false,
      includeHighlight: false,
      includeStory: false,
    }, expect.any(AbortSignal));
  });

  it("adds turn summaries and merges highlight/story matches with explicit sources", async () => {
    const db = { searchSessionHistory: vi.fn(async () => ({
      events: [{
        id: 30,
        session_id: "sess-1",
        event_type: "turn_summary",
        searchable_text: "needle turn",
        score: 0.9,
      }],
      sessionIdEvents: [],
      digests: [
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
      ],
    })) };

    const results = await searchSessionEvents(db as never, {
      query: "needle",
      includeTurnSummaries: true,
      includeHighlight: true,
      includeStory: true,
    });

    expect(db.searchSessionHistory.mock.calls[0]?.[0]).toMatchObject({
      query: "needle",
      eventTypes: expect.arrayContaining(["turn_summary"]),
      includeHighlight: true,
      includeStory: true,
    });
    expect(db.searchSessionHistory).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.match_source)).toEqual([
      "turn_summary",
      "highlight",
      "story",
    ]);
  });
});

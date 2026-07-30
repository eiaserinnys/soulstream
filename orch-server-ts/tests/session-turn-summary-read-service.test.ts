import { describe, expect, it, vi } from "vitest";

import { SessionTurnSummaryReadService } from
  "../src/session/session_turn_summary_read_service.js";

const summary = {
  eventId: 24,
  turnNumber: 2,
  content: "두 번째 턴",
  turnStartEventId: 15,
  finalResponseEventId: 22,
  createdAt: new Date("2026-07-31T00:01:00.000Z"),
};

describe("SessionTurnSummaryReadService", () => {
  it("returns count, index, and paginated range in the shared wire contract", async () => {
    const repository = {
      countTurnSummaries: vi.fn(async () => ({
        totalCount: 4,
        digestedCount: 3,
        undigestedCount: 1,
      })),
      loadTurnSummaryRange: vi.fn(async () => [summary, { ...summary, turnNumber: 3 }]),
    };
    const service = new SessionTurnSummaryReadService(repository);

    await expect(service.read("sess-1", { mode: "count" })).resolves.toEqual({
      session_id: "sess-1",
      mode: "count",
      total_count: 4,
      digested_count: 3,
      undigested_count: 1,
    });
    await expect(service.read("sess-1", {
      mode: "index",
      turnNumber: 2,
    })).resolves.toMatchObject({
      session_id: "sess-1",
      mode: "index",
      turn_number: 2,
      summary: {
        event_id: 24,
        turn_number: 2,
        content: "두 번째 턴",
      },
    });
    await expect(service.read("sess-1", {
      mode: "range",
      fromTurnNumber: 2,
      toTurnNumber: null,
      limit: 1,
    })).resolves.toMatchObject({
      session_id: "sess-1",
      mode: "range",
      summaries: [{ event_id: 24, turn_number: 2 }],
      has_more: true,
      next_from_turn_number: 3,
    });
  });
});

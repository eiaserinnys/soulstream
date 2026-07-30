import { describe, expect, it, vi } from "vitest";

import { SessionStoryReadRepository } from
  "../../src/db/repositories/session_story_repository.js";
import type { SqlClient } from "../../src/db/session_db_types.js";

describe("SessionStoryReadRepository turn summary queries", () => {
  it("counts total, digested, and undigested summaries in one bounded session query", async () => {
    const { repository, calls } = repositoryWithResponses([[
      { total_count: 7, digested_count: 5, undigested_count: 2 },
    ]]);

    await expect(repository.countTurnSummaries("sess-1")).resolves.toEqual({
      totalCount: 7,
      digestedCount: 5,
      undigestedCount: 2,
    });
    expect(calls[0]?.text).toContain("COUNT(*) FILTER");
    expect(calls[0]?.text).toContain("session_digests");
    expect(calls[0]?.values).toEqual(["sess-1"]);
  });

  it("returns an inclusive chronological turn range with stable global turn numbers", async () => {
    const { repository, calls } = repositoryWithResponses([[
      {
        id: 24,
        turn_number: 2,
        payload: {
          content: "두 번째 턴",
          turn_start_event_id: 15,
          final_response_event_id: 22,
        },
        created_at: new Date("2026-07-31T00:01:00.000Z"),
      },
    ]]);

    await expect(repository.loadTurnSummaryRange(
      "sess-1",
      2,
      4,
      3,
    )).resolves.toEqual([
      expect.objectContaining({ eventId: 24, turnNumber: 2 }),
    ]);
    expect(calls[0]?.text).toContain("ROW_NUMBER() OVER (ORDER BY id ASC)");
    expect(calls[0]?.text).toContain("turn_number >=");
    expect(calls[0]?.text).toContain("turn_number <=");
    expect(calls[0]?.values).toEqual(["sess-1", 2, 4, 3]);
  });
});

function repositoryWithResponses(
  responses: ReadonlyArray<readonly Record<string, unknown>[]>,
): {
  repository: SessionStoryReadRepository;
  calls: Array<{ text: string; values: unknown[] }>;
} {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const execute = vi.fn((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    calls.push({
      text: strings.join("?").replace(/\s+/g, " ").trim(),
      values,
    });
    return Promise.resolve(responses[calls.length - 1] ?? []);
  }) as unknown as SqlClient;
  return {
    repository: new SessionStoryReadRepository(execute),
    calls,
  };
}

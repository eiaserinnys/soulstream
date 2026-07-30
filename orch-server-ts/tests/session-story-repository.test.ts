import { describe, expect, it, vi } from "vitest";

import type {
  LiveDbSqlResolver,
  LivePostgresSql,
} from "../src/runtime/live_db_sql.js";
import { SessionStoryRepository } from
  "../src/turn-summary/session_story_repository.js";

describe("SessionStoryRepository", () => {
  it("numbers all summaries before applying the watermark and keeps durable id order", async () => {
    const { repository, calls } = repositoryWithResponses([[
      {
        id: 31,
        turn_number: 3,
        payload: {
          content: "인터럽트 뒤 세 번째 턴",
          turn_start_event_id: 25,
          final_response_event_id: 29,
        },
        created_at: new Date("2026-07-31T00:00:00.000Z"),
      },
      {
        id: 44,
        turn_number: 4,
        payload: {
          content: "고아 발화 뒤 네 번째 턴",
          turn_start_event_id: 35,
          final_response_event_id: 41,
        },
        created_at: new Date("2026-07-31T00:01:00.000Z"),
      },
    ]]);

    await expect(repository.loadUnfoldedSummaries(
      "session-a",
      24,
      5,
    )).resolves.toEqual([
      expect.objectContaining({ eventId: 31, turnNumber: 3 }),
      expect.objectContaining({ eventId: 44, turnNumber: 4 }),
    ]);
    expect(calls[0]?.text).toContain("ROW_NUMBER() OVER (ORDER BY id ASC)");
    expect(calls[0]?.text).toContain("WHERE id >");
    expect(calls[0]?.values).toEqual(["session-a", 24, 5]);
  });

  it("updates every digest field behind one optimistic version guard", async () => {
    const { repository, calls } = repositoryWithResponses([[{ version: 3 }]]);

    await expect(repository.storeDigest({
      sessionId: "session-a",
      narrative: "[T1-T5] 구현했다.",
      highlight: "핵심.",
      narrativeThroughEventId: 52,
      expectedVersion: 2,
    })).resolves.toBe(true);

    expect(calls[0]?.text).toContain("ON CONFLICT (session_id) DO UPDATE");
    expect(calls[0]?.text).toContain(
      "WHERE session_digests.version =",
    );
    expect(calls[0]?.text).toContain(
      "narrative_through_event_id = EXCLUDED.narrative_through_event_id",
    );
    expect(calls[0]?.values).toContain(2);
  });

  it("reports a lost version race without partially advancing the watermark", async () => {
    const { repository } = repositoryWithResponses([[]]);

    await expect(repository.storeDigest({
      sessionId: "session-a",
      narrative: "[T1] 후보",
      highlight: "후보",
      narrativeThroughEventId: 12,
      expectedVersion: 1,
    })).resolves.toBe(false);
  });
});

function repositoryWithResponses(
  responses: ReadonlyArray<readonly Record<string, unknown>[]>,
): {
  repository: SessionStoryRepository;
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
  });
  const sql = Object.assign(execute, {
    json: (value: unknown) => value,
  }) as unknown as LivePostgresSql;
  const resolver: LiveDbSqlResolver = {
    resolveSql: async () => sql,
    close: async () => undefined,
  };
  return {
    repository: new SessionStoryRepository(resolver),
    calls,
  };
}

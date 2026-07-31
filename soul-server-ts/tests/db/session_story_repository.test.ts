import { describe, expect, it, vi } from "vitest";

import { SessionStoryReadRepository } from
  "../../src/db/repositories/session_story_repository.js";
import type { SqlClient } from "../../src/db/session_db_types.js";

describe("SessionStoryReadRepository", () => {
  it("loads turn and digest presence metadata for unique sessions in one query", async () => {
    const { repository, calls } = repositoryWithResponses([[
      {
        session_id: "session-a",
        turn_count: 3,
        has_turn_summaries: true,
        has_story_digest: true,
        has_highlight: true,
      },
      {
        session_id: "session-b",
        turn_count: 0,
        has_turn_summaries: false,
        has_story_digest: false,
        has_highlight: false,
      },
    ]]);

    await expect(repository.getSessionSearchMetadata([
      "session-a",
      "session-b",
    ])).resolves.toEqual(new Map([
      ["session-a", {
        turnCount: 3,
        hasTurnSummaries: true,
        hasStoryDigest: true,
        hasHighlight: true,
      }],
      ["session-b", {
        turnCount: 0,
        hasTurnSummaries: false,
        hasStoryDigest: false,
        hasHighlight: false,
      }],
    ]));
    expect(calls[0]?.text).toContain("user_message");
    expect(calls[0]?.text).toContain("intervention_sent");
    expect(calls[0]?.text).toContain("session_notification");
    expect(calls[0]?.text).toContain("turn_summary");
    expect(calls[0]?.text).toContain("session_digests");
    expect(calls[0]?.values).toEqual([["session-a", "session-b"]]);
  });

  it("returns all turn summaries as unfolded when no digest row exists", async () => {
    const { repository, calls } = repositoryWithResponses([
      [],
      [
        {
          id: 12,
          turn_number: 1,
          payload: {
            content: "첫 턴",
            turn_start_event_id: 2,
            final_response_event_id: 10,
          },
          created_at: new Date("2026-07-31T00:00:00.000Z"),
        },
        {
          id: 24,
          turn_number: 2,
          payload: {
            content: "고아 발화와 인터럽트 뒤 재개",
            turn_start_event_id: 15,
            final_response_event_id: 22,
          },
          created_at: new Date("2026-07-31T00:01:00.000Z"),
        },
      ],
    ]);

    await expect(repository.getSessionStory("session-a")).resolves.toEqual({
      highlight: null,
      narrative: null,
      unfoldedTurnSummaries: [
        expect.objectContaining({ eventId: 12, turnNumber: 1 }),
        expect.objectContaining({ eventId: 24, turnNumber: 2 }),
      ],
      narrativeThroughEventId: null,
      foldCount: 0,
      updatedAt: null,
    });
    expect(calls[1]?.text).toContain("ROW_NUMBER() OVER (ORDER BY id ASC)");
    expect(calls[1]?.values).toContain(0);
  });

  it("queries only summaries after the digest watermark", async () => {
    const updatedAt = new Date("2026-07-31T01:00:00.000Z");
    const { repository, calls } = repositoryWithResponses([
      [{
        highlight: "핵심",
        narrative: "[T1-T5] 완료했다.",
        narrative_through_event_id: 52,
        fold_count: 1,
        updated_at: updatedAt,
      }],
      [],
    ]);

    await expect(repository.getSessionStory("session-a")).resolves.toEqual({
      highlight: "핵심",
      narrative: "[T1-T5] 완료했다.",
      unfoldedTurnSummaries: [],
      narrativeThroughEventId: 52,
      foldCount: 1,
      updatedAt,
    });
    expect(calls[1]?.values).toContain(52);
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

import { describe, expect, it, vi } from "vitest";

import type {
  LiveDbSqlResolver,
  LivePostgresSql,
} from "../src/runtime/live_db_sql.js";
import {
  summaryDedupeKey,
  TurnSummaryRepository,
} from "../src/turn-summary/turn_summary_repository.js";

describe("TurnSummaryRepository", () => {
  it("reconstructs a remote-owned session turn from the shared DB without an owner API", async () => {
    const { repository, calls } = repositoryWithResponses([
      [{
        folder_id: "folder-a",
        metadata: [{ type: "caller_info", value: { source: "browser" } }],
      }],
      [
        row(10, "user_message", { text: "요청" }),
        row(19, "assistant_message", { content: "응답" }),
        row(20, "complete", {}),
      ],
    ]);

    await expect(repository.loadTurn("session-a", 20)).resolves.toEqual({
      sessionId: "session-a",
      folderId: "folder-a",
      metadata: [{ type: "caller_info", value: { source: "browser" } }],
      turnStartEventId: 10,
      finalResponseEventId: 19,
      userText: "요청",
      assistantText: "응답",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.text).toContain("FROM sessions");
    expect(calls[1]?.text).toContain("FROM events");
    expect(calls.flatMap((call) => call.values)).not.toContain("node-a");
  });

  it("appends through event_append with the anchor dedupe key", async () => {
    const { repository, calls } = repositoryWithResponses([
      [],
      [{ event_append: 22 }],
    ]);
    const payload = {
      type: "turn_summary",
      content: "요약",
      turn_start_event_id: 10,
      final_response_event_id: 19,
      parent_event_id: 19,
    };

    await expect(repository.appendSummary(
      "session-a",
      payload,
      summaryDedupeKey(10, 19),
    )).resolves.toEqual({ inserted: true, eventId: 22 });
    expect(calls[1]?.text).toContain("SELECT event_append");
    expect(calls[1]?.values).toContain("session-a");
    expect(calls[1]?.values).toContain("turn_summary:10:19");
    expect(calls[1]?.values).toContain(JSON.stringify(payload));
  });

  it("returns gap events in DB order for local SSE catch-up", async () => {
    const { repository } = repositoryWithResponses([[
      { id: 21, event_type: "progress", payload: { text: "late" } },
      { id: 22, event_type: "system", payload: { text: "later" } },
    ]]);

    await expect(repository.loadGapEvents("session-a", 20, 23)).resolves.toEqual([
      {
        type: "event",
        agentSessionId: "session-a",
        event: { type: "progress", text: "late", _event_id: 21 },
      },
      {
        type: "event",
        agentSessionId: "session-a",
        event: { type: "system", text: "later", _event_id: 22 },
      },
    ]);
  });

  it.each([
    [{ status: "running", termination_reason: null }, true],
    [{ status: "completed", termination_reason: "completed_ok" }, true],
    [{ status: "interrupted", termination_reason: "killed" }, false],
    [{ status: "error", termination_reason: "error_aborted" }, false],
    [{ status: "completed", termination_reason: "limit_hit" }, false],
  ])("filters terminal interruption and error state %j", async (row, expected) => {
    const { repository } = repositoryWithResponses([[row]]);
    await expect(repository.isSessionSummarizable("session-a")).resolves
      .toBe(expected);
  });
});

function repositoryWithResponses(
  responses: ReadonlyArray<readonly Record<string, unknown>[]>,
): {
  repository: TurnSummaryRepository;
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
    repository: new TurnSummaryRepository(resolver),
    calls,
  };
}

function row(
  id: number,
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    event_type: eventType,
    payload,
    created_at: new Date(id * 1_000),
  };
}

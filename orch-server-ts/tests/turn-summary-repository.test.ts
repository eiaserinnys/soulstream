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

  it("joins a completion notification child session and resolves its agent name", async () => {
    const { repository, calls } = repositoryWithResponses([
      [{
        folder_id: "folder-a",
        metadata: [{ type: "caller_info", value: { source: "browser" } }],
      }],
      [
        row(1199, "session_notification", {
          text: "✅ 에이전트 세션 완료",
          source: "completion_notifier",
          delivery_intent: "completion_notification",
          relation_key:
            "child_session:6c958db1-f792-445e-b355-6c5537b0c5c1:1291",
        }),
        row(1225, "assistant_message", { content: "PR #610을 머지했다." }),
        row(1226, "complete", {}),
      ],
      [{
        agent_id: "roselin",
        node_id: "eiaserinnys",
      }],
    ], ({ agentId, nodeId }) =>
      agentId === "roselin" && nodeId === "eiaserinnys"
        ? "로젤린"
        : undefined
    );

    await expect(repository.loadTurn("parent-session", 1226)).resolves
      .toMatchObject({
        speaker: {
          kind: "delegated_session",
          childSessionId: "6c958db1-f792-445e-b355-6c5537b0c5c1",
          agentName: "로젤린",
        },
      });
    expect(calls).toHaveLength(3);
    expect(calls[2]?.text).toContain("FROM sessions");
    expect(calls[2]?.values).toContain(
      "6c958db1-f792-445e-b355-6c5537b0c5c1",
    );
  });

  it("appends through event_append with the anchor dedupe key", async () => {
    const updatedAt = new Date("2026-07-31T00:00:00.000Z");
    const { repository, calls } = repositoryWithResponses([
      [],
      [{
        event_id: 22,
        status: "running",
        updated_at: updatedAt,
        last_message: {
          type: "turn_summary",
          preview: "요약",
          timestamp: updatedAt.toISOString(),
        },
        last_event_id: 22,
        last_read_event_id: 20,
      }],
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
    )).resolves.toMatchObject({
      inserted: true,
      eventId: 22,
      previewUpdate: {
        status: "running",
        lastMessage: {
          type: "turn_summary",
          preview: "요약",
        },
        lastEventId: 22,
        lastReadEventId: 20,
      },
    });
    expect(calls[1]?.text).toContain("SELECT event_append");
    expect(calls[1]?.text).toContain("UPDATE sessions");
    expect(calls[1]?.text).toContain("session.last_event_id = appended.event_id");
    expect(calls[1]?.values).toContain("session-a");
    expect(calls[1]?.values).toContain("turn_summary:10:19");
    expect(calls[1]?.values).toContain(JSON.stringify(payload));
  });

  it("does not report a preview update when a newer durable event won the race", async () => {
    const { repository } = repositoryWithResponses([
      [],
      [{ event_id: 22, last_event_id: null }],
    ]);

    await expect(repository.appendSummary(
      "session-a",
      { type: "turn_summary", content: "늦은 요약" },
      "turn_summary:10:19",
    )).resolves.toEqual({ inserted: true, eventId: 22 });
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
  resolveAgentName?: (input: {
    readonly agentId: string;
    readonly nodeId: string | null;
  }) => string | undefined,
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
    repository: new TurnSummaryRepository(resolver, { resolveAgentName }),
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

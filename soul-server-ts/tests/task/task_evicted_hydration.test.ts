import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type { SessionRow } from "../../src/db/session_db.js";
import { hydrateEvictedTaskFromSessionRow } from "../../src/task/task_evicted_hydration.js";

function makeLogger() {
  return { warn: vi.fn() } as unknown as Logger;
}

function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: "sess-hydrated",
    folder_id: null,
    display_name: null,
    node_id: "node-1",
    session_type: "claude",
    status: "completed",
    prompt: "original prompt",
    client_id: "client-1",
    claude_session_id: "thread-1",
    last_message: null,
    metadata: null,
    was_running_at_shutdown: false,
    last_event_id: 41,
    last_read_event_id: 7,
    created_at: new Date("2026-05-23T01:00:00.000Z"),
    updated_at: new Date("2026-05-23T01:05:00.000Z"),
    agent_id: "codex-default",
    caller_session_id: "caller-session-1",
    away_summary: null,
    ...overrides,
  };
}

describe("hydrateEvictedTaskFromSessionRow", () => {
  it.each([null, "", "invalid_status"] as const)(
    "returns null and warns for invalid status %j",
    (status) => {
      const logger = makeLogger();
      const row = makeRow({ status });

      expect(hydrateEvictedTaskFromSessionRow(row, logger)).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        { sessionId: "sess-hydrated", status, createdAt: row.created_at },
        "loadEvictedTask: incomplete or invalid SessionRow",
      );
    },
  );

  it.each(["completed", "error", "interrupted"] as const)(
    "hydrates terminal status %s with updated_at as completedAt",
    (status) => {
      const logger = makeLogger();
      const updatedAt = new Date("2026-05-23T02:30:00.000Z");

      const task = hydrateEvictedTaskFromSessionRow(
        makeRow({ status, updated_at: updatedAt }),
        logger,
      );

      expect(task?.status).toBe(status);
      expect(task?.completedAt).toBe(updatedAt);
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it("hydrates running status without completedAt", () => {
    const updatedAt = new Date("2026-05-23T02:30:00.000Z");

    const task = hydrateEvictedTaskFromSessionRow(
      makeRow({ status: "running", updated_at: updatedAt }),
      makeLogger(),
    );

    expect(task?.status).toBe("running");
    expect(task?.completedAt).toBeUndefined();
  });

  it("maps row fields to Task shape without changing public contract", () => {
    const createdAt = new Date("2026-05-23T01:00:00.000Z");

    const task = hydrateEvictedTaskFromSessionRow(
      makeRow({
        session_id: "sess-mapped",
        session_type: "llm",
        status: "completed",
        prompt: null,
        client_id: null,
        claude_session_id: null,
        last_event_id: null,
        last_read_event_id: null,
        created_at: createdAt,
        agent_id: null,
        caller_session_id: null,
      }),
      makeLogger(),
    );

    expect(task).toMatchObject({
      agentSessionId: "sess-mapped",
      prompt: "",
      status: "completed",
      hydratedFromDb: true,
      clientId: null,
      sessionType: "llm",
      createdAt,
      lastEventId: 0,
      lastReadEventId: 0,
      interventionQueue: [],
    });
    expect(task?.profileId).toBeUndefined();
    expect(task?.codexThreadId).toBeUndefined();
    expect(task?.callerSessionId).toBeUndefined();
  });

  it("restores persisted notify_completion=false for resumed completion suppression", () => {
    const task = hydrateEvictedTaskFromSessionRow(
      makeRow({ notify_completion: false }),
      makeLogger(),
    );

    expect(task?.notifyCompletion).toBe(false);
  });

  it("falls back to claude session type for non-llm values", () => {
    expect(hydrateEvictedTaskFromSessionRow(
      makeRow({ session_type: null }),
      makeLogger(),
    )?.sessionType).toBe("claude");
    expect(hydrateEvictedTaskFromSessionRow(
      makeRow({ session_type: "browser" }),
      makeLogger(),
    )?.sessionType).toBe("claude");
  });

  it("restores caller_info and OpenAI Agents metadata from metadata array", () => {
    const metadata = [
      { type: "caller_info", value: { source: "browser", display_name: "Old" } },
      { type: "caller_info", value: { source: "slack", display_name: "Alice" } },
      {
        type: "agents_run_state",
        value: {
          backend: "openai-agents",
          serialized: "state-1",
          pendingApprovalId: "approval-1",
          previousResponseId: "resp-1",
          conversationId: "conv-1",
          schemaVersion: "1.11",
        },
      },
      {
        type: "agents_session_items",
        value: {
          backend: "openai-agents",
          items: [{ role: "user", content: "hello" }],
        },
      },
      { type: "caller_info", value: {} },
    ];

    const task = hydrateEvictedTaskFromSessionRow(
      makeRow({ metadata }),
      makeLogger(),
    );

    expect(task?.metadata).toBe(metadata);
    expect(task?.callerInfo).toEqual({ source: "slack", display_name: "Alice" });
    expect(task?.agentsRunState).toBe("state-1");
    expect(task?.agentsRunStateSchemaVersion).toBe("1.11");
    expect(task?.agentsPendingApprovalId).toBe("approval-1");
    expect(task?.agentsPreviousResponseId).toBe("resp-1");
    expect(task?.agentsConversationId).toBe("conv-1");
    expect(task?.agentsSessionItems).toEqual([{ role: "user", content: "hello" }]);
  });

  it("normalizes non-array metadata to an empty array while preserving caller extraction behavior", () => {
    const task = hydrateEvictedTaskFromSessionRow(
      makeRow({ metadata: { type: "caller_info", value: { source: "slack" } } }),
      makeLogger(),
    );

    expect(task?.metadata).toEqual([]);
    expect(task?.callerInfo).toBeUndefined();
    expect(task?.agentsRunState).toBeUndefined();
    expect(task?.agentsSessionItems).toBeUndefined();
  });
});

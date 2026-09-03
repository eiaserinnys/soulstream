import { describe, expect, it, vi } from "vitest";

import type { ClaudeBackgroundTaskRow } from
  "../../src/db/repositories/claude_background_task_repository.js";
import { attachClaudeBackgroundProvenance } from
  "../../src/engine/claude_background_provenance.js";
import type { ClaudeClientEvent } from "../../src/engine/claude_event_mapper.js";
import { ClaudeBackgroundTaskLifecycle } from
  "../../src/task/claude_background_task_lifecycle.js";

describe("ClaudeBackgroundTaskLifecycle provenance boundary", () => {
  it("does not persist synchronous foreground Bash/Agent terminal events", async () => {
    const observe = vi.fn();
    const terminalize = vi.fn();
    const lifecycle = new ClaudeBackgroundTaskLifecycle({
      repository: {
        observe,
        terminalize,
      } as never,
      sourceNode: "node-test",
    });

    for (const taskId of ["foreground-bash", "foreground-agent"]) {
      await expect(lifecycle.observe("caller-session", {
        type: "claude_runtime_task_notification",
        taskId,
        status: "completed",
        summary: "already returned in the foreground tool result",
      })).resolves.toBe(true);
    }

    expect(observe).not.toHaveBeenCalled();
    expect(terminalize).not.toHaveBeenCalled();
  });

  it("persists a terminal event after SDK background membership is proven", async () => {
    const terminalize = vi.fn(async () => ({
      accepted: true,
      delivery: {
        delivery_id: "delivery-background-agent",
        completion_id: "completion:background-agent",
        relation_key: "claude_runtime:caller-session:background-agent",
        producer_terminal_revision: "1785081600000",
        created_at: new Date("2026-07-27T00:00:00.000Z"),
        source: "claude_runtime_task_followup",
        payload: { text: "done", user: "system" },
        payload_hash: "hash-background-agent",
      },
    }));
    const lifecycle = new ClaudeBackgroundTaskLifecycle({
      repository: {
        observe: vi.fn(),
        terminalize,
      } as never,
      sourceNode: "node-test",
      now: () => new Date("2026-07-27T00:00:00.000Z"),
    });
    const event: ClaudeClientEvent = {
      type: "claude_runtime_task_notification",
      taskId: "background-agent",
      status: "completed",
      summary: "detached work done",
    };
    attachClaudeBackgroundProvenance(event, "sdk_membership");

    await expect(lifecycle.observe(
      "caller-session",
      event,
      "runner:observe:terminal",
    )).resolves.toBe(true);

    expect(terminalize).toHaveBeenCalledTimes(1);
    expect(terminalize).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "caller-session",
      idempotencyKey: "runner:observe:terminal",
      taskId: "background-agent",
      status: "completed",
    }));
  });
});

describe("ClaudeBackgroundTaskLifecycle dead-runner recovery", () => {
  it("terminalizes only active rows owned by the proven-dead runner session", async () => {
    const target = row("session-dead", "task-a");
    const other = row("session-live", "task-b");
    const activeForSession = vi.fn()
      .mockResolvedValueOnce([target])
      .mockResolvedValueOnce([]);
    const terminalize = vi.fn(async () => ({
      accepted: true as const,
      row: { ...target, status: "killed" as const },
      delivery: { delivery_id: "delivery-a" },
    }));
    const lifecycle = new ClaudeBackgroundTaskLifecycle({
      repository: { activeForSession, terminalize } as never,
      sourceNode: "node-a",
      now: () => new Date("2026-09-03T05:36:28.000Z"),
    });

    await expect(
      lifecycle.terminalizeDeadRunner("session-dead"),
    ).resolves.toBe(1);

    expect(activeForSession).toHaveBeenCalledTimes(2);
    expect(activeForSession).toHaveBeenCalledWith("node-a", "session-dead");
    expect(terminalize).toHaveBeenCalledOnce();
    expect(terminalize).toHaveBeenCalledWith(expect.objectContaining({
      sourceNode: "node-a",
      sessionId: "session-dead",
      taskId: "task-a",
      status: "killed",
      closeReason: "worker_restart",
    }));
    expect(terminalize).not.toHaveBeenCalledWith(expect.objectContaining({
      sessionId: other.session_id,
    }));
  });
});

function row(sessionId: string, taskId: string): ClaudeBackgroundTaskRow {
  return {
    source_node: "node-a",
    session_id: sessionId,
    task_id: taskId,
    sdk_session_id: "sdk-a",
    status: "running",
    close_reason: null,
    description: "long work",
    summary: null,
    output_file: null,
    tool_use_id: null,
    terminal_revision: null,
    notification_delivery_id: null,
    created_at: new Date("2026-09-03T05:36:13.000Z"),
    updated_at: new Date("2026-09-03T05:36:13.000Z"),
    terminal_at: null,
  };
}

import { describe, expect, it, vi } from "vitest";

import type { ClaudeBackgroundTaskGenerationRow } from
  "../../src/db/repositories/claude_background_task_repository.js";
import { attachClaudeBackgroundProvenance } from
  "../../src/engine/claude_background_provenance.js";
import type { ClaudeClientEvent } from "../../src/engine/claude_event_mapper.js";
import { ClaudeBackgroundTaskLifecycle } from
  "../../src/task/claude_background_task_lifecycle.js";

describe("ClaudeBackgroundTaskLifecycle provenance boundary", () => {
  it("does not persist synchronous foreground Bash/Agent terminal events", async () => {
    const observeGeneration = vi.fn();
    const terminalizeGeneration = vi.fn();
    const lifecycle = new ClaudeBackgroundTaskLifecycle({
      repository: {
        observeGeneration,
        terminalizeGeneration,
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

    expect(observeGeneration).not.toHaveBeenCalled();
    expect(terminalizeGeneration).not.toHaveBeenCalled();
  });

  it("persists a terminal event after SDK background membership is proven", async () => {
    const terminalizeGeneration = vi.fn(async () => ({
      accepted: true,
      delivery: {
        delivery_id: "delivery-background-agent",
        completion_id: "completion:background-agent",
        relation_key: "relation-background-agent",
        producer_terminal_revision: "1785081600000",
        created_at: new Date("2026-07-27T00:00:00.000Z"),
        source: "claude_runtime_task_followup",
        payload: { text: "done", user: "system" },
        payload_hash: "hash-background-agent",
      },
    }));
    const lifecycle = new ClaudeBackgroundTaskLifecycle({
      repository: {
        observeGeneration: vi.fn(),
        terminalizeGeneration,
      } as never,
      sourceNode: "node-test",
      now: () => new Date("2026-07-27T00:00:00.000Z"),
    });
    const event: ClaudeClientEvent = {
      type: "claude_runtime_task_notification",
      taskId: "background-agent",
      sessionId: "sdk-session",
      toolUseId: "toolu-background-agent",
      status: "completed",
      summary: "detached work done",
    };
    attachClaudeBackgroundProvenance(event, "sdk_membership");

    await expect(lifecycle.observe(
      "caller-session",
      event,
      "runner:observe:terminal",
    )).resolves.toBe(true);

    expect(terminalizeGeneration).toHaveBeenCalledTimes(1);
    expect(terminalizeGeneration).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "caller-session",
      idempotencyKey: "runner:observe:terminal",
      taskId: "background-agent",
      sdkSessionId: "sdk-session",
      initiatingToolUseId: "toolu-background-agent",
      status: "completed",
    }));
  });
});

describe("ClaudeBackgroundTaskLifecycle dead-runner recovery", () => {
  it("terminalizes only active rows owned by the proven-dead runner session", async () => {
    const target = row("session-dead", "task-a");
    const other = row("session-live", "task-b");
    const activeGenerationsForSession = vi.fn()
      .mockResolvedValueOnce([target])
      .mockResolvedValueOnce([]);
    const terminalizeGeneration = vi.fn(async () => ({
      accepted: true as const,
      row: { ...target, status: "killed" as const },
      delivery: { delivery_id: "delivery-a" },
    }));
    const lifecycle = new ClaudeBackgroundTaskLifecycle({
      repository: { activeGenerationsForSession, terminalizeGeneration } as never,
      sourceNode: "node-a",
      now: () => new Date("2026-09-03T05:36:28.000Z"),
    });

    await expect(
      lifecycle.terminalizeDeadRunner("session-dead"),
    ).resolves.toBe(1);

    expect(activeGenerationsForSession).toHaveBeenCalledTimes(2);
    expect(activeGenerationsForSession).toHaveBeenCalledWith("node-a", "session-dead");
    expect(terminalizeGeneration).toHaveBeenCalledOnce();
    expect(terminalizeGeneration).toHaveBeenCalledWith(expect.objectContaining({
      sourceNode: "node-a",
      sessionId: "session-dead",
      taskId: "task-a",
      status: "killed",
      closeReason: "runner_dead",
    }));
    expect(terminalizeGeneration).not.toHaveBeenCalledWith(expect.objectContaining({
      sessionId: other.session_id,
    }));
  });
});

function row(sessionId: string, taskId: string): ClaudeBackgroundTaskGenerationRow {
  return {
    source_node: "node-a",
    session_id: sessionId,
    task_id: taskId,
    sdk_session_id: "sdk-a",
    initiating_tool_use_id: `toolu-${taskId}`,
    generation_sequence: 1,
    generation_key: `generation-${taskId}`,
    relation_key: `relation-${taskId}`,
    completion_id: `completion-${taskId}`,
    status: "running",
    close_reason: null,
    description: "long work",
    summary: null,
    output_file: null,
    terminal_revision: null,
    notification_delivery_id: null,
    created_at: new Date("2026-09-03T05:36:13.000Z"),
    updated_at: new Date("2026-09-03T05:36:13.000Z"),
    terminal_at: null,
  };
}

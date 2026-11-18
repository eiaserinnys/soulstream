import { describe, expect, it, vi } from "vitest";

import type { ClaudeBackgroundTaskGenerationRow } from
  "../../src/control_plane/persistence_host_clients.js";
import { attachClaudeBackgroundProvenance } from
  "../../src/engine/claude_background_provenance.js";
import { readClaudeBackgroundDeliveryMetadata } from
  "../../src/engine/claude_background_delivery_metadata.js";
import type { ClaudeClientEvent } from "../../src/engine/claude_client_event.js";
import { ClaudeBackgroundGenerationHostClient } from
  "../../src/control_plane/claude_background_generation_host_client.js";
import {
  PersistenceHostRequestError,
  PersistenceHostTransport,
} from "../../src/control_plane/persistence_host_transport.js";
import { ClaudeBackgroundTaskLifecycle } from
  "../../src/task/claude_background_task_lifecycle.js";

describe("ClaudeBackgroundTaskLifecycle provenance boundary", () => {
  it("resolves the sole existing generation when terminal task_updated omits tool_use_id", async () => {
    const resolved = row("caller-session", "background-agent");
    const terminalizeGeneration = vi.fn(async () => ({
      accepted: true as const,
      row: { ...resolved, status: "completed" as const },
      delivery: {
        delivery_id: "delivery-background-agent",
        completion_id: resolved.completion_id,
        relation_key: resolved.relation_key,
        producer_terminal_revision: "1785081600000",
        created_at: new Date("2026-07-27T00:00:00.000Z"),
        source: "claude_runtime_task_followup",
        payload: { text: "done", user: "system" },
        payload_hash: "hash-background-agent",
      },
    }));
    const resolveGeneration = vi.fn(async () => ({ status: "resolved", row: resolved }));
    const lifecycle = new ClaudeBackgroundTaskLifecycle({
      repository: { resolveGeneration, terminalizeGeneration } as never,
      sourceNode: "node-a",
      now: () => new Date("2026-07-27T00:00:00.000Z"),
    });
    const event: ClaudeClientEvent = {
      type: "claude_runtime_task_updated",
      taskId: "background-agent",
      sessionId: "sdk-a",
      patch: { status: "completed", end_time: 1785081600 },
    };
    attachClaudeBackgroundProvenance(event, "sdk_membership");

    await expect(lifecycle.observe("caller-session", event)).resolves.toBe(true);

    expect(resolveGeneration).toHaveBeenCalledWith(
      "node-a", "caller-session", "sdk-a", "background-agent",
    );
    expect(terminalizeGeneration).toHaveBeenCalledWith(expect.objectContaining({
      initiatingToolUseId: "toolu-background-agent",
    }));
    expect(readClaudeBackgroundDeliveryMetadata(event)).toMatchObject({
      initiatingToolUseId: "toolu-background-agent",
    });
  });

  it.each(["absent", "ambiguous"] as const)(
    "leaves an unresolved %s terminal event raw without generation mutation",
    async (status) => {
      const terminalizeGeneration = vi.fn();
      const lifecycle = new ClaudeBackgroundTaskLifecycle({
        repository: {
          resolveGeneration: vi.fn(async () => ({ status })),
          terminalizeGeneration,
        } as never,
        sourceNode: "node-a",
      });
      const event: ClaudeClientEvent = {
        type: "claude_runtime_task_updated",
        taskId: "background-agent",
        sessionId: "sdk-a",
        patch: { status: "completed" },
      };
      attachClaudeBackgroundProvenance(event, "sdk_membership");

      await expect(lifecycle.observe("caller-session", event)).resolves.toBe(true);
      expect(terminalizeGeneration).not.toHaveBeenCalled();
      expect(readClaudeBackgroundDeliveryMetadata(event)).toBeUndefined();
    },
  );

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

  it("leaves the turn live when terminalize is rejected by an execution owner conflict", async () => {
    const conflict = new PersistenceHostRequestError(
      "claude-runtime",
      "terminalize_background_generation",
      "claude-runtime host terminalize_background_generation failed: Claude background execution owner conflict: generation-background-agent stored=registration-a/command-a requested=registration-b/command-b",
      409,
      { code: "CLAUDE_BACKGROUND_EXECUTION_OWNER_CONFLICT" },
    );
    const terminalizeGeneration = vi.fn().mockRejectedValue(conflict);
    const error = vi.fn();
    const lifecycle = new ClaudeBackgroundTaskLifecycle({
      repository: { observeGeneration: vi.fn(), terminalizeGeneration } as never,
      sourceNode: "node-test",
      logger: { warn: vi.fn(), error },
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

    await expect(lifecycle.observe("caller-session", event, "runner:observe:terminal", {
      registrationId: "registration-b",
      executionCommandId: "command-b",
    })).resolves.toBe(false);

    expect(terminalizeGeneration).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[1]).toBe(
      "Claude background generation terminalize rejected by owner conflict; leaving the turn live",
    );
    expect(error.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "caller-session",
      runnerRegistrationId: "registration-b",
      executionCommandId: "command-b",
      initiatingToolUseId: "toolu-background-agent",
      taskId: "background-agent",
    });
    expect((error.mock.calls[0]?.[0] as { err?: unknown }).err).toBe(conflict);
    expect(readClaudeBackgroundDeliveryMetadata(event)).toBeUndefined();
  });

  it.each([
    ["a 500 host failure", new PersistenceHostRequestError(
      "claude-runtime", "terminalize_background_generation", "host failed", 500,
    )],
    ["a 409 with another code", new PersistenceHostRequestError(
      "claude-runtime", "terminalize_background_generation", "other conflict", 409,
      { code: "OTHER_CODE" },
    )],
  ])("still throws %s from the terminal path", async (_label, failure) => {
    const terminalizeGeneration = vi.fn().mockRejectedValue(failure);
    const error = vi.fn();
    const lifecycle = new ClaudeBackgroundTaskLifecycle({
      repository: { observeGeneration: vi.fn(), terminalizeGeneration } as never,
      sourceNode: "node-test",
      logger: { warn: vi.fn(), error },
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

    await expect(lifecycle.observe("caller-session", event, "runner:observe:terminal", {
      registrationId: "registration-b",
      executionCommandId: "command-b",
    })).rejects.toBe(failure);

    expect(terminalizeGeneration).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });

  it("logs one failed observation and leaves the turn live", async () => {
    const observeGeneration = vi.fn()
      .mockRejectedValue(new Error("502 Bad Gateway"));
    const warn = vi.fn();
    const lifecycle = new ClaudeBackgroundTaskLifecycle({
      repository: { observeGeneration } as never,
      sourceNode: "node-test",
      logger: { warn, error: vi.fn() },
    });
    const event: ClaudeClientEvent = {
      type: "claude_runtime_task_progress",
      taskId: "background-agent",
      sessionId: "sdk-session",
      toolUseId: "toolu-background-agent",
      description: "long work",
      summary: "still running",
    };
    attachClaudeBackgroundProvenance(event, "sdk_membership");

    await expect(lifecycle.observe("caller-session", event)).resolves.toBe(true);

    expect(observeGeneration).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("continues after a non-retryable observation failure", async () => {
    const observeGeneration = vi.fn().mockRejectedValue(new Error("schema mismatch"));
    const warn = vi.fn();
    const lifecycle = new ClaudeBackgroundTaskLifecycle({
      repository: { observeGeneration } as never,
      sourceNode: "node-test",
      logger: { warn, error: vi.fn() },
    });
    const event: ClaudeClientEvent = {
      type: "claude_runtime_task_progress",
      taskId: "background-agent",
      sessionId: "sdk-session",
      toolUseId: "toolu-background-agent",
      description: "long work",
      summary: "still running",
    };
    attachClaudeBackgroundProvenance(event, "sdk_membership");

    await expect(lifecycle.observe("caller-session", event)).resolves.toBe(true);

    expect(observeGeneration).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("aborts hung observe requests quickly and leaves the turn live", async () => {
    const timeoutCalls: number[] = [];
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((timeoutMs) => {
      timeoutCalls.push(timeoutMs);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 5);
      return controller.signal;
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("observe request did not receive an abort signal"));
          return;
        }
        const rejectAborted = () => reject(new DOMException("aborted", "AbortError"));
        if (signal.aborted) {
          rejectAborted();
          return;
        }
        signal.addEventListener("abort", rejectAborted, { once: true });
      }),
    );
    const transportLogger = { warn: vi.fn(), info: vi.fn() };
    const lifecycleLogger = { warn: vi.fn(), error: vi.fn() };
    const hostClient = new ClaudeBackgroundGenerationHostClient(
      new PersistenceHostTransport({
        orch: { baseUrl: "http://orch.test", headers: {} },
        logger: transportLogger as never,
      }),
      [1, 1],
    );
    const lifecycle = new ClaudeBackgroundTaskLifecycle({
      repository: {
        observeGeneration: (params: never) => hostClient.observe(params),
      } as never,
      sourceNode: "node-test",
      logger: lifecycleLogger,
    });
    const event: ClaudeClientEvent = {
      type: "claude_runtime_task_progress",
      taskId: "background-agent",
      sessionId: "sdk-session",
      toolUseId: "toolu-background-agent",
      description: "long work",
      summary: "still running",
    };
    attachClaudeBackgroundProvenance(event, "sdk_membership");
    const startedAt = Date.now();

    try {
      await expect(lifecycle.observe("caller-session", event)).resolves.toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(timeoutCalls).toEqual([2_000, 2_000, 2_000]);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(lifecycleLogger.warn).toHaveBeenCalledOnce();
    } finally {
      timeoutSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });
});

describe("ClaudeBackgroundTaskLifecycle dead-runner recovery", () => {
  it("closes orphaned rows without deliveries and continues after a row fails", async () => {
    const live = row("live-session", "live");
    const failed = row("gone-session", "failed");
    const orphan = { ...row("gone-session", "orphan"), runner_registration_id: null, execution_command_id: null };
    const activeGenerationsForNode = vi.fn(async () => [live, failed, orphan]);
    const terminalizeGeneration = vi.fn()
      .mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValueOnce({ accepted: true, row: orphan });
    const logger = { warn: vi.fn(), error: vi.fn() };
    const lifecycle = new ClaudeBackgroundTaskLifecycle({
      repository: { activeGenerationsForNode, terminalizeGeneration } as never,
      sourceNode: "node-a", logger,
    });
    const updatedBefore = new Date("2026-09-03T05:36:28.000Z");

    await expect(lifecycle.terminalizeOrphanedForNode({
      liveSessionIds: new Set(["live-session"]), updatedBefore, limit: 100,
    })).resolves.toEqual({ queried: 3, closed: 1, skippedLive: 1, failed: 1 });
    expect(activeGenerationsForNode).toHaveBeenCalledWith({ sourceNode: "node-a", updatedBefore, limit: 100 });
    expect(terminalizeGeneration).toHaveBeenCalledTimes(2);
    expect(terminalizeGeneration).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: "gone-session", taskId: "orphan", status: "killed",
      closeReason: "runner_missing", terminalRevision: "runner-missing:generation-orphan",
    }));
    expect(terminalizeGeneration.mock.calls[1]![0]).not.toHaveProperty("delivery");
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it("terminalizes only rows owned by the exact dead execution and is re-entry idempotent", async () => {
    const target = row("session-shared", "task-a", "registration-dead", "command-dead");
    const successor = row("session-shared", "task-b", "registration-live", "command-live");
    const activeGenerationsForExecution = vi.fn()
      .mockResolvedValueOnce([target])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const terminalizeGeneration = vi.fn(async () => ({
      accepted: true as const,
      row: { ...target, status: "killed" as const },
      delivery: { delivery_id: "delivery-a" },
    }));
    const lifecycle = new ClaudeBackgroundTaskLifecycle({
      repository: { activeGenerationsForExecution, terminalizeGeneration } as never,
      sourceNode: "node-a",
      now: () => new Date("2026-09-03T05:36:28.000Z"),
    });

    await expect(
      lifecycle.terminalizeDeadRunner("session-shared", {
        registrationId: "registration-dead",
        executionCommandId: "command-dead",
      }),
    ).resolves.toBe(1);
    await expect(
      lifecycle.terminalizeDeadRunner("session-shared", {
        registrationId: "registration-dead",
        executionCommandId: "command-dead",
      }),
    ).resolves.toBe(0);

    expect(activeGenerationsForExecution).toHaveBeenCalledTimes(3);
    expect(activeGenerationsForExecution).toHaveBeenCalledWith(
      "node-a",
      "session-shared",
      "registration-dead",
      "command-dead",
    );
    expect(terminalizeGeneration).toHaveBeenCalledOnce();
    expect(terminalizeGeneration).toHaveBeenCalledWith(expect.objectContaining({
      sourceNode: "node-a",
      sessionId: "session-shared",
      taskId: "task-a",
      status: "killed",
      closeReason: "runner_dead",
    }));
    expect(terminalizeGeneration).not.toHaveBeenCalledWith(expect.objectContaining({
      taskId: successor.task_id,
    }));
  });
});

function row(
  sessionId: string,
  taskId: string,
  runnerRegistrationId = "registration-a",
  executionCommandId = "command-a",
): ClaudeBackgroundTaskGenerationRow {
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
    runner_registration_id: runnerRegistrationId,
    execution_command_id: executionCommandId,
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

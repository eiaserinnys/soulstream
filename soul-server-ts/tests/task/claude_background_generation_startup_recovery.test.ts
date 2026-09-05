import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";

import { ClaudeRuntimeStartupRecovery } from
  "../../src/runtime/claude_runtime_startup_recovery.js";
import { ClaudeBackgroundGenerationStartupRecovery } from
  "../../src/task/claude_background_generation_startup_recovery.js";

describe("Claude background generation upgrade recovery", () => {
  it("uses the real startup owner to recover one exact native B notification once", async () => {
    const observe = vi.fn(async () => true);
    const generationRecovery = new ClaudeBackgroundGenerationStartupRecovery({
      repository: {
        terminalForNode: vi.fn(async () => [legacyTerminal("toolu-A")]),
        getGeneration: vi.fn(async () => null),
      } as never,
      lifecycle: { observe } as never,
      recordRelationConsumed: vi.fn(async () => undefined),
      sourceNode: "node-a",
      logger: { error: vi.fn() },
      sessionStore: {} as never,
      getSession: vi.fn(async () => ({
        session_id: "caller-session",
        claude_session_id: "sdk-session",
        agent_id: "claude-agent",
        model_preset: null,
        node_id: "node-a",
      })) as never,
      getAgent: vi.fn(() => ({
        id: "claude-agent",
        backend: "claude",
        workspace_dir: "/workspace/claude",
      })) as never,
      loadMessages: vi.fn(async () => [nativeNotification("toolu-B")]),
    });
    const queued = vi.fn(async () => ({ claimed: 0, settled: 0 }));
    const startup = new ClaudeRuntimeStartupRecovery({
      recoverBackgroundGenerations: () => generationRecovery.recoverAfterNodeRestart(),
      recoverQueuedDeliveries: queued,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      nodeId: "node-a",
    });

    await startup.afterRunnerRecovery();
    await startup.afterRunnerRecovery();

    expect(observe).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledWith(
      "caller-session",
      expect.objectContaining({
        type: "claude_runtime_task_notification",
        taskId: "shared-task",
        sessionId: "sdk-session",
        toolUseId: "toolu-B",
        status: "completed",
      }),
      "upgrade-native-task-notification:native-B",
    );
    expect(queued).toHaveBeenCalledOnce();
  });

  it("abstains when the native transcript has zero or multiple initiating tool ids", async () => {
    for (const messages of [
      [] as SessionMessage[],
      [nativeNotification("toolu-B"), nativeNotification("toolu-C", "native-C")],
    ]) {
      const observe = vi.fn(async () => true);
      const recovery = new ClaudeBackgroundGenerationStartupRecovery({
        repository: {
          terminalForNode: vi.fn(async () => [legacyTerminal("toolu-A")]),
          getGeneration: vi.fn(async () => null),
        } as never,
        lifecycle: { observe } as never,
        recordRelationConsumed: vi.fn(async () => undefined),
        sourceNode: "node-a",
        logger: { error: vi.fn() },
        sessionStore: {} as never,
        getSession: vi.fn(async () => ({
          session_id: "caller-session",
          claude_session_id: "sdk-session",
          agent_id: "claude-agent",
          model_preset: null,
          node_id: "node-a",
        })) as never,
        getAgent: vi.fn(() => ({
          id: "claude-agent",
          backend: "claude",
          workspace_dir: "/workspace/claude",
        })) as never,
        loadMessages: vi.fn(async () => messages),
      });

      await expect(recovery.recoverAfterNodeRestart()).resolves.toMatchObject({
        recovered: 0,
      });
      expect(observe).not.toHaveBeenCalled();
    }
  });

  it("uses the first terminal envelope per exact task/tool identity and ignores nested output status", async () => {
    const observe = vi.fn(async () => true);
    const recovery = new ClaudeBackgroundGenerationStartupRecovery({
      repository: {
        terminalForNode: vi.fn(async () => [legacyTerminal("toolu-A")]),
        getGeneration: vi.fn(async () => null),
      } as never,
      lifecycle: { observe } as never,
      recordRelationConsumed: vi.fn(async () => undefined),
      sourceNode: "node-a",
      logger: { error: vi.fn() },
      sessionStore: {} as never,
      getSession: vi.fn(async () => ({
        session_id: "caller-session",
        claude_session_id: "sdk-session",
        agent_id: "claude-agent",
        model_preset: null,
        node_id: "node-a",
      })) as never,
      getAgent: vi.fn(() => ({
        id: "claude-agent",
        backend: "claude",
        workspace_dir: "/workspace/claude",
      })) as never,
      loadMessages: vi.fn(async () => [
        nativeNotificationWithNestedStatus("toolu-B", "stopped", "native-B-stopped"),
        nativeNotificationWithNestedStatus("toolu-B", "completed", "native-B-completed"),
      ]),
    });

    await expect(recovery.recoverAfterNodeRestart()).resolves.toMatchObject({
      recovered: 1,
      ambiguous: 0,
    });
    expect(observe).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledWith(
      "caller-session",
      expect.objectContaining({
        taskId: "shared-task",
        toolUseId: "toolu-B",
        status: "stopped",
        summary: "command output <status>running</status>",
      }),
      "upgrade-native-task-notification:native-B-stopped",
    );
  });

  it("does not create a generation when the exact transcript receipt ledger write fails", async () => {
    const observe = vi.fn(async () => true);
    const recordRelationConsumed = vi.fn(async () => {
      throw new Error("ledger unavailable");
    });
    const generationLogger = { error: vi.fn() };
    const generationRecovery = new ClaudeBackgroundGenerationStartupRecovery({
      repository: {
        terminalForNode: vi.fn(async () => [legacyTerminal("toolu-A")]),
        getGeneration: vi.fn(async () => null),
      } as never,
      lifecycle: { observe } as never,
      recordRelationConsumed,
      sourceNode: "node-a",
      logger: generationLogger,
      sessionStore: {} as never,
      getSession: vi.fn(async () => ({
        session_id: "caller-session",
        claude_session_id: "sdk-session",
        agent_id: "claude-agent",
        model_preset: null,
        node_id: "node-a",
      })) as never,
      getAgent: vi.fn(() => ({
        id: "claude-agent",
        backend: "claude",
        workspace_dir: "/workspace/claude",
      })) as never,
      loadMessages: vi.fn(async () => [
        nativeNotification("toolu-B"),
        assistantMessage("assistant-after-B"),
      ]),
    });
    const queued = vi.fn(async () => ({ claimed: 0, settled: 0 }));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const startup = new ClaudeRuntimeStartupRecovery({
      recoverBackgroundGenerations: () => generationRecovery.recoverAfterNodeRestart(),
      recoverQueuedDeliveries: queued,
      logger,
      nodeId: "node-a",
    });

    await expect(startup.afterRunnerRecovery()).resolves.toBeUndefined();
    expect(recordRelationConsumed).toHaveBeenCalledOnce();
    expect(observe).not.toHaveBeenCalled();
    expect(generationLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        sourceNode: "node-a",
        sessionId: "caller-session",
      }),
      "Legacy-lost Claude background generation reconciliation row failed; continuing",
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(queued).toHaveBeenCalledOnce();
  });

  it("isolates a failed legacy row so the next exact generation still recovers once", async () => {
    const failed = {
      ...legacyTerminal("toolu-old-X"),
      session_id: "caller-X",
      task_id: "task-X",
      sdk_session_id: "sdk-X",
    };
    const recoverable = {
      ...legacyTerminal("toolu-old-Y"),
      session_id: "caller-Y",
      task_id: "task-Y",
      sdk_session_id: "sdk-Y",
    };
    const observe = vi.fn(async () => true);
    const recordRelationConsumed = vi.fn(async (input: { callerSessionId: string }) => {
      if (input.callerSessionId === "caller-X") throw new Error("ledger unavailable");
    });
    const generationLogger = { error: vi.fn() };
    const generationRecovery = new ClaudeBackgroundGenerationStartupRecovery({
      repository: {
        terminalForNode: vi.fn(async () => [failed, recoverable]),
        getGeneration: vi.fn(async () => null),
      } as never,
      lifecycle: { observe } as never,
      recordRelationConsumed,
      sourceNode: "node-a",
      logger: generationLogger,
      sessionStore: {} as never,
      getSession: vi.fn(async (sessionId: string) => ({
        session_id: sessionId,
        claude_session_id: sessionId === "caller-X" ? "sdk-X" : "sdk-Y",
        agent_id: "claude-agent",
        model_preset: null,
        node_id: "node-a",
      })) as never,
      getAgent: vi.fn(() => ({
        id: "claude-agent",
        backend: "claude",
        workspace_dir: "/workspace/claude",
      })) as never,
      loadMessages: vi.fn(async (sdkSessionId: string) => [
        nativeNotificationFor(
          sdkSessionId === "sdk-X" ? "task-X" : "task-Y",
          sdkSessionId === "sdk-X" ? "toolu-new-X" : "toolu-new-Y",
          sdkSessionId === "sdk-X" ? "native-X" : "native-Y",
          sdkSessionId,
        ),
        assistantMessageFor(
          sdkSessionId === "sdk-X" ? "assistant-X" : "assistant-Y",
          sdkSessionId,
        ),
      ]),
    });
    const queued = vi.fn(async () => ({ claimed: 0, settled: 0 }));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const startup = new ClaudeRuntimeStartupRecovery({
      recoverBackgroundGenerations: () => generationRecovery.recoverAfterNodeRestart(),
      recoverQueuedDeliveries: queued,
      logger,
      nodeId: "node-a",
    });

    await startup.afterRunnerRecovery();
    await startup.afterRunnerRecovery();

    expect(recordRelationConsumed).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledWith(
      "caller-Y",
      expect.objectContaining({
        taskId: "task-Y",
        sessionId: "sdk-Y",
        toolUseId: "toolu-new-Y",
      }),
      "upgrade-native-task-notification:native-Y",
    );
    expect(generationLogger.error).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
    expect(queued).toHaveBeenCalledOnce();
  });
});

function legacyTerminal(toolUseId: string) {
  return {
    source_node: "node-a",
    session_id: "caller-session",
    task_id: "shared-task",
    sdk_session_id: "sdk-session",
    status: "completed",
    close_reason: "sdk_completed",
    description: null,
    summary: "old A",
    output_file: null,
    tool_use_id: toolUseId,
    terminal_revision: "legacy-A",
    notification_delivery_id: "delivery-A",
    created_at: new Date("2026-09-05T00:00:00.000Z"),
    updated_at: new Date("2026-09-05T00:01:00.000Z"),
    terminal_at: new Date("2026-09-05T00:01:00.000Z"),
  };
}

function nativeNotification(
  toolUseId: string,
  uuid = "native-B",
): SessionMessage {
  return nativeNotificationFor("shared-task", toolUseId, uuid, "sdk-session");
}

function nativeNotificationFor(
  taskId: string,
  toolUseId: string,
  uuid: string,
  sdkSessionId: string,
): SessionMessage {
  return {
    type: "user",
    uuid,
    session_id: sdkSessionId,
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            "<task-notification>",
            `<task-id>${taskId}</task-id>`,
            `<tool-use-id>${toolUseId}</tool-use-id>`,
            "<status>completed</status>",
            "<summary>new B result</summary>",
            "</task-notification>",
          ].join("\n"),
        },
      ],
    },
  };
}

function assistantMessage(uuid: string): SessionMessage {
  return assistantMessageFor(uuid, "sdk-session");
}

function assistantMessageFor(uuid: string, sdkSessionId: string): SessionMessage {
  return {
    type: "assistant",
    uuid,
    session_id: sdkSessionId,
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: { role: "assistant", content: [{ type: "text", text: "continued" }] },
  };
}

function nativeNotificationWithNestedStatus(
  toolUseId: string,
  status: "completed" | "stopped",
  uuid: string,
): SessionMessage {
  return {
    ...nativeNotification(toolUseId, uuid),
    message: {
      role: "user",
      content: [{
        type: "text",
        text: [
          "<task-notification>",
          "<task-id>shared-task</task-id>",
          "<summary>command output &lt;status&gt;running&lt;/status&gt;</summary>",
          `<tool-use-id>${toolUseId}</tool-use-id>`,
          `<status>${status}</status>`,
          "</task-notification>",
        ].join("\n"),
      }],
    },
  };
}

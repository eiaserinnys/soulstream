import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import { attachClaudeBackgroundDeliveryMetadata } from
  "../../src/engine/claude_background_delivery_metadata.js";
import { readClaudeBackgroundProvenance } from
  "../../src/engine/claude_background_provenance.js";
import {
  applyRunnerHostCall,
  createRunnerProcessRuntimeFactory,
} from
  "../../src/runner/runner_process_runtime_factory.js";
import type { RunnerChildConfig } from
  "../../src/runner/runner_process_spawn.js";
import type { RunnerRegistration } from
  "../../src/runner/runner_process_registry.js";
import { RunnerParentOutbox } from "../../src/runner/runner_parent_outbox.js";
import type { Task } from "../../src/task/task_models.js";

describe("createRunnerProcessRuntimeFactory", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pins new runners to the immutable manifest instead of mutable current release", async () => {
    const spawn = vi.fn(async () => {
      throw new Error("captured pinned spawn input");
    });
    const resolveCurrentRelease = vi.fn(async () => ({
      releaseId: "sha-current-other",
      releaseRoot: "/release/sha-current-other",
      runnerModuleRoot: "/release/sha-current-other/soul-server-ts",
    }));
    const describe = vi.fn((releaseId: string) => ({
      releaseId,
      releaseRoot: `/release/${releaseId}`,
      runnerModuleRoot: `/release/${releaseId}/soul-server-ts`,
    }));
    const agent = {
      id: "agent-pinned",
      name: "Pinned Agent",
      backend: "codex",
      workspace_dir: "/workspace/pinned",
    } as AgentProfile;
    const factory = createRunnerProcessRuntimeFactory({
      env: runnerEnv(),
      logger: pino({ level: "silent" }),
      pumpMux: {} as never,
      sessionStore: {} as never,
      mcpConfigService: { resolveMcpProfile: vi.fn(() => null) } as never,
      releasePool: {
        resolveCurrentRelease,
        describe,
        ensureRelease: vi.fn(async () => undefined),
      },
      releaseManifest: {
        manifest_id: "manifest-pinned",
        runner_release_id: "sha-pinned",
      } as never,
      buildChildProcessEnv: () => ({}),
      spawner: { adopt: vi.fn(), spawn },
    });
    const task = {
      agentSessionId: "session-pinned",
      prompt: "start",
      status: "pending",
      executionOwnershipReservation: {
        ownerKind: "runner_process",
        manifestId: "manifest-pinned",
        runtimeEnvIdentity: "runtime-pinned",
        ownershipGeneration: 1,
      },
    } as Task;
    const runtime = factory(task, agent, "codex", {
      persistRunState: vi.fn(async () => undefined),
      persistSessionItems: vi.fn(async () => undefined),
    });

    await expect(runtime.dispatcher.prepareSession("session-pinned"))
      .rejects.toThrow("captured pinned spawn input");
    expect(resolveCurrentRelease).not.toHaveBeenCalled();
    expect(describe).toHaveBeenCalledWith("sha-pinned");
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      codeSha: "sha-pinned",
      releaseManifestId: "manifest-pinned",
      snapshotPath: "/release/sha-pinned/soul-server-ts",
    }));
  });

  it("passes the existing registration to recovery adoption without spawning", async () => {
    const config: RunnerChildConfig = {
      schemaVersion: 1,
      sessionId: "session-adopt",
      backend: "codex",
      agent: {
        id: "agent-adopt",
        name: "Adopt Agent",
        backend: "codex",
        workspace_dir: "/workspace/adopt",
      },
      paths: {
        sessionDirectory: "/runner/session-adopt",
        databasePath: "/runner/session-adopt/runner.sqlite",
        socketPath: "/runner/session-adopt/runner.sock",
        pidPath: "/runner/session-adopt/runner.pid",
        lockPath: "/runner/session-adopt/runner.lock",
        configPath: "/runner/session-adopt/runner-config.json",
        logPath: "/runner/session-adopt/runner.log",
      },
      codeSha: "sha-adopt",
      snapshotPath: "/release/sha-adopt/soul-server-ts",
      codexAdapterMode: "sdk",
      claudeRuntimeV2Enabled: true,
      claudeRuntimeIdleTtlMs: 300_000,
      claudeRuntimeMaxEntries: 16,
      claudeRuntimeTurnTimeoutMs: 1_800_000,
      internalMcpUrl: "http://127.0.0.1:4307/mcp/internal",
      codexHome: "/home/test/.codex",
      rolloutRoot: "/home/test/.codex/sessions",
    };
    const registration: RunnerRegistration = {
      config,
      pid: 6101,
      pidAlive: true,
      registeredAtMs: 1,
      bootstrap: null,
      lifecycle: null,
      registrationId: "registration-adopt",
      pidStartIdentity: "start-6101",
    };
    const adopt = vi.fn(async () => ({
      pid: 6101,
      registrationId: "registration-adopt",
      paths: config.paths,
      config,
      adopted: true,
    }));
    const spawn = vi.fn();
    vi.spyOn(RunnerParentOutbox, "open")
      .mockRejectedValueOnce(new Error("stop after successful adoption"));
    const factory = createRunnerProcessRuntimeFactory({
      env: runnerEnv(),
      logger: pino({ level: "silent" }),
      pumpMux: {} as never,
      sessionStore: {} as never,
      mcpConfigService: { resolveMcpProfile: vi.fn(() => null) } as never,
      releasePool: {
        resolveCurrentRelease: vi.fn(),
        describe: vi.fn(() => ({
          releaseId: "sha-adopt",
          releaseRoot: "/release/sha-adopt",
          runnerModuleRoot: "/release/sha-adopt/soul-server-ts",
        })),
        ensureRelease: vi.fn(async () => undefined),
      },
      buildChildProcessEnv: () => ({}),
      spawner: { adopt, spawn },
    });
    const task = {
      agentSessionId: "session-adopt",
      prompt: "resume",
      status: "pending",
    } as Task;
    const runtime = factory.recover!(task, registration, {
      persistRunState: vi.fn(async () => undefined),
      persistSessionItems: vi.fn(async () => undefined),
    });

    await expect(runtime.dispatcher.prepareSession("session-adopt"))
      .rejects.toThrow("stop after successful adoption");
    expect(adopt).toHaveBeenCalledOnce();
    expect(adopt).toHaveBeenCalledWith(registration);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refreshes runtime MCP settings when restarting a stored runner config", async () => {
    const agent: AgentProfile = {
      id: "agent-a",
      name: "Agent A",
      backend: "codex",
      workspace_dir: "/workspace/a",
      mcp_profile: "runtime-profile",
    };
    const currentResolvedMcpServers = [{
      type: "streamable_http" as const,
      name: "soulstream",
      url: "http://127.0.0.1:4308/mcp",
      headers: { Authorization: "Bearer current" },
    }];
    const spawn = vi.fn(async () => {
      throw new Error("captured restart spawn input");
    });
    const factory = createRunnerProcessRuntimeFactory({
      env: {
        SOUL_RUNNER_STATE_DIR: "/runner",
        SOUL_RUNNER_ARTIFACT_DIR: "/artifacts",
        SOUL_RUNNER_RELEASES_DIR: "/releases",
        SOUL_RUNNER_TERMINAL_RETENTION_MS: 60_000,
        SOUL_RUNNER_LEASE_TIMEOUT_MS: 90_000,
        CODEX_ADAPTER_MODE: "sdk",
        CLAUDE_SESSION_RUNTIME_V2_ENABLED: true,
        CLAUDE_SESSION_RUNTIME_IDLE_TTL_MS: 300_000,
        CLAUDE_SESSION_RUNTIME_MAX_ENTRIES: 16,
        CLAUDE_SESSION_RUNTIME_TURN_TIMEOUT_MS: 1_800_000,
        MCP_INTERNAL_PORT: 4308,
        MCP_PATH: "/mcp",
      },
      logger: pino({ level: "silent" }),
      pumpMux: {} as never,
      sessionStore: {} as never,
      mcpConfigService: {
        resolveMcpProfile: vi.fn(() => ({
          mcp_servers: currentResolvedMcpServers,
          hosted_tools: [],
        })),
      } as never,
      releasePool: {
        resolveCurrentRelease: vi.fn(),
        describe: vi.fn(() => ({
          releaseId: "sha-a",
          releaseRoot: "/release/sha-a",
          runnerModuleRoot: "/release/sha-a/soul-server-ts",
        })),
        ensureRelease: vi.fn(async () => undefined),
      },
      buildChildProcessEnv: () => ({}),
      spawner: { adopt: vi.fn(), spawn },
    });
    const storedConfig: RunnerChildConfig = {
      schemaVersion: 1,
      sessionId: "session-a",
      backend: "codex",
      agent,
      paths: {
        sessionDirectory: "/runner/session-a",
        databasePath: "/runner/session-a/runner.sqlite",
        socketPath: "/runner/session-a/runner.sock",
        pidPath: "/runner/session-a/runner.pid",
        lockPath: "/runner/session-a/runner.lock",
        configPath: "/runner/session-a/runner-config.json",
        logPath: "/runner/session-a/runner.log",
      },
      codeSha: "sha-a",
      releaseManifestId: "manifest-old",
      runtimeEnvIdentity: "runtime-env-old",
      snapshotPath: "/release/sha-a/soul-server-ts",
      codexAdapterMode: "sdk",
      claudeRuntimeV2Enabled: true,
      claudeRuntimeIdleTtlMs: 300_000,
      claudeRuntimeMaxEntries: 16,
      claudeRuntimeTurnTimeoutMs: 1_800_000,
      internalMcpUrl: "http://127.0.0.1:4307/mcp/internal",
      resolvedMcpServers: [{
        type: "streamable_http",
        name: "soulstream",
        url: "http://127.0.0.1:4306/mcp",
        headers: { Authorization: "Bearer stale" },
      }],
      codexHome: "/home/test/.codex",
      rolloutRoot: "/home/test/.codex/sessions",
    };
    const task = {
      agentSessionId: "session-a",
      prompt: "resume",
      status: "pending",
    } as Task;
    const runtime = factory.restart!(task, storedConfig, {
      persistRunState: vi.fn(async () => undefined),
      persistSessionItems: vi.fn(async () => undefined),
    });

    await expect(runtime.dispatcher.prepareSession("session-a"))
      .rejects.toThrow("captured restart spawn input");
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      codeSha: "sha-a",
      releaseManifestId: "manifest-old",
      runtimeEnvIdentity: "runtime-env-old",
      snapshotPath: "/release/sha-a/soul-server-ts",
      internalMcpUrl: "http://127.0.0.1:4308/mcp/internal",
      resolvedMcpServers: currentResolvedMcpServers,
    }));
  });
});

function runnerEnv() {
  return {
    SOUL_RUNNER_STATE_DIR: "/runner",
    SOUL_RUNNER_ARTIFACT_DIR: "/artifacts",
    SOUL_RUNNER_RELEASES_DIR: "/releases",
    SOUL_RUNNER_TERMINAL_RETENTION_MS: 60_000,
    SOUL_RUNNER_LEASE_TIMEOUT_MS: 90_000,
    CODEX_ADAPTER_MODE: "sdk" as const,
    CLAUDE_SESSION_RUNTIME_V2_ENABLED: true,
    CLAUDE_SESSION_RUNTIME_IDLE_TTL_MS: 300_000,
    CLAUDE_SESSION_RUNTIME_MAX_ENTRIES: 16,
    CLAUDE_SESSION_RUNTIME_TURN_TIMEOUT_MS: 1_800_000,
    MCP_INTERNAL_PORT: 4308,
    MCP_PATH: "/mcp",
  };
}

describe("applyRunnerHostCall", () => {
  it("threads correlation to all six mutating owner operations", async () => {
    const sessionStore = {
      appendIdempotent: vi.fn(async () => undefined),
      deleteIdempotent: vi.fn(async () => undefined),
    };
    const snapshots = {
      persistRunState: vi.fn(async () => undefined),
      persistSessionItems: vi.fn(async () => undefined),
    };
    const observeClaudeRuntime = vi.fn(async () => true);
    const publishDetachedClaudeEvent = vi.fn(async () => undefined);
    const options = {
      sessionStore,
      observeClaudeRuntime,
      publishDetachedClaudeEvent,
    } as never;
    const key = { projectKey: "project-a", sessionId: "sdk-session-a" };
    const entries = [{ type: "user", message: { content: "hello" } }];
    const event = { type: "text", text: "hello", timestamp: 1 };
    const calls = [
      { service: "session_store" as const, operation: "append", args: [key, entries] },
      { service: "session_store" as const, operation: "delete", args: [key] },
      {
        service: "snapshot" as const,
        operation: "persistRunState",
        args: ["session-a", { backendId: "openai-agents", serialized: "state" }],
      },
      {
        service: "snapshot" as const,
        operation: "persistSessionItems",
        args: ["session-a", { backendId: "openai-agents", items: [] }],
      },
      { service: "claude_runtime" as const, operation: "observe", args: ["session-a", event] },
      { service: "detached_event" as const, operation: "publish", args: ["session-a", event] },
    ];

    for (const [index, call] of calls.entries()) {
      await applyRunnerHostCall(
        { ...call, correlationId: `host:${index}` },
        "session-a",
        snapshots,
        options,
      );
    }

    expect(sessionStore.appendIdempotent).toHaveBeenCalledWith(
      key,
      entries,
      "host:0",
      "session-a",
    );
    expect(sessionStore.deleteIdempotent).toHaveBeenCalledWith(
      key,
      "host:1",
      "session-a",
    );
    expect(snapshots.persistRunState).toHaveBeenCalledWith(
      { backendId: "openai-agents", serialized: "state" },
      "host:2",
    );
    expect(snapshots.persistSessionItems).toHaveBeenCalledWith(
      { backendId: "openai-agents", items: [] },
      "host:3",
    );
    expect(observeClaudeRuntime).toHaveBeenCalledWith("session-a", event, "host:4");
    expect(publishDetachedClaudeEvent).toHaveBeenCalledWith("session-a", event, "host:5");
  });

  it("restores process-local Claude metadata before an observational host call", async () => {
    const delivery = {
      deliveryId: "delivery-1",
      completionId: "completion-1",
      relationKey: "claude_runtime:session-a:task-1",
      producerTerminalRevision: "terminal-1",
      deliveryCreatedAt: "2026-08-22T00:00:00.000Z",
      source: "claude_runtime_background_task_followup",
      storedPayload: { followup_task_ids: ["task-1"] },
      storedPayloadHash: "payload-hash-1",
    };
    const observeClaudeRuntime = vi.fn(async (_sessionId, event: object) => {
      expect(readClaudeBackgroundProvenance(event)).toBe("sdk_membership");
      attachClaudeBackgroundDeliveryMetadata(event, delivery);
      return true;
    });

    const result = await applyRunnerHostCall(
      {
        service: "claude_runtime",
        operation: "observe",
        args: [
          "session-a",
          { type: "claude_runtime_task_updated", taskId: "task-1", patch: {} },
          { claudeBackgroundProvenance: "sdk_membership" },
        ],
        correlationId: "host:metadata",
      },
      "session-a",
      {
        persistRunState: vi.fn(async () => undefined),
        persistSessionItems: vi.fn(async () => undefined),
      },
      {
        sessionStore: {},
        observeClaudeRuntime,
      } as never,
    );

    expect(observeClaudeRuntime).toHaveBeenCalledOnce();
    expect(result).toEqual({
      accepted: true,
      claudeBackgroundDelivery: delivery,
    });
  });
});

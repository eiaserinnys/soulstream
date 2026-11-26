import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "@soulstream/agent-profile-contract";
import { attachClaudeBackgroundDeliveryMetadata } from
  "../../src/engine/claude_background_delivery_metadata.js";
import { readClaudeBackgroundProvenance } from
  "../../src/engine/claude_background_provenance.js";
import {
  applyRunnerHostCall,
  createRunnerProcessRuntimeFactory,
  RunnerNotAliveError,
} from
  "../../src/runner/runner_process_runtime_factory.js";
import {
  type RunnerChildConfig,
  parseRunnerChildConfig,
} from "../../src/runner/runner_process_spawn.js";
import type { RunnerRegistration } from
  "../../src/runner/runner_process_registry.js";
import { RunnerParentOutbox } from "../../src/runner/runner_parent_outbox.js";
import { createRunnerPhaseObservation } from
  "../../src/runner/runner_phase_observation.js";
import type { Task } from "../../src/task/task_models.js";

describe("createRunnerProcessRuntimeFactory", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the Claude account pool contract and root to new Claude runners", async () => {
    const spawn = vi.fn(async () => {
      throw new Error("captured pool runner config");
    });
    const factory = createRunnerProcessRuntimeFactory({
      env: {
        ...runnerEnv(),
        CLAUDE_ACCOUNT_POOL_ENABLED: true,
        CLAUDE_ACCOUNTS_DIR: "/worker/claude-accounts",
      },
      logger: pino({ level: "silent" }),
      pumpMux: {} as never,
      claudeAccounts: {
        select: vi.fn(),
        reject: vi.fn(),
        reportAuthFailure: vi.fn(async () => undefined),
        release: vi.fn(),
      },
      mcpConfigService: { resolveMcpProfile: vi.fn(() => null) } as never,
      releasePool: {
        resolveCurrentRelease: vi.fn(async () => ({
          releaseId: "sha-pool",
          releaseRoot: "/release/sha-pool",
          runnerModuleRoot: "/release/sha-pool/soul-server-ts",
        })),
        describe: vi.fn(),
        ensureRelease: vi.fn(async () => undefined),
      },
      buildChildProcessEnv: () => ({}),
      spawner: { adopt: vi.fn(), spawn },
    });
    const task = {
      agentSessionId: "session-pool",
      prompt: "start",
      status: "initializing",
      createdAt: new Date(),
      lastEventId: 0,
      lastReadEventId: 0,
      interventionQueue: [],
    } as Task;
    const runtime = factory(task, {
      id: "agent-pool",
      name: "Pool Agent",
      backend: "claude",
      workspace_dir: "/workspace/pool",
    } as AgentProfile, "claude");

    await expect(runtime.dispatcher.prepareSession("session-pool"))
      .rejects.toThrow("captured pool runner config");
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      claudeAccountPool: {
        enabled: true,
        accountsDir: "/worker/claude-accounts",
      },
    }));
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
      status: "initializing",
      createdAt: new Date(),
      lastEventId: 0,
      lastReadEventId: 0,
      interventionQueue: [],
    } as Task;
    const runtime = factory(task, agent, "codex");

    await expect(runtime.dispatcher.prepareSession("session-pinned"))
      .rejects.toThrow("captured pinned spawn input");
    expect(resolveCurrentRelease).not.toHaveBeenCalled();
    expect(describe).toHaveBeenCalledWith("sha-pinned");
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      codeSha: "sha-pinned",
      releaseManifestId: "manifest-pinned",
      snapshotPath: "/release/sha-pinned/soul-server-ts",
      codexDetachedResultRetentionMs: 120_000,
      codexAppServerRequestTimeoutMs: 45_000,
      codexAppServerStartupTimeoutMs: 135_000,
      incomingFileDir: "/incoming",
    }));
  });

  it("forwards OPENCODE_CLI_PATH into only the OpenCode runner child config", async () => {
    const spawn = vi.fn(async () => {
      throw new Error("captured opencode spawn input");
    });
    const agent = {
      id: "agent-opencode",
      name: "OpenCode Agent",
      backend: "claude",
      workspace_dir: "/workspace/opencode",
    } as AgentProfile;
    const factory = createRunnerProcessRuntimeFactory({
      env: { ...runnerEnv(), OPENCODE_CLI_PATH: "/opt/opencode" },
      logger: pino({ level: "silent" }),
      pumpMux: {} as never,
      mcpConfigService: { resolveMcpProfile: vi.fn(() => null) } as never,
      releasePool: {
        resolveCurrentRelease: vi.fn(async () => ({
          releaseId: "sha-opencode",
          releaseRoot: "/release/sha-opencode",
          runnerModuleRoot: "/release/sha-opencode/soul-server-ts",
        })),
        describe: vi.fn(),
        ensureRelease: vi.fn(async () => undefined),
      },
      buildChildProcessEnv: () => ({}),
      spawner: { adopt: vi.fn(), spawn },
    });
    const task = {
      agentSessionId: "session-opencode",
      prompt: "start",
      status: "initializing",
      createdAt: new Date(),
      lastEventId: 0,
      lastReadEventId: 0,
      interventionQueue: [],
    } as Task;
    const runtime = factory(task, agent, "opencode");

    await expect(runtime.dispatcher.prepareSession("session-opencode"))
      .rejects.toThrow("captured opencode spawn input");
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      backend: "opencode",
      opencodeCliPath: "/opt/opencode",
    }));
  });

  it("passes the existing registration to recovery adoption without spawning", async () => {
    const registration = adoptionRegistration();
    const { config } = registration;
    expect(config.codexDetachedResultRetentionMs).toBe(1_800_000);
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
      status: "initializing",
      createdAt: new Date(),
      lastEventId: 0,
      lastReadEventId: 0,
      interventionQueue: [],
    } as Task;
    const phaseObservation = createRunnerPhaseObservation({
      nodeId: "node-test",
      scopeId: "recovery-test",
      operation: "runnerRecovery.scan",
      logger: { warn: vi.fn() },
    });
    const runtime = factory.recover!(task, registration, "adopt", phaseObservation);
    expect((runtime.dispatcher as unknown as {
      options: {
        spawn: { codexDetachedResultRetentionMs: number };
      };
    }).options.spawn).toMatchObject({
      codexDetachedResultRetentionMs: 1_800_000,
      codexAppServerRequestTimeoutMs: 45_000,
      codexAppServerStartupTimeoutMs: 600_000,
    });

    await expect(runtime.dispatcher.prepareSession("session-adopt"))
      .rejects.toThrow("stop after successful adoption");
    expect((runtime.dispatcher as unknown as {
      options: { phaseObservation?: unknown };
    }).options.phaseObservation).toBe(phaseObservation);
    expect(adopt).toHaveBeenCalledOnce();
    expect(adopt).toHaveBeenCalledWith(registration);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports an adoption whose registered runner is gone as RunnerNotAliveError", async () => {
    const registration = adoptionRegistration();
    const factory = createRunnerProcessRuntimeFactory({
      env: runnerEnv(),
      logger: pino({ level: "silent" }),
      pumpMux: {} as never,
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
      spawner: { adopt: vi.fn(async () => null), spawn: vi.fn() },
    });
    const task = {
      agentSessionId: "session-adopt",
      prompt: "resume",
      status: "initializing",
      createdAt: new Date(),
      lastEventId: 0,
      lastReadEventId: 0,
      interventionQueue: [],
    } as Task;
    const runtime = factory.recover!(task, registration, "adopt");

    const failure = await runtime.dispatcher.prepareSession("session-adopt")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RunnerNotAliveError);
    expect(failure).toMatchObject({
      name: "RunnerNotAliveError",
      message: "registered runner is not alive: session-adopt",
    });
  });

});

function adoptionRegistration(): RunnerRegistration {
  const config: RunnerChildConfig = parseRunnerChildConfig({
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
    codexAppServerRequestTimeoutMs: 45_000,
    codexAppServerStartupTimeoutMs: 600_000,
    claudeRuntimeV2Enabled: true,
    claudeRuntimeIdleTtlMs: 300_000,
    claudeRuntimeMaxEntries: 16,
    claudeRuntimeTurnTimeoutMs: 1_800_000,
    internalMcpUrl: "http://127.0.0.1:4307/mcp/internal",
    codexHome: "/home/test/.codex",
    rolloutRoot: "/home/test/.codex/sessions",
  });
  return {
    config,
    pid: 6101,
    pidAlive: true,
    registeredAtMs: 1,
    bootstrap: null,
    lifecycle: null,
    registrationId: "registration-adopt",
    pidStartIdentity: "start-6101",
  };
}

function runnerEnv() {
  return {
    SOUL_RUNNER_STATE_DIR: "/runner",
    SOUL_RUNNER_ARTIFACT_DIR: "/artifacts",
    SOUL_RUNNER_RELEASES_DIR: "/releases",
    SOUL_RUNNER_TERMINAL_RETENTION_MS: 60_000,
    SOUL_RUNNER_LEASE_TIMEOUT_MS: 90_000,
    INCOMING_FILE_DIR: "/incoming",
    SOULSTREAM_NODE_ID: "node-test",
    CODEX_ADAPTER_MODE: "sdk" as const,
    CLAUDE_SESSION_RUNTIME_V2_ENABLED: true,
    CLAUDE_SESSION_RUNTIME_IDLE_TTL_MS: 300_000,
    CLAUDE_SESSION_RUNTIME_MAX_ENTRIES: 16,
    CLAUDE_SESSION_RUNTIME_TURN_TIMEOUT_MS: 1_800_000,
    CLAUDE_ACCOUNT_POOL_ENABLED: false,
    CLAUDE_ACCOUNTS_DIR: undefined,
    CODEX_DETACHED_RESULT_RETENTION_MS: 120_000,
    CODEX_APP_SERVER_REQUEST_TIMEOUT_MS: 45_000,
    CODEX_APP_SERVER_STARTUP_TIMEOUT_MS: 135_000,
    MCP_INTERNAL_PORT: 4308,
    MCP_PATH: "/mcp",
    OPENCODE_CLI_PATH: undefined,
  };
}

describe("applyRunnerHostCall", () => {
  it("routes Claude account operations through the host service and fences session identity", async () => {
    const account = { account_id: "account-a", config_dir: "/accounts/a", available_count: 1 };
    const service = {
      select: vi.fn(async () => account),
      reject: vi.fn(async () => undefined),
      reportAuthFailure: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const options = { claudeAccounts: service } as never;
    const task = { agentSessionId: "session-a" } as Task;
    const selectInput = {
      session_id: "session-a",
      turn_id: "turn-a",
      model: "claude-sonnet-4.5",
      exclude_ids: [],
    };

    await expect(applyRunnerHostCall({
      service: "claude_accounts",
      operation: "select",
      args: ["session-a", selectInput],
      correlationId: "host:claude-account-select",
    }, task, options)).resolves.toEqual(account);
    await applyRunnerHostCall({
      service: "claude_accounts",
      operation: "reject",
      args: ["session-a", {
        account_id: "account-a",
        scope: "all",
        resets_at: null,
        observed_at: "2026-10-28T00:00:00.000Z",
        session_id: "session-a",
      }],
      correlationId: "host:claude-account-reject",
    }, task, options);
    const authFailure = {
      account_id: "account-a",
      session_id: "session-a",
      observed_at: "2026-10-28T00:00:00.000Z",
    };
    await applyRunnerHostCall({
      service: "claude_accounts",
      operation: "reportAuthFailure",
      args: ["session-a", authFailure],
      correlationId: "host:claude-account-auth-failure",
    }, task, options);
    await applyRunnerHostCall({
      service: "claude_accounts",
      operation: "release",
      args: ["session-a", { session_id: "session-a" }],
      correlationId: "host:claude-account-release",
    }, task, options);
    const turnRelease = { session_id: "session-a", account_id: "account-a", turn_id: "turn-a" };
    await applyRunnerHostCall({
      service: "claude_accounts", operation: "release",
      args: ["session-a", turnRelease], correlationId: "host:claude-turn-release",
    }, task, options);

    expect(service.select).toHaveBeenCalledWith(selectInput);
    expect(service.reject).toHaveBeenCalledOnce();
    expect(service.reportAuthFailure).toHaveBeenCalledWith(authFailure);
    expect(service.release).toHaveBeenCalledWith({ session_id: "session-a" });
    expect(service.release).toHaveBeenCalledWith(turnRelease);
    await expect(applyRunnerHostCall({
      service: "claude_accounts",
      operation: "select",
      args: ["session-other", { ...selectInput, session_id: "session-other" }],
      correlationId: "host:claude-account-wrong-session",
    }, task, options)).rejects.toThrow("runner host session mismatch");
    await expect(applyRunnerHostCall({
      service: "claude_accounts",
      operation: "select",
      args: ["session-a", { ...selectInput, session_id: "session-other" }],
      correlationId: "host:claude-account-wrong-payload-session",
    }, task, options)).rejects.toThrow("runner Claude account request session mismatch");
  });

  it("asks for a restricted credential and substitutes the sandbox config directory", async () => {
    const selection = {
      account_id: "account-a",
      config_dir: "/accounts/a",
      available_count: 2,
      credential: { kind: "access-token" as const, access_token: "token-a" },
    };
    const service = {
      select: vi.fn(async () => selection),
      reject: vi.fn(async () => undefined),
      reportAuthFailure: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const task = { agentSessionId: "session-a" } as Task;
    const selectInput = {
      session_id: "session-a",
      turn_id: "turn-a",
      model: "claude-sonnet-4.5",
      exclude_ids: [],
    };
    const call = {
      service: "claude_accounts" as const,
      operation: "select",
      args: ["session-a", selectInput],
      correlationId: "host:restricted-select",
    };

    await expect(applyRunnerHostCall(
      call,
      task,
      { claudeAccounts: service } as never,
      undefined,
      { configDirectory: "/sandbox/restricted/claude-config" },
    )).resolves.toEqual({
      ...selection,
      config_dir: "/sandbox/restricted/claude-config",
    });

    expect(service.select).toHaveBeenCalledWith(selectInput, {
      requireAccessTokenCredential: true,
    });
    // 요청 필드가 아니라 호스트 내부 옵션이어야 한다.
    expect(selectInput).not.toHaveProperty("requireAccessTokenCredential");
  });

  it("passes restricted pool exhaustion through without inventing a credential", async () => {
    const exhausted = {
      pool_exhausted: true as const,
      available_count: 0 as const,
      earliest_available_at: "2026-11-10T05:00:00.000Z",
    };
    const service = {
      select: vi.fn(async () => exhausted),
      reject: vi.fn(async () => undefined),
      reportAuthFailure: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const task = { agentSessionId: "session-a" } as Task;

    await expect(applyRunnerHostCall({
      service: "claude_accounts",
      operation: "select",
      args: ["session-a", {
        session_id: "session-a",
        turn_id: "turn-a",
        model: "claude-sonnet-4.5",
        exclude_ids: [],
      }],
      correlationId: "host:restricted-exhausted",
    }, task, { claudeAccounts: service } as never, undefined, {
      configDirectory: "/sandbox/restricted/claude-config",
    })).resolves.toEqual(exhausted);
  });

  it("keeps the full selection path free of credential options", async () => {
    const account = { account_id: "account-a", config_dir: "/accounts/a", available_count: 1 };
    const service = {
      select: vi.fn(async () => account),
      reject: vi.fn(async () => undefined),
      reportAuthFailure: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const task = { agentSessionId: "session-a" } as Task;
    const selectInput = {
      session_id: "session-a",
      turn_id: "turn-a",
      model: "claude-sonnet-4.5",
      exclude_ids: [],
    };

    await expect(applyRunnerHostCall({
      service: "claude_accounts",
      operation: "select",
      args: ["session-a", selectInput],
      correlationId: "host:full-select",
    }, task, { claudeAccounts: service } as never)).resolves.toEqual(account);

    expect(service.select).toHaveBeenCalledWith(selectInput);
  });

  it("threads correlation to the mutating host operations", async () => {
    const observeClaudeRuntime = vi.fn(async () => true);
    const publishDetachedClaudeEvent = vi.fn(async () => async () => undefined);
    const options = {
      observeClaudeRuntime,
      publishDetachedClaudeEvent,
    } as never;
    const task = {
      agentSessionId: "session-a",
      executionRegistration: {
        registrationId: "registration-a",
        executionCommandId: "owner-a",
      },
    } as Task;
    const event = { type: "text", text: "hello", timestamp: 1 };
    const calls = [
      { service: "claude_runtime" as const, operation: "observe", args: ["session-a", event] },
      { service: "detached_event" as const, operation: "publish", args: ["session-a", event] },
    ];

    for (const [index, call] of calls.entries()) {
      await applyRunnerHostCall(
        { ...call, correlationId: `host:${index}` },
        task,
        options,
      );
    }

    expect(observeClaudeRuntime).toHaveBeenCalledWith(
      "session-a",
      event,
      "host:0",
      expect.objectContaining({
        registrationId: "registration-a",
        executionCommandId: "owner-a",
      }),
    );
    expect(publishDetachedClaudeEvent).toHaveBeenCalledWith("session-a", event, "host:1");
  });

  it("registers archived runner output with the active task execution context", async () => {
    const descriptor = {
      attachment_id: "attachment-archive",
      name: "tool_result-0123456789abcdef.txt",
      mime_type: "text/plain",
      byte_size: 4,
      checksum_sha256: "a".repeat(64),
      width: null,
      height: null,
      preview_kind: "text",
      preview_mime_type: "text/plain",
    };
    const register = vi.fn(async () => ({
      attachment_id: descriptor.attachment_id,
      descriptor,
    }));
    const task = {
      agentSessionId: "session-a",
      resolvedWorkspaceDir: "/workspace/resolved",
      agentProfileSnapshot: { workspace_dir: "/workspace/profile" },
      runner: {
        engine: { workspaceDir: "/workspace/engine" },
        dispatcher: { activeExecutionCommandId: () => "command-a" },
      },
    } as unknown as Task;
    const options = {
      env: { SOULSTREAM_NODE_ID: "node-a" },
      producedAttachments: { register },
    } as never;
    const call = {
      service: "event_archive",
      operation: "register",
      args: ["/incoming/session-a/archive.txt", "archive.txt", "text/plain"],
      correlationId: "host:event-archive",
    } as never;

    await expect(applyRunnerHostCall(call, task, options)).resolves.toEqual(descriptor);
    expect(register).toHaveBeenCalledWith(
      {
        local_path: "/incoming/session-a/archive.txt",
        name: "archive.txt",
        mime_type: "text/plain",
      },
      {
        sessionId: "session-a",
        nodeId: "node-a",
        outputCommandId: "command-a",
        workspaceDir: "/workspace/resolved",
        profileWorkspaceDir: "/workspace/profile",
      },
      expect.any(AbortSignal),
    );

    const fallbackTask = {
      ...task,
      resolvedWorkspaceDir: undefined,
      runner: {
        engine: { workspaceDir: "/workspace/engine" },
        dispatcher: { activeExecutionCommandId: () => "command-fallback" },
      },
    } as unknown as Task;
    await applyRunnerHostCall(call, fallbackTask, options);
    expect(register).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        sessionId: "session-a",
        nodeId: "node-a",
        outputCommandId: "command-fallback",
        workspaceDir: "/workspace/engine",
      }),
      expect.any(AbortSignal),
    );

    const inactiveTask = {
      ...task,
      runner: { engine: { workspaceDir: "/workspace/engine" }, dispatcher: { activeExecutionCommandId: () => undefined } },
    } as unknown as Task;
    await expect(applyRunnerHostCall(call, inactiveTask, options))
      .rejects.toThrow("ATTACHMENT_ACTIVE_EXECUTION_REQUIRED");
    expect(register).toHaveBeenCalledTimes(2);
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
      { agentSessionId: "session-a" } as Task,
      {
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

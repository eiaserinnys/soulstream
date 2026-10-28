import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyRunnerHostCall, createRunnerProcessRuntimeFactory } from
  "../../src/runner/runner_process_runtime_factory.js";
import { RunnerClaudeAccountTurnStateStore } from
  "../../src/runner/claude_account_turn_state_store.js";
import { parseRunnerChildConfig } from "../../src/runner/runner_child_config.js";
import { RunnerParentOutbox } from "../../src/runner/runner_parent_outbox.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import type { RunnerRegistration } from "../../src/runner/runner_process_registry.js";
import type { Task } from "../../src/task/task_models.js";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("Claude account pool live runner adoption", () => {
  it("restores a pool binding and skips Kimi runners without one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runner-account-adopt-"));
    directories.push(directory);
    const sessionId = "session-adopt-account";
    const databasePath = join(directory, "runner.sqlite");
    const outbox = await RunnerSqliteEventOutbox.create(databasePath);
    outbox.close();
    const state = RunnerClaudeAccountTurnStateStore.open(databasePath, sessionId);
    await state.write({
      turn_id: "turn-live",
      account_id: "account-a",
      attempted_ids: [],
      continuation_uuid: null,
      continuation_sent: false,
    });
    state.close();

    const config = parseRunnerChildConfig({
      schemaVersion: 1,
      sessionId,
      backend: "claude",
      agent: {
        id: "agent-adopt-account",
        name: "Adopt account",
        backend: "claude",
        workspace_dir: "/workspace/adopt-account",
      },
      paths: {
        sessionDirectory: directory,
        databasePath,
        socketPath: join(directory, "runner.sock"),
        pidPath: join(directory, "runner.pid"),
        lockPath: join(directory, "runner.lock"),
        configPath: join(directory, "runner-config.json"),
        logPath: join(directory, "runner.log"),
      },
      codeSha: "sha-account-adopt",
      snapshotPath: "/release/sha-account-adopt/soul-server-ts",
      codexAdapterMode: "sdk",
      claudeRuntimeV2Enabled: false,
      claudeAccountPool: { enabled: true, accountsDir: "/accounts" },
      claudeRuntimeIdleTtlMs: 300_000,
      claudeRuntimeMaxEntries: 16,
      claudeRuntimeTurnTimeoutMs: 1_800_000,
      internalMcpUrl: "http://127.0.0.1:4308/mcp/internal",
      codexHome: null,
      rolloutRoot: null,
    });
    const registration: RunnerRegistration = {
      config,
      pid: 6101,
      pidAlive: true,
      registeredAtMs: 1,
      bootstrap: null,
      lifecycle: null,
      registrationId: "registration-account-adopt",
      pidStartIdentity: "start-6101",
    };
    const adopted = {
      pid: 6101,
      registrationId: "registration-account-adopt",
      paths: config.paths,
      config,
      adopted: true,
    };
    const adopt = vi.fn(async () => adopted);
    const spawn = vi.fn();
    const restoredBindings = new Map<string, string>();
    const claudeAccounts = {
      select: vi.fn(),
      reject: vi.fn(),
      release: vi.fn(),
      restoreActiveBinding: vi.fn(async (input: { session_id: string; account_id: string }) => {
        restoredBindings.set(input.session_id, input.account_id);
      }),
    };
    const openOutbox = vi.spyOn(RunnerParentOutbox, "open")
      .mockRejectedValueOnce(new Error("stop after host binding restore"));
    const factory = createRunnerProcessRuntimeFactory({
      env: {
        SOUL_RUNNER_STATE_DIR: directory,
        SOUL_RUNNER_ARTIFACT_DIR: directory,
        SOUL_RUNNER_RELEASES_DIR: directory,
        SOUL_RUNNER_TERMINAL_RETENTION_MS: 60_000,
        SOUL_RUNNER_LEASE_TIMEOUT_MS: 90_000,
        INCOMING_FILE_DIR: directory,
        SOULSTREAM_NODE_ID: "node-test",
        CODEX_ADAPTER_MODE: "sdk",
        CLAUDE_SESSION_RUNTIME_V2_ENABLED: false,
        CLAUDE_SESSION_RUNTIME_IDLE_TTL_MS: 300_000,
        CLAUDE_SESSION_RUNTIME_MAX_ENTRIES: 16,
        CLAUDE_SESSION_RUNTIME_TURN_TIMEOUT_MS: 1_800_000,
        CLAUDE_ACCOUNT_POOL_ENABLED: true,
        CLAUDE_ACCOUNTS_DIR: "/accounts",
        CODEX_DETACHED_RESULT_RETENTION_MS: 120_000,
        CODEX_APP_SERVER_REQUEST_TIMEOUT_MS: 45_000,
        CODEX_APP_SERVER_STARTUP_TIMEOUT_MS: 135_000,
        MCP_INTERNAL_PORT: 4308,
        MCP_PATH: "/mcp",
      } as never,
      logger: pino({ level: "silent" }),
      pumpMux: {} as never,
      sessionStore: {} as never,
      claudeAccounts,
      mcpConfigService: { resolveMcpProfile: vi.fn(() => null) } as never,
      releasePool: {
        resolveCurrentRelease: vi.fn(),
        describe: vi.fn(() => ({
          releaseId: "sha-account-adopt",
          releaseRoot: "/release/sha-account-adopt",
          runnerModuleRoot: config.snapshotPath,
        })),
        ensureRelease: vi.fn(async () => undefined),
      },
      buildChildProcessEnv: () => ({}),
      spawner: { adopt, spawn },
    });
    const task = {
      agentSessionId: sessionId,
      prompt: "resume",
      status: "pending",
    } as Task;
    const runtime = factory.recover!(task, registration, {
      persistRunState: vi.fn(async () => undefined),
      persistSessionItems: vi.fn(async () => undefined),
    }, "adopt");

    await expect(runtime.dispatcher.prepareSession(sessionId))
      .rejects.toThrow("stop after host binding restore");
    expect(adopt).toHaveBeenCalledWith(registration);
    expect(spawn).not.toHaveBeenCalled();
    expect(claudeAccounts.restoreActiveBinding).toHaveBeenCalledWith({
      session_id: sessionId,
      account_id: "account-a",
    });
    expect(restoredBindings.get(sessionId)).toBe("account-a");
    expect(claudeAccounts.select).not.toHaveBeenCalled();

    const kimiSessionId = "session-adopt-kimi";
    const kimiConfig = { ...config, sessionId: kimiSessionId };
    const kimiRegistration = {
      ...registration,
      config: kimiConfig,
      registrationId: "registration-kimi",
    };
    adopt.mockResolvedValueOnce({
      ...adopted,
      config: kimiConfig,
      registrationId: kimiRegistration.registrationId,
    });
    openOutbox.mockRejectedValueOnce(new Error("stop after Kimi adoption"));
    const kimiTask = {
      agentSessionId: kimiSessionId,
      prompt: "resume Kimi",
      status: "pending",
    } as Task;
    const kimiRuntime = factory.recover!(kimiTask, kimiRegistration, {
      persistRunState: vi.fn(async () => undefined),
      persistSessionItems: vi.fn(async () => undefined),
    }, "adopt");

    await expect(kimiRuntime.dispatcher.prepareSession(kimiSessionId))
      .rejects.toThrow("stop after Kimi adoption");
    expect(adopt).toHaveBeenCalledWith(kimiRegistration);
    expect(claudeAccounts.restoreActiveBinding).toHaveBeenCalledTimes(1);
    expect(claudeAccounts.select).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();

    const legacyDirectory = await mkdtemp(join(tmpdir(), "runner-account-adopt-legacy-"));
    directories.push(legacyDirectory);
    const legacyDatabasePath = join(legacyDirectory, "runner.sqlite");
    const legacyOutbox = await RunnerSqliteEventOutbox.create(legacyDatabasePath);
    legacyOutbox.close();
    const legacySessionId = "session-adopt-old-runner";
    const legacyConfig = {
      ...config,
      sessionId: legacySessionId,
      paths: {
        sessionDirectory: legacyDirectory,
        databasePath: legacyDatabasePath,
        socketPath: join(legacyDirectory, "runner.sock"),
        pidPath: join(legacyDirectory, "runner.pid"),
        lockPath: join(legacyDirectory, "runner.lock"),
        configPath: join(legacyDirectory, "runner-config.json"),
        logPath: join(legacyDirectory, "runner.log"),
      },
    };
    delete legacyConfig.claudeAccountPool;
    const legacyRegistration = {
      ...registration,
      config: legacyConfig,
      registrationId: "registration-old-runner",
    };
    adopt.mockResolvedValueOnce({
      ...adopted,
      config: legacyConfig,
      paths: legacyConfig.paths,
      registrationId: legacyRegistration.registrationId,
    });
    openOutbox.mockRejectedValueOnce(new Error("stop after old runner adoption"));
    const legacyTask = {
      agentSessionId: legacySessionId,
      prompt: "resume old runner",
      status: "pending",
    } as Task;
    const legacyRuntime = factory.recover!(legacyTask, legacyRegistration, {
      persistRunState: vi.fn(async () => undefined),
      persistSessionItems: vi.fn(async () => undefined),
    }, "adopt");

    await expect(legacyRuntime.dispatcher.prepareSession(legacySessionId))
      .rejects.toThrow("stop after old runner adoption");
    expect(adopt).toHaveBeenCalledWith(legacyRegistration);
    expect(claudeAccounts.restoreActiveBinding).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("fails a new runner account request against a host without the account service", async () => {
    await expect(applyRunnerHostCall({
      service: "claude_accounts",
      operation: "select",
      args: ["session-new-runner", {
        session_id: "session-new-runner",
        turn_id: "turn-1",
        model: "claude-sonnet-4-6",
        exclude_ids: [],
      }],
      correlationId: "host:claude-account-select",
    }, { agentSessionId: "session-new-runner" } as Task, {
      persistRunState: vi.fn(async () => undefined),
      persistSessionItems: vi.fn(async () => undefined),
    }, {} as never)).rejects.toThrow("Claude account pool host service is unavailable");
  });
});

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRunnerChildEngine } from "../../src/runner/runner_child_engine_factory.js";
import { parseRunnerChildConfig } from "../../src/runner/runner_child_config.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import { openRunnerSqliteReadOnlyDatabase } from
  "../../src/runner/runner_sqlite_connection.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("createRunnerChildEngine Claude account service bridge", () => {
  it("sends account operations to the host service for the runner session", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "runner-child-account-pool-"));
    directories.push(stateDirectory);
    const sessionDirectory = stateDirectory;
    await mkdir(sessionDirectory, { recursive: true });
    const account = { account_id: "account-a", config_dir: "/accounts/a", available_count: 1 };
    const hostCall = vi.fn(async (_service: string, operation: string, _args: unknown[], _options: unknown) =>
      operation === "select" ? account : null,
    );
    const config = parseRunnerChildConfig({
      schemaVersion: 1,
      sessionId: "session-a",
      backend: "claude",
      agent: {
        id: "agent-a",
        name: "Agent A",
        backend: "claude",
        workspace_dir: "/workspace/agent-a",
      },
      paths: {
        sessionDirectory,
        databasePath: join(sessionDirectory, "runner.sqlite"),
        socketPath: join(sessionDirectory, "runner.sock"),
        pidPath: join(sessionDirectory, "runner.pid"),
        lockPath: join(sessionDirectory, "runner.lock"),
        configPath: join(sessionDirectory, "runner-config.json"),
        logPath: join(sessionDirectory, "runner.log"),
      },
      codeSha: "sha-a",
      snapshotPath: "/release/sha-a/soul-server-ts",
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
    const outbox = await RunnerSqliteEventOutbox.create(config.paths.databasePath);
    outbox.close();
    const engine = createRunnerChildEngine(config, { call: hostCall } as never, pino({ level: "silent" }));
    const accountPort = (engine as unknown as {
      claudeAccountTurnPort: {
        select(input: object): Promise<unknown>;
        reject(input: object): Promise<void>;
        release(input: object): Promise<void>;
      };
    }).claudeAccountTurnPort;
    const selectInput = {
      session_id: "session-a",
      turn_id: "turn-a",
      model: "claude-sonnet-4.5",
      exclude_ids: [],
    };

    try {
      await expect(accountPort.select(selectInput)).resolves.toEqual(account);
      await accountPort.reject({
        session_id: "session-a",
        account_id: "account-a",
        scope: "all",
        resets_at: null,
        observed_at: "2026-10-28T00:00:00.000Z",
      });
      await accountPort.release({ session_id: "session-a" });
      const turnRelease = { session_id: "session-a", account_id: "account-a", turn_id: "turn-a" };
      await accountPort.release(turnRelease);

      expect(hostCall.mock.calls.map(([service, operation, args]) => [service, operation, args])).toEqual([
        ["claude_accounts", "select", ["session-a", selectInput]],
        ["claude_accounts", "reject", ["session-a", expect.objectContaining({ account_id: "account-a" })]],
        ["claude_accounts", "release", ["session-a", { session_id: "session-a" }]],
        ["claude_accounts", "release", ["session-a", turnRelease]],
      ]);
    } finally {
      await engine.close?.();
    }
  });

  it("keeps legacy runner Query, compact, spawn, SQLite, and host protocol wiring when the pool flag is absent", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "runner-child-legacy-claude-"));
    directories.push(stateDirectory);
    const databasePath = join(stateDirectory, "runner.sqlite");
    const outbox = await RunnerSqliteEventOutbox.create(databasePath);
    outbox.close();
    const hostCall = vi.fn(async (
      _service: string,
      _operation: string,
      _args: unknown[],
      _options: unknown,
    ) => null);
    const config = parseRunnerChildConfig({
      schemaVersion: 1,
      sessionId: "session-legacy",
      backend: "claude",
      agent: {
        id: "agent-legacy",
        name: "Legacy Agent",
        backend: "claude",
        workspace_dir: "/workspace/legacy",
      },
      paths: {
        sessionDirectory: stateDirectory,
        databasePath,
        socketPath: join(stateDirectory, "runner.sock"),
        pidPath: join(stateDirectory, "runner.pid"),
        lockPath: join(stateDirectory, "runner.lock"),
        configPath: join(stateDirectory, "runner-config.json"),
        logPath: join(stateDirectory, "runner.log"),
      },
      codeSha: "sha-legacy",
      snapshotPath: "/release/sha-legacy/soul-server-ts",
      codexAdapterMode: "sdk",
      claudeRuntimeV2Enabled: false,
      claudeRuntimeIdleTtlMs: 300_000,
      claudeRuntimeMaxEntries: 16,
      claudeRuntimeTurnTimeoutMs: 1_800_000,
      internalMcpUrl: "http://127.0.0.1:4308/mcp/internal",
      codexHome: null,
      rolloutRoot: null,
    });
    const engine = createRunnerChildEngine(config, { call: hostCall } as never, pino({ level: "silent" }));
    const internals = engine as unknown as {
      claudeAccountPoolEnabled: boolean;
      trackChildExit: boolean;
      sessionStoreFlush: string;
      persistentSessionRegistry?: unknown;
      claudeAccountTurnPort?: unknown;
      claudeAccountTurnState?: unknown;
      sessionStore: { append(key: object, entries: unknown[]): Promise<void> };
    };

    try {
      expect(internals.claudeAccountPoolEnabled).toBe(false);
      expect(internals.trackChildExit).toBe(false);
      expect(internals.sessionStoreFlush).toBe("batched");
      expect(internals.persistentSessionRegistry).toBeUndefined();
      expect(internals.claudeAccountTurnPort).toBeUndefined();
      expect(internals.claudeAccountTurnState).toBeUndefined();
      const db = openRunnerSqliteReadOnlyDatabase(databasePath);
      try {
        const tables = db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        ).all() as Array<{ name: string }>;
        expect(tables.map(({ name }) => name)).not.toContain("runner_claude_account_turn");
      } finally {
        db.close();
      }

      await internals.sessionStore.append(
        { projectKey: "project", sessionId: "session-legacy" },
        [{ type: "assistant", uuid: "legacy-entry" }],
      );
      expect(hostCall.mock.calls.map(([service]) => service)).toEqual(["session_store"]);
    } finally {
      await engine.close?.();
    }
  });
});

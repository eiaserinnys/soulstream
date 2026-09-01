import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { vi } from "vitest";

import { RunnerProcessSpawner } from "../../src/runner/runner_process_spawn.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import {
  writeRunnerRegistrationIdentity,
} from "../../src/runner/runner_registration_identity.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import { RunnerSqliteLifecycle } from "../../src/runner/sqlite_runner_lifecycle.js";

export async function durableMissingSessionFixture(
  lifecycleState: "running" | "reaped",
  now: () => number,
): Promise<{
  root: string;
  stateDirectory: string;
  sessionId: string;
  historicalPid: number;
  paths: ReturnType<typeof runnerProcessPaths>;
  spawner: RunnerProcessSpawner;
}> {
  const root = await mkdtemp(join(tmpdir(), "r36b-missing-session-"));
  const stateDirectory = join(root, "runner-state");
  const sessionId = lifecycleState === "reaped"
    ? "1ed01abc-terminal-residue"
    : "non-terminal-residue";
  const historicalPid = 49_964;
  const paths = runnerProcessPaths(stateDirectory, sessionId);
  await mkdir(paths.sessionDirectory, { recursive: true });
  const config = {
    schemaVersion: 1,
    sessionId,
    backend: "codex",
    agent: {
      id: "agent-a",
      name: "Agent A",
      backend: "codex",
      workspace_dir: "/workspace/a",
    },
    paths,
    codeSha: "release-r36b",
    snapshotPath: "/release/r36b/soul-server-ts",
    codexAdapterMode: "sdk",
    claudeRuntimeV2Enabled: true,
    claudeRuntimeIdleTtlMs: 300_000,
    claudeRuntimeMaxEntries: 16,
    claudeRuntimeTurnTimeoutMs: 600_000,
    internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
    codexHome: "/home/test/.codex",
    rolloutRoot: "/home/test/.codex/sessions",
  } as const;
  await writeFile(paths.configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  await writeRunnerRegistrationIdentity(paths.sessionDirectory, {
    schemaVersion: 1,
    registrationId: `registration-${sessionId}`,
    sessionId,
    codeSha: config.codeSha,
    pid: null,
    startIdentity: null,
  });
  const outbox = await RunnerSqliteEventOutbox.create(paths.databasePath);
  await outbox.initializeBootstrap({
    session_id: sessionId,
    created_at: "2026-09-01T00:00:00.000Z",
    resume: {
      schema_version: 1,
      backend_session_id: `backend-${sessionId}`,
      cwd: "/workspace/a",
      codex_home: config.codexHome,
      rollout_root: config.rolloutRoot,
      code_sha: config.codeSha,
      snapshot_path: config.snapshotPath,
    },
  });
  outbox.close();
  const lifecycle = RunnerSqliteLifecycle.open(paths.databasePath, sessionId);
  lifecycle.begin({
    pid: historicalPid,
    commandId: `execute-${sessionId}`,
    progressedAt: "2026-09-01T00:00:10.000Z",
  });
  if (lifecycleState === "reaped") {
    lifecycle.reap(
      `execute-${sessionId}`,
      "2026-09-01T00:00:20.000Z",
      { code: "runner_exited", message: "runner exited" },
    );
  }
  lifecycle.close();

  const spawner = new RunnerProcessSpawner({
    prepareDatabase: async () => {},
    validateEntry: async () => {},
    spawnProcess: () => ({ pid: 88_002, unref: vi.fn() }),
    registerPid: async () => {},
    inspectProcess: async () => ({ alive: false, startIdentity: null }),
    isPidAlive: () => false,
    signalPid: vi.fn(),
    now,
    delay: async () => {},
  });
  return { root, stateDirectory, sessionId, historicalPid, paths, spawner };
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

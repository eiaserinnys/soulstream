import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readRunnerRegistrationSummary } from "../../src/runner/runner_registration_reader.js";
import {
  scanRunnerRegistrations,
} from "../../src/runner/runner_process_registry.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import type { RunnerChildConfig } from "../../src/runner/runner_process_spawn.js";
import {
  pendingRunnerRegistrationIdentity,
  writeRunnerRegistrationIdentity,
} from "../../src/runner/runner_registration_identity.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import { RunnerSqliteLifecycle } from "../../src/runner/sqlite_runner_lifecycle.js";

const temporaryDirectories: string[] = [];
const CURRENT_PID = process.pid;
const STALE_PID = 2_147_483_601;
const CURRENT_START_IDENTITY = "current-runner-start";
const OTHER_START_IDENTITY = "other-runner-start";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("runner registration reader", () => {
  it("scans a respawned runner while the lifecycle still names the previous process", async () => {
    const fixture = await writeRegistrationFixture("respawn", {
      identity: "complete",
      sidecarPid: CURRENT_PID,
      lifecyclePid: STALE_PID,
    });

    const result = await scanRunnerRegistrations(
      fixture.stateDirectory,
      heldLockOptions(CURRENT_START_IDENTITY),
    );

    expect(result.errors).toEqual([]);
    expect(result.registrations).toHaveLength(1);
    expect(result.registrations[0]).toMatchObject({
      pid: CURRENT_PID,
      pidAlive: true,
      pidStartIdentity: CURRENT_START_IDENTITY,
      lifecycle: { runner_pid: STALE_PID },
    });
  });

  it("rejects a complete identity that disagrees with the pid sidecar", async () => {
    const fixture = await writeRegistrationFixture("sidecar-conflict", {
      identity: "complete",
      sidecarPid: STALE_PID,
      lifecyclePid: CURRENT_PID,
    });

    await expect(readFixture(fixture, CURRENT_START_IDENTITY))
      .rejects.toThrow(`runner pid evidence disagrees: ${fixture.paths.sessionDirectory}`);
  });

  it("marks a complete identity dead when the held lock has another start identity", async () => {
    const fixture = await writeRegistrationFixture("start-identity-conflict", {
      identity: "complete",
      sidecarPid: CURRENT_PID,
      lifecyclePid: CURRENT_PID,
    });

    await expect(readFixture(fixture, OTHER_START_IDENTITY)).resolves.toMatchObject({
      pid: CURRENT_PID,
      pidAlive: false,
      pidStartIdentity: CURRENT_START_IDENTITY,
    });
  });

  it.each(["absent", "pending"] as const)(
    "keeps lifecycle pid fallback when the identity is %s",
    async (identity) => {
      const fixture = await writeRegistrationFixture(`fallback-${identity}`, {
        identity,
        sidecarPid: null,
        lifecyclePid: CURRENT_PID,
      });

      await expect(readFixture(fixture, CURRENT_START_IDENTITY)).resolves.toMatchObject({
        pid: CURRENT_PID,
        pidAlive: true,
        lifecycle: { runner_pid: CURRENT_PID },
      });
    },
  );

  it.each(["absent", "pending"] as const)(
    "rejects live sidecar and lifecycle disagreement when the identity is %s",
    async (identity) => {
      const fixture = await writeRegistrationFixture(`conflict-${identity}`, {
        identity,
        sidecarPid: CURRENT_PID,
        lifecyclePid: STALE_PID,
      });

      await expect(readFixture(fixture, CURRENT_START_IDENTITY))
        .rejects.toThrow(`runner pid evidence disagrees: ${fixture.paths.sessionDirectory}`);
    },
  );
});

type IdentityState = "absent" | "pending" | "complete";

async function writeRegistrationFixture(
  label: string,
  evidence: {
    identity: IdentityState;
    sidecarPid: number | null;
    lifecyclePid: number;
  },
) {
  const stateDirectory = await mkdtemp(join(tmpdir(), `runner-reader-${label}-`));
  temporaryDirectories.push(stateDirectory);
  const sessionId = `session-${label}`;
  const paths = runnerProcessPaths(stateDirectory, sessionId);
  const config: RunnerChildConfig = {
    schemaVersion: 1,
    sessionId,
    backend: "codex",
    agent: {
      id: "agent-a",
      name: "Agent A",
      backend: "codex",
      workspace_dir: "/workspace",
    },
    paths,
    codeSha: "release-a",
    snapshotPath: "/release/release-a",
    codexAdapterMode: "sdk",
    claudeRuntimeV2Enabled: true,
    claudeRuntimeIdleTtlMs: 300_000,
    claudeRuntimeMaxEntries: 16,
    claudeRuntimeTurnTimeoutMs: 1_800_000,
    internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
    codexHome: "/home/test/.codex",
    rolloutRoot: "/home/test/.codex/sessions",
  };
  await mkdir(paths.sessionDirectory, { recursive: true });
  await writeFile(paths.configPath, JSON.stringify(config));
  if (evidence.sidecarPid !== null) {
    await writeFile(paths.pidPath, `${evidence.sidecarPid}\n`);
  }
  if (evidence.identity !== "absent") {
    const pending = pendingRunnerRegistrationIdentity(sessionId, config.codeSha);
    await writeRunnerRegistrationIdentity(paths.sessionDirectory, evidence.identity === "complete"
      ? {
          ...pending,
          pid: CURRENT_PID,
          startIdentity: CURRENT_START_IDENTITY,
        }
      : pending);
  }
  const outbox = await RunnerSqliteEventOutbox.create(paths.databasePath);
  await outbox.initializeBootstrap({
    session_id: sessionId,
    created_at: "2026-09-05T00:00:00.000Z",
    resume: {
      schema_version: 1,
      backend_session_id: `backend-${label}`,
      cwd: "/workspace",
      codex_home: config.codexHome,
      rollout_root: config.rolloutRoot,
      code_sha: config.codeSha,
      snapshot_path: config.snapshotPath,
    },
  });
  outbox.close();
  const lifecycle = RunnerSqliteLifecycle.open(paths.databasePath, sessionId);
  lifecycle.begin({
    pid: evidence.lifecyclePid,
    commandId: `execute-${label}`,
    progressedAt: "2026-09-05T00:00:01.000Z",
  });
  lifecycle.close();
  return { stateDirectory, paths };
}

function heldLockOptions(startIdentity: string) {
  const options: Parameters<typeof readRunnerRegistrationSummary>[1] = {
    verifyProcessIdentity: true,
    inspectWriterLock: async () => ({
      kind: "held",
      owner: { pid: CURRENT_PID, startIdentity },
    }),
  };
  return options;
}

async function readFixture(
  fixture: Awaited<ReturnType<typeof writeRegistrationFixture>>,
  startIdentity: string,
) {
  return await readRunnerRegistrationSummary(
    fixture.paths.sessionDirectory,
    heldLockOptions(startIdentity),
  );
}

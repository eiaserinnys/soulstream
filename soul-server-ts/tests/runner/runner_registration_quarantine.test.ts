import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  quarantineUnreadableRunnerRegistration,
  RUNNER_REGISTRATION_QUARANTINE_STAGES,
} from "../../src/runner/runner_registration_quarantine.js";
import { scanRunnerRegistrations } from "../../src/runner/runner_process_registry.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import type { RunnerChildConfig } from "../../src/runner/runner_process_spawn.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import {
  pendingRunnerRegistrationIdentity,
  runnerRegistrationIdentityPath,
  writeRunnerRegistrationIdentity,
} from "../../src/runner/runner_registration_identity.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("runner registration quarantine", () => {
  it("keeps the corruption inventory exhaustive", () => {
    expect(RUNNER_REGISTRATION_QUARANTINE_STAGES).toEqual([
      "config",
      "summary",
      "identity",
      "sqlite",
    ]);
  });

  it("quarantines nine proven-dead legacy directories without touching a healthy neighbor", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-registration-quarantine-"));
    temporaryDirectories.push(root);
    const stateDirectory = join(root, "runner-state");
    await mkdir(stateDirectory, { recursive: true });

    const healthy = await writeHealthyRegistration(stateDirectory, "session-healthy");
    for (let index = 0; index < 9; index += 1) {
      await writeDeadLegacyRegistration(stateDirectory, `session-stale-${index}`, 7_000 + index);
    }

    const firstScan = await scanRunnerRegistrations(stateDirectory);
    expect(firstScan.registrations.map((item) => item.config.sessionId))
      .toEqual(["session-healthy"]);
    expect(firstScan.errors).toHaveLength(9);

    const results = await Promise.all(firstScan.errors.map(
      async (failure) => await quarantineUnreadableRunnerRegistration(
        stateDirectory,
        failure,
        { inspectProcess: async () => ({ alive: false, startIdentity: null }) },
      ),
    ));

    expect(results.every((result) => result.status === "quarantined")).toBe(true);
    const secondScan = await scanRunnerRegistrations(stateDirectory);
    expect(secondScan.errors).toEqual([]);
    expect(secondScan.registrations.map((item) => item.config.sessionId))
      .toEqual(["session-healthy"]);
    await expect(access(healthy.paths.sessionDirectory)).resolves.toBeUndefined();
    expect(await readdir(`${stateDirectory}.quarantine`)).toHaveLength(9);
  });

  it("preserves an unreadable directory while its registered process is alive", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-registration-live-"));
    temporaryDirectories.push(root);
    const stateDirectory = join(root, "runner-state");
    await mkdir(stateDirectory, { recursive: true });
    const stale = await writeDeadLegacyRegistration(stateDirectory, "session-live", 8_001);
    const [failure] = (await scanRunnerRegistrations(stateDirectory)).errors;

    await expect(quarantineUnreadableRunnerRegistration(
      stateDirectory,
      failure!,
      { inspectProcess: async () => ({ alive: true, startIdentity: "start-8001" }) },
    )).resolves.toEqual({ status: "retained", reason: "runner_alive" });
    await expect(access(stale.paths.sessionDirectory)).resolves.toBeUndefined();
  });

  it("quarantines a proven-dead directory after SQLite damage", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-registration-summary-failure-"));
    temporaryDirectories.push(root);
    const stateDirectory = join(root, "runner-state");
    const paths = runnerProcessPaths(stateDirectory, "session-missing-db");
    await mkdir(paths.sessionDirectory, { recursive: true });
    await writeFile(paths.configPath, JSON.stringify(childConfig("session-missing-db", paths)));
    await writeFile(paths.pidPath, "9001\n");
    await writeRunnerRegistrationIdentity(paths.sessionDirectory, {
      ...pendingRunnerRegistrationIdentity("session-missing-db", "release-a"),
      pid: 9_001,
      startIdentity: "start-9001",
    });
    const [failure] = (await scanRunnerRegistrations(stateDirectory)).errors;
    expect(registrationFailureStage(failure!.error)).toBe("sqlite");

    await expect(quarantineUnreadableRunnerRegistration(
      stateDirectory,
      failure!,
      { inspectProcess: async () => ({ alive: false, startIdentity: null }) },
    )).resolves.toMatchObject({ status: "quarantined", pid: 9_001 });
    await expect(access(paths.sessionDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("quarantines proven-dead summary and identity damage through distinct decisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-registration-corruption-matrix-"));
    temporaryDirectories.push(root);
    const stateDirectory = join(root, "runner-state");
    await mkdir(stateDirectory, { recursive: true });

    const summaryPaths = runnerProcessPaths(stateDirectory, "session-summary-damaged");
    await mkdir(summaryPaths.sessionDirectory, { recursive: true });
    const summaryConfig = childConfig("session-summary-damaged", summaryPaths);
    await writeFile(summaryPaths.configPath, JSON.stringify({
      ...summaryConfig,
      paths: { ...summaryConfig.paths, sessionDirectory: join(stateDirectory, "wrong") },
    }));
    await writeFile(summaryPaths.pidPath, "9101\n");
    await writeRunnerRegistrationIdentity(summaryPaths.sessionDirectory, {
      ...pendingRunnerRegistrationIdentity("session-summary-damaged", "release-a"),
      pid: 9_101,
      startIdentity: "start-9101",
    });

    const identity = await writeHealthyRegistration(stateDirectory, "session-identity-damaged");
    await writeFile(identity.paths.pidPath, "9102\n");
    await writeFile(
      runnerRegistrationIdentityPath(identity.paths.sessionDirectory),
      "{not-json\n",
    );

    const scan = await scanRunnerRegistrations(stateDirectory);
    const failures = new Map(scan.errors.map((failure) => [
      failure.directory,
      failure,
    ]));
    expect(registrationFailureStage(failures.get(summaryPaths.sessionDirectory)!.error))
      .toBe("summary");
    expect(registrationFailureStage(failures.get(identity.paths.sessionDirectory)!.error))
      .toBe("identity");

    for (const failure of failures.values()) {
      await expect(quarantineUnreadableRunnerRegistration(
        stateDirectory,
        failure,
        { inspectProcess: async () => ({ alive: false, startIdentity: null }) },
      )).resolves.toMatchObject({ status: "quarantined" });
    }
  });
});

function registrationFailureStage(error: Error): string | undefined {
  return (error as Error & { runnerRegistrationStage?: string }).runnerRegistrationStage;
}

async function writeHealthyRegistration(stateDirectory: string, sessionId: string) {
  const paths = runnerProcessPaths(stateDirectory, sessionId);
  await mkdir(paths.sessionDirectory, { recursive: true });
  const config = childConfig(sessionId, paths);
  await writeFile(paths.configPath, JSON.stringify(config));
  const outbox = await RunnerSqliteEventOutbox.create(paths.databasePath);
  outbox.close();
  return { paths, config };
}

async function writeDeadLegacyRegistration(
  stateDirectory: string,
  sessionId: string,
  pid: number,
) {
  const paths = runnerProcessPaths(stateDirectory, sessionId);
  await mkdir(paths.sessionDirectory, { recursive: true });
  const config = childConfig(sessionId, paths);
  const { internalMcpUrl: _removed, ...legacyConfig } = config;
  await writeFile(paths.configPath, JSON.stringify({ ...legacyConfig, schemaVersion: 1 }));
  await writeFile(paths.pidPath, `${pid}\n`);
  await writeRunnerRegistrationIdentity(paths.sessionDirectory, {
    ...pendingRunnerRegistrationIdentity(sessionId, "release-a"),
    pid,
    startIdentity: `start-${pid}`,
  });
  return { paths, config };
}

function childConfig(
  sessionId: string,
  paths: ReturnType<typeof runnerProcessPaths>,
): RunnerChildConfig {
  return {
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
    codeSha: "release-a",
    snapshotPath: "/release/release-a/soul-server-ts",
    codexAdapterMode: "sdk",
    claudeRuntimeV2Enabled: true,
    claudeRuntimeIdleTtlMs: 300_000,
    claudeRuntimeMaxEntries: 16,
    claudeRuntimeTurnTimeoutMs: 1_800_000,
    internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
    codexHome: "/home/test/.codex",
    rolloutRoot: "/home/test/.codex/sessions",
  };
}

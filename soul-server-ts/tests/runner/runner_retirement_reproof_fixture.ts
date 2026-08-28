import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProcessIdentity } from "../../src/runner/runner_process_lock.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import {
  RunnerProcessSpawner,
  type RunnerChildConfig,
  type SpawnRunnerProcessInput,
} from "../../src/runner/runner_process_spawn.js";
import {
  scanRunnerRegistrations,
  type RunnerRegistration,
  type RunnerRegistrationScan,
} from "../../src/runner/runner_process_registry.js";
import {
  readRunnerRegistrationIdentity,
  writeRunnerRegistrationIdentity,
} from "../../src/runner/runner_registration_identity.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import { RunnerSqliteLifecycle } from "../../src/runner/sqlite_runner_lifecycle.js";

const OLD_PID = 2_147_000_001;
const NEW_PID = 2_147_000_002;
const OLD_START_IDENTITY = "windows-process-638920800001230000";

interface VirtualProcess {
  alive: boolean;
  startIdentity: string;
}

export class VirtualRunnerProcessTable {
  readonly events: string[] = [];
  readonly signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  private readonly processes = new Map<number, VirtualProcess>();
  private exitBeforeNextInspect = false;
  private preserveAfterSigterm = false;
  private comparedExactIdentity = false;
  private afterBoundary = false;

  constructor() {
    this.processes.set(OLD_PID, { alive: false, startIdentity: OLD_START_IDENTITY });
  }

  setOldAlive(alive: boolean): void {
    const process = this.require(OLD_PID);
    process.alive = alive;
    if (alive) {
      this.afterBoundary = true;
      this.events.push("process-live-at-final-boundary");
    }
  }

  arrangeNaturalExitBeforeSignal(): void {
    this.exitBeforeNextInspect = true;
  }

  arrangeHostRestartAfterSigterm(): void {
    this.preserveAfterSigterm = true;
  }

  allowTerminationToComplete(): void {
    this.preserveAfterSigterm = false;
  }

  isAlive = (pid: number): boolean => {
    const alive = this.processes.get(pid)?.alive ?? false;
    if (this.afterBoundary && pid === OLD_PID) {
      this.events.push(`liveness-check:${alive ? "live" : "dead"}`);
      if (!alive && this.signals.some((item) => item.pid === pid)) {
        this.events.push("exit-proof");
      }
    }
    return alive;
  };

  inspect = async (pid: number): Promise<ProcessIdentity> => {
    const process = this.processes.get(pid);
    if (!process) return { alive: false, startIdentity: null };
    if (pid === OLD_PID && this.exitBeforeNextInspect) {
      this.exitBeforeNextInspect = false;
      process.alive = false;
      this.events.push("natural-exit-before-signal");
    }
    this.events.push(`inspect:${pid}:${process.alive ? "live" : "dead"}`);
    if (pid === OLD_PID && process.alive) {
      this.comparedExactIdentity = true;
      this.events.push("fresh-exact-reproof");
    }
    return {
      alive: process.alive,
      startIdentity: process.alive ? process.startIdentity : null,
    };
  };

  signal = (pid: number, signal: NodeJS.Signals): void => {
    this.signals.push({ pid, signal });
    this.events.push("terminate");
    const process = this.require(pid);
    if (this.preserveAfterSigterm && signal === "SIGTERM") {
      throw new Error("simulated host restart after SIGTERM before exit proof");
    }
    process.alive = false;
  };

  spawn = (pid = NEW_PID, startIdentity = `node-start-${NEW_PID}`): void => {
    this.processes.set(pid, { alive: true, startIdentity });
    this.events.push("spawn");
  };

  exactIdentityWasCompared(): boolean {
    return this.comparedExactIdentity;
  }

  oldPid(): number {
    return OLD_PID;
  }

  newPid(): number {
    return NEW_PID;
  }

  oldStartIdentity(): string {
    return OLD_START_IDENTITY;
  }

  liveProcessCount(): number {
    return [...this.processes.values()].filter((process) => process.alive).length;
  }

  private require(pid: number): VirtualProcess {
    const process = this.processes.get(pid);
    if (!process) throw new Error(`virtual process missing: ${pid}`);
    return process;
  }
}

export interface RetirementFixture {
  stateDirectory: string;
  paths: ReturnType<typeof runnerProcessPaths>;
  input: SpawnRunnerProcessInput;
  processTable: VirtualRunnerProcessTable;
  spawner: RunnerProcessSpawner;
  scan(): Promise<RunnerRegistrationScan>;
  registration(pidAlive: boolean): Promise<RunnerRegistration>;
  cleanup(): Promise<void>;
}

export async function createTerminalRetirementFixture(): Promise<RetirementFixture> {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runner-retirement-reproof-"));
  const sessionId = "session-retirement-reproof";
  const paths = runnerProcessPaths(stateDirectory, sessionId);
  const input = spawnInput(stateDirectory, sessionId);
  const config: RunnerChildConfig = { schemaVersion: 1, ...input, paths };
  await mkdir(paths.sessionDirectory, { recursive: true });
  await writeFile(paths.configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  const outbox = await RunnerSqliteEventOutbox.create(paths.databasePath);
  await outbox.initializeBootstrap({
    session_id: sessionId,
    created_at: "2026-08-28T00:00:00.000Z",
    resume: {
      schema_version: 1,
      backend_session_id: "backend-retirement-reproof",
      cwd: input.agent.workspace_dir,
      codex_home: input.codexHome,
      rollout_root: input.rolloutRoot,
      code_sha: input.codeSha,
      snapshot_path: input.snapshotPath,
    },
  });
  outbox.close();
  const lifecycle = RunnerSqliteLifecycle.open(paths.databasePath);
  lifecycle.begin({
    pid: OLD_PID,
    commandId: "execute-terminal-old",
    progressedAt: "2026-08-28T00:00:01.000Z",
  });
  lifecycle.finish(
    "execute-terminal-old",
    "completed",
    "2026-08-28T00:00:02.000Z",
  );
  lifecycle.close();
  await writeRunnerRegistrationIdentity(paths.sessionDirectory, {
    schemaVersion: 1,
    registrationId: "registration-terminal-old",
    sessionId,
    codeSha: input.codeSha,
    pid: OLD_PID,
    startIdentity: OLD_START_IDENTITY,
  });
  await writeFile(paths.pidPath, `${OLD_PID}\n`, { mode: 0o600 });
  await writeFile(paths.socketPath, "socket-evidence\n", { mode: 0o600 });

  const processTable = new VirtualRunnerProcessTable();
  let clock = 0;
  const spawner = new RunnerProcessSpawner({
    prepareDatabase: async (path) => {
      const writer = await RunnerSqliteEventOutbox.create(path);
      writer.close();
    },
    validateEntry: async () => {},
    spawnProcess: () => {
      processTable.spawn();
      return { pid: NEW_PID, unref: () => {} };
    },
    registerPid: async (path, pid) => await writeFile(path, `${pid}\n`, { mode: 0o600 }),
    inspectProcess: processTable.inspect,
    isPidAlive: processTable.isAlive,
    signalPid: processTable.signal,
    now: () => clock,
    delay: async (ms) => { clock += ms; },
  });

  const scan = async () => {
    const result = await scanRunnerRegistrations(stateDirectory);
    return {
      ...result,
      registrations: result.registrations.map((item) => ({
        ...item,
        pidAlive: item.pid === null ? false : processTable.isAlive(item.pid),
      })),
    };
  };
  const registration = async (pidAlive: boolean) => {
    const result = await scan();
    const item = result.registrations[0];
    if (!item) throw new Error("terminal retirement fixture registration missing");
    return { ...item, pidAlive };
  };
  return {
    stateDirectory,
    paths,
    input,
    processTable,
    spawner,
    scan,
    registration,
    cleanup: async () => await rm(stateDirectory, { recursive: true, force: true }),
  };
}

export async function readRegistrationEvidence(fixture: RetirementFixture): Promise<{
  identity: Awaited<ReturnType<typeof readRunnerRegistrationIdentity>>;
  pidFile: string | null;
  socketFile: string | null;
}> {
  return {
    identity: await readRunnerRegistrationIdentity(fixture.paths.sessionDirectory),
    pidFile: await readOptional(fixture.paths.pidPath),
    socketFile: await readOptional(fixture.paths.socketPath),
  };
}

function spawnInput(stateDirectory: string, sessionId: string): SpawnRunnerProcessInput {
  return {
    stateDirectory,
    sessionId,
    backend: "codex",
    agent: {
      id: "agent-retirement",
      name: "Retirement Reproof",
      backend: "codex",
      workspace_dir: "/workspace/retirement-reproof",
    },
    codeSha: "82bf7a0-test-fixture",
    snapshotPath: "/release/82bf7a0/soul-server-ts",
    codexAdapterMode: "sdk",
    claudeRuntimeV2Enabled: true,
    claudeRuntimeIdleTtlMs: 300_000,
    claudeRuntimeMaxEntries: 16,
    claudeRuntimeTurnTimeoutMs: 600_000,
    runnerLeaseTimeoutMs: 120_000,
    internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
    codexHome: "/home/test/.codex",
    rolloutRoot: "/home/test/.codex/sessions",
  };
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if ((error as NodeJS.ErrnoException).code === "EISDIR") return "<non-file-evidence>";
    throw error;
  }
}

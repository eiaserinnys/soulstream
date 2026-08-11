import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  AgentBackendSchema,
  AgentProfileSchema,
  AgentsSdkMcpServerSchema,
} from "../agent_registry.js";
import { assertRunnerJsonValue } from "./frame_protocol.js";
import { runnerProcessPaths, type RunnerProcessPaths } from "./runner_process_paths.js";
import { RunnerSqliteEventOutbox } from "./sqlite_event_outbox.js";
import { withRunnerSessionMutationLock } from "./runner_session_mutation_lock.js";

const EXISTING_RUNNER_STOP_TIMEOUT_MS = 2_000;

const RunnerProcessPathsSchema = z.object({
  sessionDirectory: z.string().min(1),
  databasePath: z.string().min(1),
  socketPath: z.string().min(1),
  pidPath: z.string().min(1),
  lockPath: z.string().min(1),
  configPath: z.string().min(1),
});

export const RunnerChildConfigSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  backend: AgentBackendSchema,
  agent: AgentProfileSchema,
  paths: RunnerProcessPathsSchema,
  codeSha: z.string().min(1),
  snapshotPath: z.string().min(1),
  codexAdapterMode: z.enum(["sdk", "app-server"]),
  codexCliPath: z.string().min(1).optional(),
  claudeRuntimeV2Enabled: z.boolean(),
  claudeRuntimeIdleTtlMs: z.number().int().positive(),
  claudeRuntimeMaxEntries: z.number().int().positive(),
  claudeRuntimeTurnTimeoutMs: z.number().int().positive(),
  internalMcpUrl: z.string().url(),
  resolvedMcpServers: z.array(AgentsSdkMcpServerSchema).optional(),
  codexHome: z.string().min(1).nullable(),
  rolloutRoot: z.string().min(1).nullable(),
});

export type RunnerChildConfig = z.infer<typeof RunnerChildConfigSchema>;

export function parseRunnerChildConfig(value: unknown): RunnerChildConfig {
  assertRunnerJsonValue(value, "runner child config");
  return RunnerChildConfigSchema.parse(value);
}

export interface SpawnRunnerProcessInput extends Omit<RunnerChildConfig, "schemaVersion" | "paths"> {
  stateDirectory: string;
  childProcessEnv?: NodeJS.ProcessEnv;
  /** Host-only preparation; never serialized into the child config. */
  prepareSnapshot?: () => Promise<void>;
}

export interface SpawnedRunnerProcess {
  pid: number;
  paths: RunnerProcessPaths;
  config: RunnerChildConfig;
  adopted: boolean;
}

export interface AdoptRunnerProcessInput {
  stateDirectory: string;
  sessionId: string;
}

interface SpawnDependencies {
  prepareDatabase(path: string): Promise<void>;
  validateEntry(path: string): Promise<void>;
  spawnProcess(entry: string, args: string[], options: {
    detached: true;
    stdio: "ignore";
    cwd: string;
    env: NodeJS.ProcessEnv;
  }): Pick<ChildProcess, "pid" | "unref">;
  registerPid(path: string, pid: number): Promise<void>;
  isPidAlive(pid: number): boolean;
  signalPid(pid: number, signal: NodeJS.Signals): void;
  now(): number;
  delay(ms: number): Promise<void>;
}

export class RunnerProcessSpawner {
  constructor(private readonly deps: SpawnDependencies = defaultDependencies()) {}

  async spawn(input: SpawnRunnerProcessInput): Promise<SpawnedRunnerProcess> {
    const paths = runnerProcessPaths(input.stateDirectory, input.sessionId);
    return await withRunnerSessionMutationLock(
      paths.sessionDirectory,
      async () => await this.spawnLocked(input, paths),
    );
  }

  private async spawnLocked(
    input: SpawnRunnerProcessInput,
    paths: RunnerProcessPaths,
  ): Promise<SpawnedRunnerProcess> {
    await mkdir(paths.sessionDirectory, { recursive: true, mode: 0o700 });
    await chmod(paths.sessionDirectory, 0o700);

    // Registration is deliberately before spawn. A server crash after this
    // point leaves a discoverable SQLite identity instead of an orphan child.
    await this.deps.prepareDatabase(paths.databasePath);
    await this.stopExistingRunner(paths);

    const config: RunnerChildConfig = {
      schemaVersion: 1,
      sessionId: input.sessionId,
      backend: input.backend,
      agent: input.agent,
      paths,
      codeSha: input.codeSha,
      snapshotPath: input.snapshotPath,
      codexAdapterMode: input.codexAdapterMode,
      ...(input.codexCliPath ? { codexCliPath: input.codexCliPath } : {}),
      claudeRuntimeV2Enabled: input.claudeRuntimeV2Enabled,
      claudeRuntimeIdleTtlMs: input.claudeRuntimeIdleTtlMs,
      claudeRuntimeMaxEntries: input.claudeRuntimeMaxEntries,
      claudeRuntimeTurnTimeoutMs: input.claudeRuntimeTurnTimeoutMs,
      internalMcpUrl: input.internalMcpUrl,
      ...(input.resolvedMcpServers
        ? { resolvedMcpServers: input.resolvedMcpServers }
        : {}),
      codexHome: input.codexHome,
      rolloutRoot: input.rolloutRoot,
    };
    const validatedConfig = parseRunnerChildConfig(config);
    await writeFile(paths.configPath, JSON.stringify(validatedConfig), { mode: 0o600 });
    await chmod(paths.configPath, 0o600);

    // Config + SQLite registration must exist before materialization. GC
    // re-scans registrations under the same release lock before deletion.
    await input.prepareSnapshot?.();
    const entry = join(input.snapshotPath, "runner_entry.js");
    await this.deps.validateEntry(entry);
    const child = this.deps.spawnProcess(entry, ["--config", paths.configPath], {
      detached: true,
      stdio: "ignore",
      cwd: input.snapshotPath,
      env: input.childProcessEnv ?? process.env,
    });
    if (!child.pid) throw new Error("detached runner spawn returned no pid");
    try {
      await this.deps.registerPid(paths.pidPath, child.pid);
    } catch (registrationError) {
      const cleanupErrors: unknown[] = [];
      try {
        await this.terminateSpawnedChild(child, child.pid);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        await unlinkIfPresent(paths.pidPath);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [registrationError, ...cleanupErrors],
          `runner pid registration failed and child cleanup was incomplete: ${String(registrationError)}`,
        );
      }
      throw registrationError;
    }
    child.unref();
    return { pid: child.pid, paths, config: validatedConfig, adopted: false };
  }

  async adopt(input: AdoptRunnerProcessInput): Promise<SpawnedRunnerProcess | null> {
    const paths = runnerProcessPaths(input.stateDirectory, input.sessionId);
    const pid = await readRunnerPid(paths.pidPath);
    if (pid === null || !this.deps.isPidAlive(pid)) return null;
    const config = await readRunnerChildConfig(paths.configPath);
    if (config.sessionId !== input.sessionId || !samePaths(config.paths, paths)) {
      throw new Error(`runner registration mismatch for ${input.sessionId}`);
    }
    return { pid, paths, config, adopted: true };
  }

  async terminate(paths: RunnerProcessPaths): Promise<void> {
    await this.stopExistingRunner(paths);
  }

  private async terminateSpawnedChild(
    child: Pick<ChildProcess, "unref">,
    pid: number,
  ): Promise<void> {
    try {
      if (this.deps.isPidAlive(pid)) this.deps.signalPid(pid, "SIGKILL");
      const deadline = this.deps.now() + EXISTING_RUNNER_STOP_TIMEOUT_MS;
      while (this.deps.isPidAlive(pid) && this.deps.now() < deadline) {
        await this.deps.delay(25);
      }
      if (this.deps.isPidAlive(pid)) {
        throw new Error(`unregistered runner pid ${pid} did not terminate`);
      }
    } finally {
      child.unref();
    }
  }

  private async stopExistingRunner(paths: RunnerProcessPaths): Promise<void> {
    const pid = await readRunnerPid(paths.pidPath);
    if (pid !== null && this.deps.isPidAlive(pid)) {
      this.deps.signalPid(pid, "SIGTERM");
      const deadline = this.deps.now() + EXISTING_RUNNER_STOP_TIMEOUT_MS;
      while (this.deps.isPidAlive(pid) && this.deps.now() < deadline) {
        await this.deps.delay(25);
      }
      if (this.deps.isPidAlive(pid)) this.deps.signalPid(pid, "SIGKILL");
      if (this.deps.isPidAlive(pid)) {
        throw new Error(`existing runner pid ${pid} did not terminate`);
      }
    }
    await unlinkIfPresent(paths.pidPath);
    await unlinkIfPresent(paths.socketPath);
  }
}

function defaultDependencies(): SpawnDependencies {
  return {
    prepareDatabase: async (path) => {
      const outbox = await RunnerSqliteEventOutbox.open(path);
      outbox.close();
    },
    validateEntry: async (path) => await access(path),
    spawnProcess: (entry, args, options) => spawn(process.execPath, [entry, ...args], options),
    registerPid: async (path, pid) => await writeFile(path, `${pid}\n`, { mode: 0o600 }),
    isPidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    signalPid: (pid, signal) => process.kill(pid, signal),
    now: Date.now,
    delay: async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export async function readRunnerPid(path: string): Promise<number | null> {
  try {
    const value = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`invalid runner pid file: ${path}`);
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readRunnerChildConfig(path: string): Promise<RunnerChildConfig> {
  try {
    return parseRunnerChildConfig(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`runner config missing: ${path}`, { cause: error });
    }
    throw error;
  }
}

function samePaths(left: RunnerProcessPaths, right: RunnerProcessPaths): boolean {
  return left.sessionDirectory === right.sessionDirectory
    && left.databasePath === right.databasePath
    && left.socketPath === right.socketPath
    && left.pidPath === right.pidPath
    && left.lockPath === right.lockPath
    && left.configPath === right.configPath;
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

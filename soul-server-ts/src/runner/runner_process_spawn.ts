import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";
import type { Logger } from "pino";

import {
  AgentBackendSchema,
  AgentProfileSchema,
  AgentsSdkMcpServerSchema,
} from "../agent_registry.js";
import { assertRunnerJsonValue } from "./frame_protocol.js";
import { readAuthoritativeRunnerLifecycle } from "./runner_lifecycle_reader.js";
import { runnerProcessPaths, type RunnerProcessPaths } from "./runner_process_paths.js";
import {
  readRunnerPid,
  resolveRegisteredRunnerPid,
} from "./runner_process_registration.js";
import { RunnerSqliteEventOutbox } from "./sqlite_event_outbox.js";
import type { RunnerLifecycleRecord } from "./sqlite_runner_lifecycle.js";
import {
  inspectProcessIdentity,
  processStartIdentitiesMatch,
  type ProcessIdentity,
} from "./runner_process_lock.js";
import { withRunnerSessionMutationLock } from "./runner_session_mutation_lock.js";
import {
  invalidateRunnerRegistrationIdentity,
  pendingRunnerRegistrationIdentity,
  readRunnerRegistrationIdentity,
  type RunnerRegistrationIdentity,
  waitForChildRunnerRegistrationIdentity,
  writeRunnerRegistrationIdentity,
} from "./runner_registration_identity.js";
import { prepareRunnerWriterLockForSpawn } from "./runner_writer_lock.js";

const EXISTING_RUNNER_STOP_TIMEOUT_MS = 2_000;
const RunnerProcessPathsSchema = z.object({
  sessionDirectory: z.string().min(1),
  databasePath: z.string().min(1),
  socketPath: z.string().min(1),
  pidPath: z.string().min(1),
  lockPath: z.string().min(1),
  configPath: z.string().min(1),
  logPath: z.string().min(1).optional(),
}).transform((paths) => ({
  ...paths,
  logPath: paths.logPath ?? join(paths.sessionDirectory, "runner.log"),
}));

const RunnerChildConfigFields = {
  sessionId: z.string().min(1),
  backend: AgentBackendSchema,
  agent: AgentProfileSchema,
  paths: RunnerProcessPathsSchema,
  codeSha: z.string().min(1),
  releaseManifestId: z.string().min(1).optional(),
  runtimeEnvIdentity: z.string().min(1).optional(),
  snapshotPath: z.string().min(1),
  codexAdapterMode: z.enum(["sdk", "app-server"]),
  codexCliPath: z.string().min(1).optional(),
  claudeRuntimeV2Enabled: z.boolean(),
  claudeRuntimeIdleTtlMs: z.number().int().positive(),
  claudeRuntimeMaxEntries: z.number().int().positive(),
  claudeRuntimeTurnTimeoutMs: z.number().int().positive(),
  runnerLeaseTimeoutMs: z.number().int().positive().optional(),
  internalMcpUrl: z.string().url(),
  resolvedMcpServers: z.array(AgentsSdkMcpServerSchema).optional(),
  codexHome: z.string().min(1).nullable(),
  rolloutRoot: z.string().min(1).nullable(),
};

// Runner configs are consumed by the immutable snapshot selected by codeSha,
// not necessarily by the host version that writes them. The writer may raise
// this discriminator only after every snapshot that can be restarted already
// accepts the new value. Additive fields remain rolling-compatible because
// older Zod object readers discard unknown keys.
export const RunnerChildConfigSchema = z.object({
  schemaVersion: z.literal(1),
  ...RunnerChildConfigFields,
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
    stdio: ["ignore", number, number];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }): Pick<ChildProcess, "pid" | "unref">;
  openRunnerLog?(path: string): Promise<{ fd: number; close(): Promise<void> }>;
  registerPid(path: string, pid: number): Promise<void>;
  inspectProcess(pid: number): Promise<ProcessIdentity>;
  waitForChildRegistrationIdentity?(
    paths: RunnerProcessPaths,
    pending: RunnerRegistrationIdentity,
    pid: number,
  ): Promise<RunnerRegistrationIdentity | null>;
  isPidAlive(pid: number): boolean;
  signalPid(pid: number, signal: NodeJS.Signals): void;
  now(): number;
  delay(ms: number): Promise<void>;
  readLifecycle?(path: string): Promise<RunnerLifecycleRecord | null>;
}

export class RunnerProcessSpawner {
  constructor(
    private readonly deps: SpawnDependencies = defaultDependencies(),
    private readonly logger?: Pick<Logger, "info">,
  ) {}
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
    // stopExistingRunner proves any registered child dead (or identity-fenced)
    // before a current-host orphan is reclaimed. Active host/child owners remain
    // fail-closed, so this cannot open a split-brain spawn window.
    const reclaimedHostLock = await prepareRunnerWriterLockForSpawn(paths.lockPath);
    if (reclaimedHostLock) {
      this.logger?.info(
        {
          sessionId: input.sessionId,
          runnerDirectory: paths.sessionDirectory,
          lockPath: paths.lockPath,
        },
        "Orphaned runner writer lock reclaimed before replacement spawn",
      );
    }
    const registrationIdentity = pendingRunnerRegistrationIdentity(
      input.sessionId, input.codeSha, input,
    );
    await writeRunnerRegistrationIdentity(paths.sessionDirectory, registrationIdentity);
    const config: RunnerChildConfig = {
      schemaVersion: 1,
      sessionId: input.sessionId,
      backend: input.backend,
      agent: input.agent,
      paths,
      codeSha: input.codeSha,
      ...(input.releaseManifestId ? { releaseManifestId: input.releaseManifestId } : {}),
      ...(input.runtimeEnvIdentity ? { runtimeEnvIdentity: input.runtimeEnvIdentity } : {}),
      snapshotPath: input.snapshotPath,
      codexAdapterMode: input.codexAdapterMode,
      ...(input.codexCliPath ? { codexCliPath: input.codexCliPath } : {}),
      claudeRuntimeV2Enabled: input.claudeRuntimeV2Enabled,
      claudeRuntimeIdleTtlMs: input.claudeRuntimeIdleTtlMs,
      claudeRuntimeMaxEntries: input.claudeRuntimeMaxEntries,
      claudeRuntimeTurnTimeoutMs: input.claudeRuntimeTurnTimeoutMs,
      ...(input.runnerLeaseTimeoutMs === undefined
        ? {}
        : { runnerLeaseTimeoutMs: input.runnerLeaseTimeoutMs }),
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
    const log = await (this.deps.openRunnerLog?.(paths.logPath)
      ?? open(paths.logPath, "a", 0o600));
    let child: Pick<ChildProcess, "pid" | "unref">;
    try {
      child = this.deps.spawnProcess(entry, ["--config", paths.configPath], {
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
        cwd: input.snapshotPath,
        env: input.childProcessEnv ?? process.env,
      });
    } catch (spawnError) {
      try {
        await log.close();
      } catch (closeError) {
        throw new AggregateError(
          [spawnError, closeError],
          `runner spawn and log descriptor close failed: ${String(spawnError)}`,
        );
      }
      throw spawnError;
    }
    if (!child.pid) {
      try {
        await log.close();
      } finally {
        child.unref();
      }
      throw new Error("detached runner spawn returned no pid");
    }
    let preserveLiveChild = false;
    try {
      await log.close();
      const childIdentity = await this.deps.waitForChildRegistrationIdentity?.(
        paths,
        registrationIdentity,
        child.pid,
      ) ?? null;
      if (childIdentity) {
        if (
          childIdentity.registrationId !== registrationIdentity.registrationId
          || childIdentity.pid !== child.pid
          || !childIdentity.startIdentity
        ) {
          throw new Error(`detached runner published invalid identity: ${child.pid}`);
        }
      } else {
        const observed = await this.deps.inspectProcess(child.pid);
        if (!observed.alive) {
          throw new Error(`detached runner process exited before registration: ${child.pid}`);
        }
        if (!observed.startIdentity) {
          preserveLiveChild = true;
          this.logger?.info(
            { sessionId: input.sessionId, pid: child.pid },
            "Live runner identity lookup was unavailable; child was left intact",
          );
          throw new Error(`detached runner process identity unavailable: ${child.pid}`);
        }
        await writeRunnerRegistrationIdentity(paths.sessionDirectory, {
          ...registrationIdentity,
          pid: child.pid,
          startIdentity: observed.startIdentity,
        });
      }
      await this.deps.registerPid(paths.pidPath, child.pid);
    } catch (registrationError) {
      if (preserveLiveChild) {
        child.unref();
        throw registrationError;
      }
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
      try {
        await writeRunnerRegistrationIdentity(paths.sessionDirectory, registrationIdentity);
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
    const identity = await readRunnerRegistrationIdentity(paths.sessionDirectory);
    const lifecycle = await this.readLifecycle(paths.databasePath);
    const pid = resolveRegisteredRunnerPid(
      await readRunnerPid(paths.pidPath),
      lifecycle?.runner_pid ?? null,
      identity?.pid ?? null,
      paths.sessionDirectory,
      this.deps.isPidAlive,
    );
    if (pid === null || !this.deps.isPidAlive(pid)) return null;
    if (!identity || identity.pid === null || identity.startIdentity === null) return null;
    const observed = await this.deps.inspectProcess(pid);
    if (
      identity.pid !== pid
      || !observed.alive
      || !observed.startIdentity
      || !processStartIdentitiesMatch(observed.startIdentity, identity.startIdentity)
    ) return null;
    const config = await readRunnerChildConfig(paths.configPath);
    if (config.sessionId !== input.sessionId || !samePaths(config.paths, paths)) {
      throw new Error(`runner registration mismatch for ${input.sessionId}`);
    }
    return { pid, paths, config, adopted: true };
  }
  async terminate(
    paths: RunnerProcessPaths,
    expected?: { pid: number; startIdentity: string },
  ): Promise<void> {
    await this.stopExistingRunner(paths, expected);
  }

  async invalidateRegistration(
    paths: RunnerProcessPaths,
    expectedRegistrationId: string | null,
  ): Promise<void> {
    await withRunnerSessionMutationLock(paths.sessionDirectory, async () => {
      await invalidateRunnerRegistrationIdentity(
        paths.sessionDirectory,
        expectedRegistrationId,
      );
      await unlinkIfPresent(paths.pidPath);
      await unlinkIfPresent(paths.socketPath);
    });
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

  private async stopExistingRunner(
    paths: RunnerProcessPaths,
    expected?: { pid: number; startIdentity: string },
  ): Promise<void> {
    const identity = await readRunnerRegistrationIdentity(paths.sessionDirectory);
    const lifecycle = await this.readLifecycle(paths.databasePath);
    const pid = resolveRegisteredRunnerPid(
      await readRunnerPid(paths.pidPath),
      lifecycle?.runner_pid ?? null,
      identity?.pid ?? null,
      paths.sessionDirectory,
      this.deps.isPidAlive,
    );
    if (pid !== null && this.deps.isPidAlive(pid)) {
      const owner = expected ?? (identity?.pid === pid && identity.startIdentity
        ? { pid, startIdentity: identity.startIdentity }
        : undefined);
      if (!owner || owner.pid !== pid) {
        throw new Error(`runner process identity unavailable before termination: ${pid}`);
      }
      await this.assertSameProcess(owner, "SIGTERM");
      this.deps.signalPid(pid, "SIGTERM");
      const deadline = this.deps.now() + EXISTING_RUNNER_STOP_TIMEOUT_MS;
      while (this.deps.isPidAlive(pid) && this.deps.now() < deadline) {
        await this.deps.delay(25);
      }
      if (this.deps.isPidAlive(pid)) {
        await this.assertSameProcess(owner, "SIGKILL");
        this.deps.signalPid(pid, "SIGKILL");
        const killDeadline = this.deps.now() + EXISTING_RUNNER_STOP_TIMEOUT_MS;
        while (this.deps.isPidAlive(pid) && this.deps.now() < killDeadline) {
          await this.deps.delay(25);
        }
      }
      if (this.deps.isPidAlive(pid)) {
        throw new Error(`existing runner pid ${pid} did not terminate`);
      }
    }
    await unlinkIfPresent(paths.pidPath);
    await unlinkIfPresent(paths.socketPath);
  }

  private async assertSameProcess(
    expected: { pid: number; startIdentity: string },
    signal: NodeJS.Signals,
  ): Promise<void> {
    const observed = await this.deps.inspectProcess(expected.pid);
    if (
      !observed.alive
      || observed.startIdentity === null
      || !processStartIdentitiesMatch(observed.startIdentity, expected.startIdentity)
    ) {
      throw new Error(
        `runner process identity changed before ${signal}: ${expected.pid}`,
      );
    }
  }

  private async readLifecycle(
    databasePath: string,
  ): Promise<RunnerLifecycleRecord | null> {
    return await (this.deps.readLifecycle ?? readAuthoritativeRunnerLifecycle)(databasePath);
  }
}

function defaultDependencies(): SpawnDependencies {
  const delay = async (ms: number) => await new Promise<void>(
    (resolveDelay) => setTimeout(resolveDelay, ms),
  );
  return {
    prepareDatabase: async (path) => {
      const outbox = await RunnerSqliteEventOutbox.create(path);
      outbox.close();
    },
    validateEntry: async (path) => await access(path),
    spawnProcess: (entry, args, options) => spawn(process.execPath, [entry, ...args], options),
    registerPid: async (path, pid) => await writeFile(path, `${pid}\n`, { mode: 0o600 }),
    inspectProcess: inspectProcessIdentity,
    waitForChildRegistrationIdentity: async (paths, pending, pid) =>
      await waitForChildRunnerRegistrationIdentity(paths.sessionDirectory, pending, pid, {
        isPidAlive: isProcessAlive,
        now: Date.now,
        delay,
      }),
    isPidAlive: isProcessAlive,
    signalPid: (pid, signal) => process.kill(pid, signal),
    now: Date.now,
    delay,
  };
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
    && left.configPath === right.configPath
    && left.logPath === right.logPath;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
export { readRunnerPid, resolveRegisteredRunnerPid } from "./runner_process_registration.js";

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

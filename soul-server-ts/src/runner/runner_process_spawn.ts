import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Logger } from "pino";

import {
  parseRunnerChildConfig,
  type RunnerChildConfig,
} from "./runner_child_config.js";
import { runnerProcessPaths, type RunnerProcessPaths } from "./runner_process_paths.js";
import { RunnerSqliteEventOutbox } from "./sqlite_event_outbox.js";
import {
  defaultProcessOwnershipLockDependencies,
  inspectProcessIdentity,
  processStartIdentitiesMatch,
  type ProcessIdentity,
} from "./runner_process_lock.js";
import { RunnerMutationFailure } from "./runner_mutation_failure.js";
import { withRunnerSessionMutationLock } from "./runner_session_mutation_lock.js";
import {
  stopExistingRunnerLocked,
  terminateExactRunner,
  type ExactRunnerProcess,
  type RunnerTerminationOutcome,
} from "./runner_process_termination.js";
import {
  pendingRunnerRegistrationIdentity,
  readRunnerRegistrationIdentity,
  type RunnerRegistrationIdentity,
  waitForChildRunnerRegistrationIdentity,
  writeRunnerRegistrationIdentity,
} from "./runner_registration_identity.js";
import {
  invalidateRunnerRegistrationFilesLocked,
  invalidateRunnerRegistrationFiles,
  retireTerminalRunnerRegistrationFilesLocked,
} from "./runner_registration_mutation.js";
import {
  inspectRunnerWriterLock,
  prepareRunnerWriterLockForSpawn,
  type RunnerWriterLockState,
} from "./runner_writer_lock.js";
import type { RunnerRegistration } from "./runner_process_registry.js";
import {
  retireReleasedTerminalExecutionEvidence,
  retireTerminalExecutionIdentity,
  type TerminalExecutionOwnershipRetirement,
} from "./runner_terminal_identity_retirement.js";

export {
  RunnerChildConfigSchema,
  parseRunnerChildConfig,
  type RunnerChildConfig,
} from "./runner_child_config.js";

export interface SpawnRunnerProcessInput extends Omit<RunnerChildConfig, "schemaVersion" | "paths"> {
  stateDirectory: string;
  childProcessEnv?: NodeJS.ProcessEnv;
  /** Host-only preparation; never serialized into the child config. */
  prepareSnapshot?: () => Promise<void>;
}

export interface SpawnedRunnerProcess {
  pid: number;
  registrationId: string;
  paths: RunnerProcessPaths;
  config: RunnerChildConfig;
  adopted: boolean;
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
  inspectWriterLock?(path: string): Promise<RunnerWriterLockState>;
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
    await stopExistingRunnerLocked(paths, this.deps, undefined, "replacement");
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
    let childProcessProof: ExactRunnerProcess | undefined;
    let childAbsenceProven = false;
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
        childProcessProof = {
          pid: child.pid,
          startIdentity: childIdentity.startIdentity,
        };
      } else {
        const observed = await this.inspectWriterLock(paths.lockPath);
        if (observed.kind === "free" && !this.deps.inspectWriterLock) {
          // Injected legacy snapshot adapters predate child identity publication
          // and the kernel lock. Production dependencies always provide both.
          const legacy = await this.deps.inspectProcess(child.pid);
          if (!legacy.alive) {
            childAbsenceProven = true;
            throw new Error(`detached runner process exited before registration: ${child.pid}`);
          }
          if (!legacy.startIdentity) {
            this.logger?.info(
              { sessionId: input.sessionId, pid: child.pid },
              "Legacy runner identity lookup was unavailable; child was left intact",
            );
            throw new RunnerMutationFailure(
              "runner_registration_identity_proof_failed",
              `detached runner process identity unavailable: ${child.pid}`,
            );
          }
          childProcessProof = { pid: child.pid, startIdentity: legacy.startIdentity };
          await writeRunnerRegistrationIdentity(paths.sessionDirectory, {
            ...registrationIdentity,
            pid: child.pid,
            startIdentity: legacy.startIdentity,
          });
        } else if (observed.kind === "free") {
          childAbsenceProven = true;
          throw new Error(`detached runner process exited before registration: ${child.pid}`);
        } else if (observed.kind === "unavailable" || observed.owner.pid !== child.pid) {
          this.logger?.info(
            { sessionId: input.sessionId, pid: child.pid },
            "Live runner lock ownership was unavailable; child was left intact",
          );
          throw new RunnerMutationFailure(
            "runner_registration_identity_proof_failed",
            `detached runner lock ownership unavailable: ${child.pid}`,
          );
        } else {
          childProcessProof = observed.owner;
          await writeRunnerRegistrationIdentity(paths.sessionDirectory, {
            ...registrationIdentity,
            pid: child.pid,
            startIdentity: observed.owner.startIdentity,
          });
        }
      }
      await this.deps.registerPid(paths.pidPath, child.pid);
    } catch (registrationError) {
      try {
        if (childProcessProof) {
          await terminateExactRunner(childProcessProof, this.deps, paths.lockPath);
        } else if (!childAbsenceProven) {
          if (registrationError instanceof RunnerMutationFailure) throw registrationError;
          throw new RunnerMutationFailure(
            "runner_registration_identity_proof_failed",
            `detached runner cleanup has no exact process identity: ${child.pid}`,
            { cause: registrationError },
          );
        }
        await invalidateRunnerRegistrationFilesLocked(
          paths,
          registrationIdentity.registrationId,
          "replacement",
        );
      } catch (cleanupError) {
        if (cleanupError instanceof RunnerMutationFailure) throw cleanupError;
        throw new RunnerMutationFailure(
          "runner_registration_persistence_failed",
          `detached runner cleanup could not preserve registration: ${child.pid}`,
          { cause: new AggregateError([registrationError, cleanupError]) },
        );
      } finally {
        child.unref();
      }
      throw registrationError;
    }
    child.unref();
    return {
      pid: child.pid,
      registrationId: registrationIdentity.registrationId,
      paths,
      config: validatedConfig,
      adopted: false,
    };
  }
  async adopt(registration: RunnerRegistration): Promise<SpawnedRunnerProcess | null> {
    const { config, pid, pidStartIdentity, registrationId } = registration;
    if (!registrationId || !pidStartIdentity) return null;
    if (pid === null) return null;
    return await withRunnerSessionMutationLock(config.paths.sessionDirectory, async () => {
      const current = await readRunnerRegistrationIdentity(config.paths.sessionDirectory);
      if (
        !current
        || current.retiredAt
        || current.registrationId !== registrationId
        || current.pid !== pid
        || current.startIdentity === null
        || !processStartIdentitiesMatch(current.startIdentity, pidStartIdentity)
      ) return null;
      if (!this.deps.inspectWriterLock) {
        const observed = await this.deps.inspectProcess(pid);
        if (
          !observed.alive
          || !observed.startIdentity
          || !processStartIdentitiesMatch(observed.startIdentity, current.startIdentity)
        ) return null;
        return { pid, registrationId, paths: config.paths, config, adopted: true };
      }
      const observed = await this.deps.inspectWriterLock(config.paths.lockPath);
      if (
        observed.kind !== "held"
        || observed.owner.pid !== pid
        || !processStartIdentitiesMatch(observed.owner.startIdentity, current.startIdentity)
      ) return null;
      return { pid, registrationId, paths: config.paths, config, adopted: true };
    });
  }
  async terminate(
    paths: RunnerProcessPaths,
    expected?: ExactRunnerProcess,
    releasedRegistration?: RunnerRegistration,
    confirmCentralRelease?: () => Promise<boolean>,
  ): Promise<RunnerTerminationOutcome> {
    if (!expected) {
      if (!releasedRegistration || !confirmCentralRelease) {
        throw new RunnerMutationFailure(
          "runner_registration_identity_proof_failed",
          `released terminal evidence required before termination: ${paths.sessionDirectory}`,
        );
      }
      await retireReleasedTerminalExecutionEvidence(
        {
          paths,
          registrationId: releasedRegistration.registrationId ?? null,
        },
        confirmCentralRelease,
        this.deps,
      );
      return "registration_absent";
    }
    return await withRunnerSessionMutationLock(paths.sessionDirectory, async () => {
      return await stopExistingRunnerLocked(paths, this.deps, expected, "strict");
    });
  }

  /**
   * Disposition for a registration that no longer proves an identity.
   *
   * Registration fields are observational residue. `stopExistingRunnerLocked`
   * decides whether the runner is alive from the session's kernel writer lock,
   * then uses that lock's exact owner if termination is required.
   */
  async disposeUnprovenRegistration(
    paths: RunnerProcessPaths,
  ): Promise<RunnerTerminationOutcome> {
    return await withRunnerSessionMutationLock(paths.sessionDirectory, async () => {
      return await stopExistingRunnerLocked(paths, this.deps, undefined, "strict");
    });
  }

  invalidateRegistration(
    paths: RunnerProcessPaths,
    expectedRegistrationId: string | null,
  ): Promise<void> {
    return invalidateRunnerRegistrationFiles(paths, expectedRegistrationId);
  }

  retireTerminalRegistration(
    paths: RunnerProcessPaths,
    expectedRegistrationId: string | null,
  ): Promise<void> {
    return withRunnerSessionMutationLock(paths.sessionDirectory, async () => {
      const identity = await readRunnerRegistrationIdentity(paths.sessionDirectory);
      if (!identity || expectedRegistrationId === null
        || identity.registrationId !== expectedRegistrationId) {
        throw new RunnerMutationFailure(
          "runner_registration_identity_proof_failed",
          `runner registration changed before terminal retirement: ${paths.sessionDirectory}`,
        );
      }
      if (identity.pid !== null && identity.startIdentity !== null) {
        await terminateExactRunner(
          { pid: identity.pid, startIdentity: identity.startIdentity },
          this.deps,
          paths.lockPath,
        );
      }
      await retireTerminalRunnerRegistrationFilesLocked(
        paths,
        expectedRegistrationId,
        new Date(this.deps.now()),
      );
    });
  }

  retireTerminalOwnership(
    input: TerminalExecutionOwnershipRetirement,
    commitOwnership: () => Promise<boolean>,
  ): Promise<void> {
    return retireTerminalExecutionIdentity(input, commitOwnership, this.deps);
  }

  private async inspectWriterLock(path: string): Promise<RunnerWriterLockState> {
    if (this.deps.inspectWriterLock) return await this.deps.inspectWriterLock(path);
    const defaults = defaultProcessOwnershipLockDependencies();
    return await inspectRunnerWriterLock(path, {
      now: this.deps.now,
      delay: this.deps.delay,
      currentOwner: defaults.currentOwner,
      inspectProcess: this.deps.inspectProcess,
    });
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
    inspectWriterLock: inspectRunnerWriterLock,
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
export { readRunnerPid, resolveRegisteredRunnerPid } from "./runner_process_registration.js";

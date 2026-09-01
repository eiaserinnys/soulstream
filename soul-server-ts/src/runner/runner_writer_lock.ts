import { randomUUID } from "node:crypto";
import { access, link, open, readFile, rm, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { RunnerKernelLock } from "./runner_kernel_lock.js";
import {
  defaultProcessOwnershipLockDependencies,
  processStartIdentitiesMatch,
  type ProcessLockOwner,
  type ProcessOwnershipLockDependencies,
} from "./runner_process_lock.js";

const KERNEL_LOCK_SCHEMA_VERSION = 2;
const KERNEL_LOCK_KIND = "kernel-endpoint";

interface KernelWriterLockRecord extends ProcessLockOwner {
  schemaVersion: typeof KERNEL_LOCK_SCHEMA_VERSION;
  lockKind: typeof KERNEL_LOCK_KIND;
}

type StoredWriterLock =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "kernel"; owner: ProcessLockOwner }
  | { kind: "legacy"; owner: ProcessLockOwner };

export type RunnerWriterLockState =
  | { kind: "free" }
  | { kind: "held"; owner: ProcessLockOwner }
  | { kind: "unavailable" };

export class RunnerWriterLock {
  private released = false;

  private constructor(
    private readonly path: string,
    readonly owner: ProcessLockOwner,
    private readonly kernelLock: RunnerKernelLock,
  ) {}

  static async acquire(
    path: string,
    deps: ProcessOwnershipLockDependencies = defaultProcessOwnershipLockDependencies(),
  ): Promise<RunnerWriterLock> {
    const kernelLock = await RunnerKernelLock.tryAcquire(path);
    if (!kernelLock) throw new Error(`runner writer lock already held: ${path}`);
    try {
      const residue = await inspectUnlockedRecord(path, deps);
      if (residue.kind === "held") {
        throw new Error(`runner writer lock already held: ${path}`);
      }
      if (residue.kind === "unavailable") {
        throw new Error(`runner writer lock ownership unavailable: ${path}`);
      }
      const owner = await deps.currentOwner();
      await rm(path, { force: true });
      await rm(runnerWriterBootstrapPath(path), { force: true });
      await publishCompleteRecord(path, `${JSON.stringify(kernelRecord(owner))}\n`);
      return new RunnerWriterLock(path, owner, kernelLock);
    } catch (error) {
      await kernelLock.release();
      throw error;
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    let releaseError: unknown;
    try {
      const stored = await readStoredWriterLock(this.path);
      if (stored.kind !== "kernel" || !sameOwner(stored.owner, this.owner)) {
        throw new Error(`runner writer ownership changed before release: ${this.path}`);
      }
      await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    } catch (error) {
      releaseError = error;
    } finally {
      await this.kernelLock.release();
    }
    if (releaseError) throw releaseError;
  }
}

/**
 * Reads runner liveness from one owner: the OS-enforced writer lock.
 *
 * The only probe fallback is for a pre-schema-2 marker left by a runner that
 * predates the kernel lock. It preserves zero-downtime adoption across the
 * rollout and disappears from the steady-state path as those runners exit.
 */
export async function inspectRunnerWriterLock(
  path: string,
  deps: ProcessOwnershipLockDependencies = defaultProcessOwnershipLockDependencies(),
): Promise<RunnerWriterLockState> {
  let held: boolean;
  try {
    held = await RunnerKernelLock.isHeld(path);
  } catch {
    return { kind: "unavailable" };
  }
  if (held) {
    const stored = await readStoredWriterLock(path);
    return stored.kind === "kernel" || stored.kind === "legacy"
      ? { kind: "held", owner: stored.owner }
      : { kind: "unavailable" };
  }
  return await inspectUnlockedRecord(path, deps);
}

/** Clears a free lock's observational residue and rejects every live/unknown owner. */
export async function prepareRunnerWriterLockForSpawn(
  path: string,
  deps: ProcessOwnershipLockDependencies = defaultProcessOwnershipLockDependencies(),
): Promise<boolean> {
  if (!await pathExists(dirname(path))) return false;
  const residuePresent = await pathExists(path) || await pathExists(runnerWriterBootstrapPath(path));
  const lock = await RunnerWriterLock.acquire(path, deps);
  await lock.release();
  return residuePresent;
}

/** Retained only so pre-kernel bootstrap residue can be cleaned during migration. */
export function runnerWriterBootstrapPath(path: string): string {
  return `${path}.bootstrap`;
}

async function inspectUnlockedRecord(
  path: string,
  deps: ProcessOwnershipLockDependencies,
): Promise<RunnerWriterLockState> {
  const stored = await readStoredWriterLock(path);
  if (stored.kind === "absent" || stored.kind === "kernel") return { kind: "free" };
  if (stored.kind === "invalid") return { kind: "unavailable" };

  const currentOwner = await deps.currentOwner();
  if (sameOwner(stored.owner, currentOwner)) return { kind: "free" };
  let observed;
  try {
    observed = await deps.inspectProcess(stored.owner.pid);
  } catch {
    return { kind: "unavailable" };
  }
  if (!observed.alive) return { kind: "free" };
  if (stored.owner.startIdentity === "legacy-pid-only") {
    return { kind: "held", owner: stored.owner };
  }
  if (observed.startIdentity === null) return { kind: "unavailable" };
  return processStartIdentitiesMatch(observed.startIdentity, stored.owner.startIdentity)
    ? { kind: "held", owner: stored.owner }
    : { kind: "free" };
}

async function readStoredWriterLock(path: string): Promise<StoredWriterLock> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "invalid" };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isProcessLockOwner(parsed)) return legacyPidOnlyRecord(raw);
    const owner = { pid: parsed.pid, startIdentity: parsed.startIdentity };
    if (
      (parsed as Partial<KernelWriterLockRecord>).schemaVersion === KERNEL_LOCK_SCHEMA_VERSION
      && (parsed as Partial<KernelWriterLockRecord>).lockKind === KERNEL_LOCK_KIND
    ) {
      return { kind: "kernel", owner };
    }
    return { kind: "legacy", owner };
  } catch {
    return legacyPidOnlyRecord(raw);
  }
}

function legacyPidOnlyRecord(raw: string): StoredWriterLock {
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(pid) && pid > 0
    ? { kind: "legacy", owner: { pid, startIdentity: "legacy-pid-only" } }
    : { kind: "invalid" };
}

function kernelRecord(owner: ProcessLockOwner): KernelWriterLockRecord {
  return {
    schemaVersion: KERNEL_LOCK_SCHEMA_VERSION,
    lockKind: KERNEL_LOCK_KIND,
    ...owner,
  };
}

function isProcessLockOwner(value: unknown): value is ProcessLockOwner {
  return typeof value === "object"
    && value !== null
    && Number.isSafeInteger((value as { pid?: unknown }).pid)
    && (value as { pid: number }).pid > 0
    && typeof (value as { startIdentity?: unknown }).startIdentity === "string"
    && (value as { startIdentity: string }).startIdentity.length > 0;
}

function sameOwner(left: ProcessLockOwner, right: ProcessLockOwner): boolean {
  return left.pid === right.pid
    && processStartIdentitiesMatch(left.startIdentity, right.startIdentity);
}

async function publishCompleteRecord(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

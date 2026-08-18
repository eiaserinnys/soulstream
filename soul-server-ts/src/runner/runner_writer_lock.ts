import { randomUUID } from "node:crypto";
import {
  access,
  link,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { resolve } from "node:path";

import {
  defaultProcessOwnershipLockDependencies,
  isProvenStale,
  readProcessLockOwner,
  type ProcessLockOwner,
  type ProcessOwnershipLockDependencies,
} from "./runner_process_lock.js";

const activeWriterOwners = new Map<string, ProcessLockOwner>();
const WRITER_BOOTSTRAP_LEASE_MS = 30_000;

interface RunnerWriterBootstrap {
  schemaVersion: 1;
  nonce: string;
  expiresAtMs: number;
}

export class RunnerWriterLock {
  private released = false;

  private constructor(
    private readonly path: string,
    private readonly owner: ProcessLockOwner,
  ) {}

  static async acquire(
    path: string,
    deps: ProcessOwnershipLockDependencies = defaultProcessOwnershipLockDependencies(),
  ): Promise<RunnerWriterLock> {
    while (true) {
      if (await pathExists(path)) {
        if (await reclaimStaleWriterLock(path, deps)) continue;
        throw new Error(`runner writer lock already held: ${path}`);
      }
      const bootstrap = await claimWriterBootstrap(path, deps);
      if (!bootstrap) {
        if (await reclaimExpiredWriterBootstrap(path, deps)) continue;
        throw new Error(`runner writer lock already held: ${path}`);
      }
      try {
        if (await pathExists(path)) {
          if (await reclaimStaleWriterLock(path, deps)) continue;
          throw new Error(`runner writer lock already held: ${path}`);
        }
        const owner = await deps.currentOwner();
        await publishCompleteRecord(path, `${JSON.stringify(owner)}\n`);
        activeWriterOwners.set(resolve(path), owner);
        return new RunnerWriterLock(path, owner);
      } finally {
        // The complete owner record is already the fence. A bootstrap cleanup
        // failure must not turn a successful acquisition into an apparent
        // failure and strand that owner; its finite lease remains recoverable.
        await releaseWriterBootstrap(path, bootstrap.nonce).catch(() => undefined);
      }
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    try {
      const current = await readProcessLockOwner(this.path);
      if (!sameOwner(current, this.owner)) {
        throw new Error(`runner writer ownership changed before release: ${this.path}`);
      }
      try {
        await unlink(this.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } finally {
      if (sameOwner(activeWriterOwners.get(resolve(this.path)) ?? null, this.owner)) {
        activeWriterOwners.delete(resolve(this.path));
      }
      this.released = true;
    }
  }
}

/**
 * Clears only a proven stale or current-process orphan before child spawn.
 * A live child owner and a host lock with a live in-process object stay fenced.
 */
export async function prepareRunnerWriterLockForSpawn(
  path: string,
  deps: ProcessOwnershipLockDependencies = defaultProcessOwnershipLockDependencies(),
): Promise<boolean> {
  const bootstrapReclaimed = await reclaimExpiredWriterBootstrap(path, deps);
  if (!await pathExists(path)) return bootstrapReclaimed;
  if (await reclaimStaleWriterLock(path, deps)) return true;
  throw new Error(`runner writer lock already held: ${path}`);
}

export function runnerWriterBootstrapPath(path: string): string {
  return `${path}.bootstrap`;
}

async function claimWriterBootstrap(
  path: string,
  deps: ProcessOwnershipLockDependencies,
): Promise<RunnerWriterBootstrap | null> {
  const bootstrap = {
    schemaVersion: 1 as const,
    nonce: randomUUID(),
    expiresAtMs: deps.now() + WRITER_BOOTSTRAP_LEASE_MS,
  };
  try {
    await publishCompleteRecord(
      runnerWriterBootstrapPath(path),
      `${JSON.stringify(bootstrap)}\n`,
    );
    return bootstrap;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
}

async function reclaimExpiredWriterBootstrap(
  path: string,
  deps: ProcessOwnershipLockDependencies,
): Promise<boolean> {
  const bootstrapPath = runnerWriterBootstrapPath(path);
  let bootstrap: RunnerWriterBootstrap | null = null;
  try {
    const parsed = JSON.parse(await readFile(bootstrapPath, "utf8")) as unknown;
    if (
      typeof parsed === "object"
      && parsed !== null
      && (parsed as Partial<RunnerWriterBootstrap>).schemaVersion === 1
      && typeof (parsed as Partial<RunnerWriterBootstrap>).nonce === "string"
      && Number.isFinite((parsed as Partial<RunnerWriterBootstrap>).expiresAtMs)
    ) {
      bootstrap = parsed as RunnerWriterBootstrap;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
  }
  const expiresAtMs = bootstrap?.expiresAtMs
    ?? (await stat(bootstrapPath)).mtimeMs + WRITER_BOOTSTRAP_LEASE_MS;
  if (expiresAtMs > deps.now()) return false;
  const quarantinePath = `${bootstrapPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(bootstrapPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  await rm(quarantinePath, { force: true });
  return true;
}

async function releaseWriterBootstrap(path: string, nonce: string): Promise<void> {
  const bootstrapPath = runnerWriterBootstrapPath(path);
  try {
    const parsed = JSON.parse(await readFile(bootstrapPath, "utf8")) as Partial<RunnerWriterBootstrap>;
    if (parsed.nonce !== nonce) return;
    await unlink(bootstrapPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
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

async function reclaimStaleWriterLock(
  path: string,
  deps: ProcessOwnershipLockDependencies,
): Promise<boolean> {
  const owner = await readWriterLockOwner(path);
  if (!owner) return false;
  const activeOwner = activeWriterOwners.get(resolve(path));
  if (sameOwner(activeOwner ?? null, owner)) return false;
  const currentOwner = await deps.currentOwner();
  const orphanedCurrentOwner = sameOwner(currentOwner, owner);
  const stale = orphanedCurrentOwner || (owner.startIdentity === "legacy-pid-only"
    ? !(await deps.inspectProcess(owner.pid)).alive
    : await isProvenStale(owner, deps));
  if (!stale) return false;
  const quarantinePath = `${path}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(path, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  await rm(quarantinePath, { force: true });
  return true;
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

function sameOwner(left: ProcessLockOwner | null, right: ProcessLockOwner): boolean {
  return left?.pid === right.pid && left.startIdentity === right.startIdentity;
}

async function readWriterLockOwner(path: string): Promise<ProcessLockOwner | null> {
  const owner = await readProcessLockOwner(path);
  if (owner) return owner;

  // A pre-fence runner wrote only its pid. It is reclaimable only when that pid
  // is proven dead; a live or reused pid remains fail-closed.
  try {
    const pid = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    return { pid, startIdentity: "legacy-pid-only" };
  } catch {
    return null;
  }
}

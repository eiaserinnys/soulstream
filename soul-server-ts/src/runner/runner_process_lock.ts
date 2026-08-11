import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const LOCK_RETRY_MS = 50;
const execFileAsync = promisify(execFile);
const currentProcessFallbackIdentity = `node-start-${Math.round(
  Date.now() - process.uptime() * 1_000,
)}`;
let currentProcessStartIdentity: Promise<string> | undefined;

export interface ProcessLockOwner {
  pid: number;
  startIdentity: string;
}

export interface ProcessIdentity {
  alive: boolean;
  startIdentity: string | null;
}

export interface ProcessOwnershipLockDependencies {
  now(): number;
  delay(ms: number): Promise<void>;
  currentOwner(): Promise<ProcessLockOwner>;
  inspectProcess(pid: number): Promise<ProcessIdentity>;
}

export class ProcessOwnershipDirectoryLock {
  private released = false;

  private constructor(
    readonly path: string,
    private readonly owner: ProcessLockOwner,
  ) {}

  static async acquire(options: {
    path: string;
    timeoutMs: number;
    heldMessage: string;
    deps?: ProcessOwnershipLockDependencies;
  }): Promise<ProcessOwnershipDirectoryLock> {
    const deps = options.deps ?? defaultProcessOwnershipLockDependencies();
    await mkdir(dirname(options.path), { recursive: true });
    const deadline = deps.now() + options.timeoutMs;
    while (true) {
      try {
        await mkdir(options.path);
        const owner = await deps.currentOwner();
        try {
          await writeFile(
            join(options.path, "owner.json"),
            `${JSON.stringify(owner)}\n`,
            { encoding: "utf8", flag: "wx", mode: 0o600 },
          );
        } catch (error) {
          await rm(options.path, { recursive: true, force: true });
          throw error;
        }
        return new ProcessOwnershipDirectoryLock(options.path, owner);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await reclaimStaleOwnershipDirectory(options.path, deps)) continue;
        if (deps.now() >= deadline) throw new Error(options.heldMessage);
        await deps.delay(LOCK_RETRY_MS);
      }
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    const current = await readProcessLockOwner(join(this.path, "owner.json"));
    if (!sameOwner(current, this.owner)) {
      throw new Error(`process ownership changed before release: ${this.path}`);
    }
    await rm(this.path, { recursive: true, force: true });
    this.released = true;
  }
}

export async function reclaimStaleOwnershipDirectory(
  path: string,
  deps: ProcessOwnershipLockDependencies,
): Promise<boolean> {
  const owner = await readProcessLockOwner(join(path, "owner.json"));
  if (!owner || !await isProvenStale(owner, deps)) return false;
  const quarantinePath = `${path}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(path, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  await rm(quarantinePath, { recursive: true, force: true });
  return true;
}

export async function isProvenStale(
  owner: ProcessLockOwner,
  deps: Pick<ProcessOwnershipLockDependencies, "inspectProcess">,
): Promise<boolean> {
  const observed = await deps.inspectProcess(owner.pid);
  return !observed.alive
    || (observed.startIdentity !== null && observed.startIdentity !== owner.startIdentity);
}

export async function readProcessLockOwner(path: string): Promise<ProcessLockOwner | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || !Number.isInteger((parsed as { pid?: unknown }).pid)
    || (parsed as { pid: number }).pid <= 0
    || typeof (parsed as { startIdentity?: unknown }).startIdentity !== "string"
    || !(parsed as { startIdentity: string }).startIdentity
  ) return null;
  return parsed as ProcessLockOwner;
}

export function defaultProcessOwnershipLockDependencies(): ProcessOwnershipLockDependencies {
  return {
    now: Date.now,
    delay: async (ms) => await new Promise((resolveDelay) => setTimeout(resolveDelay, ms)),
    currentOwner: async () => ({
      pid: process.pid,
      startIdentity: await getCurrentProcessStartIdentity(),
    }),
    inspectProcess: inspectProcessIdentity,
  };
}

async function getCurrentProcessStartIdentity(): Promise<string> {
  currentProcessStartIdentity ??= readProcessStartIdentity(process.pid)
    .then((identity) => identity ?? currentProcessFallbackIdentity);
  return await currentProcessStartIdentity;
}

export async function inspectProcessIdentity(pid: number): Promise<ProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`process identity pid must be positive: ${pid}`);
  }
  if (!isProcessAlive(pid)) return { alive: false, startIdentity: null };
  return {
    alive: true,
    startIdentity: await readProcessStartIdentity(pid),
  };
}

function sameOwner(left: ProcessLockOwner | null, right: ProcessLockOwner): boolean {
  return left?.pid === right.pid && left.startIdentity === right.startIdentity;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readProcessStartIdentity(pid: number): Promise<string | null> {
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
        ],
        { timeout: 5_000, windowsHide: true },
      );
      const ticks = stdout.trim();
      return ticks ? `windows-process-${ticks}` : null;
    } catch {
      return null;
    }
  }
  if (process.platform !== "linux") return null;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return null;
    const fields = stat.slice(closeParen + 1).trim().split(/\s+/);
    const startTime = fields[19];
    return startTime ? `linux-proc-${startTime}` : null;
  } catch {
    return null;
  }
}

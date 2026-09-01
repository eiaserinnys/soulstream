import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const LOCK_RETRY_MS = 50;
const WINDOWS_EPOCH_OFFSET_TICKS = 621_355_968_000_000_000n;
const PROCESS_START_IDENTITY_TOLERANCE_MS = 2_000;
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

/**
 * What the OS can say about the process behind a pid number.
 *
 * `absent` and `command_line` are answers about the process itself, so a caller
 * may act on them. `unavailable` means the OS refused or could not tell -- a
 * protected Windows process whose `CommandLine` is null, a probe that failed,
 * an unsupported platform -- and must never be read as either proof or denial.
 */
export type ProcessCommandLineProbe =
  | { kind: "absent" }
  | { kind: "command_line"; value: string }
  | { kind: "unavailable" };

/**
 * Measured on eias-linegames (Windows 11, 10.0.26200): a bare
 * `powershell.exe -NoProfile` start costs ~2.5s and the CIM query brings the
 * round trip to 5.4-5.7s. A 5s budget sits below that floor, and a timeout here
 * reports `unavailable`, which fails resume closed -- the very death this probe
 * exists to end. The budget is sized for a loaded host, not for the best case.
 */
const COMMAND_LINE_PROBE_TIMEOUT_MS = 20_000;
const WINDOWS_PROBE_ABSENT_MARKER = "process-absent";
const WINDOWS_PROBE_COMMAND_LINE_MARKER = "process-command-line:";

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
    || (observed.startIdentity !== null
      && !processStartIdentitiesMatch(observed.startIdentity, owner.startIdentity));
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
  if (process.platform === "win32") return currentProcessFallbackIdentity;
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
  return left?.pid === right.pid
    && processStartIdentitiesMatch(left.startIdentity, right.startIdentity);
}

export function processStartIdentitiesMatch(left: string, right: string): boolean {
  if (left === right) return true;
  const leftEpochMs = processStartEpochMs(left);
  const rightEpochMs = processStartEpochMs(right);
  return leftEpochMs !== null
    && rightEpochMs !== null
    && leftEpochMs.kind !== rightEpochMs.kind
    && Math.abs(leftEpochMs.value - rightEpochMs.value) <= PROCESS_START_IDENTITY_TOLERANCE_MS;
}

function processStartEpochMs(
  identity: string,
): { kind: "node" | "windows"; value: number } | null {
  const nodeMatch = /^node-start-(\d+)$/.exec(identity);
  if (nodeMatch) {
    const epochMs = Number(nodeMatch[1]);
    return Number.isSafeInteger(epochMs) ? { kind: "node", value: epochMs } : null;
  }
  const windowsMatch = /^windows-process-(\d+)$/.exec(identity);
  if (!windowsMatch) return null;
  try {
    const epochMs = Number((BigInt(windowsMatch[1]!) - WINDOWS_EPOCH_OFFSET_TICKS) / 10_000n);
    return Number.isSafeInteger(epochMs) ? { kind: "windows", value: epochMs } : null;
  } catch {
    return null;
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

/**
 * Reads the command line of a pid. Unlike `isProcessAlive`, which only reports
 * whether the *number* is claimable, this asks the OS what the process behind
 * the number actually is, which is the only evidence that survives pid reuse.
 */
export async function readProcessCommandLine(pid: number): Promise<ProcessCommandLineProbe> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`process command line pid must be positive: ${pid}`);
  }
  if (process.platform === "win32") return await readWindowsProcessCommandLine(pid);
  if (process.platform === "linux") return await readLinuxProcessCommandLine(pid);
  return { kind: "unavailable" };
}

async function readWindowsProcessCommandLine(pid: number): Promise<ProcessCommandLineProbe> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$found = @(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop); `
        + `if ($found.Count -eq 0) { '${WINDOWS_PROBE_ABSENT_MARKER}' } `
        + `else { '${WINDOWS_PROBE_COMMAND_LINE_MARKER}' + $found[0].CommandLine }`,
      ],
      { timeout: COMMAND_LINE_PROBE_TIMEOUT_MS, windowsHide: true },
    ));
  } catch {
    return { kind: "unavailable" };
  }
  const reported = stdout.trim();
  if (reported === WINDOWS_PROBE_ABSENT_MARKER) return { kind: "absent" };
  if (!reported.startsWith(WINDOWS_PROBE_COMMAND_LINE_MARKER)) return { kind: "unavailable" };
  const commandLine = reported.slice(WINDOWS_PROBE_COMMAND_LINE_MARKER.length).trim();
  // The process exists but hides its command line (protected process, or a
  // CommandLine this account may not read). Existence alone proves nothing.
  return commandLine ? { kind: "command_line", value: commandLine } : { kind: "unavailable" };
}

async function readLinuxProcessCommandLine(pid: number): Promise<ProcessCommandLineProbe> {
  let raw: string;
  try {
    raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "unavailable" };
  }
  // argv arrives NUL-separated; kernel threads report nothing at all.
  const commandLine = raw.split("\0").filter((argument) => argument !== "").join(" ").trim();
  return commandLine ? { kind: "command_line", value: commandLine } : { kind: "unavailable" };
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

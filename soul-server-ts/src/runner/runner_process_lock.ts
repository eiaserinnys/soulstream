import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const LOCK_RETRY_MS = 50;
/**
 * A lock directory with no owner record is either an abandoned acquisition or
 * a live writer that has not renamed its staging directory into place yet.
 * Only age proves abandonment.
 */
export const OWNERLESS_LOCK_GRACE_MS = 30_000;
const WINDOWS_EPOCH_OFFSET_TICKS = 621_355_968_000_000_000n;
const PROCESS_START_IDENTITY_TOLERANCE_MS = 2_000;
const DARWIN_PROCESS_PROBE_TIMEOUT_MS = 2_000;
const DARWIN_LSTART_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DARWIN_LSTART_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
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

export type ProcessStartIdentityProbe =
  | { kind: "absent" }
  | { kind: "identity"; value: string }
  | { kind: "unavailable" };

/**
 * Migration-only budget for pre-kernel ownership markers.
 *
 * Runner liveness never reaches this PowerShell probe: schema-2 runners use the
 * kernel writer lock. The explicit three-state result keeps a slow or failed
 * legacy lookup fail-closed instead of turning it into false process absence.
 */
const WINDOWS_PROCESS_PROBE_TIMEOUT_MS = 20_000;
const WINDOWS_PROBE_ABSENT_MARKER = "process-absent";
const WINDOWS_PROBE_UNAVAILABLE_MARKER = "process-unavailable";
const WINDOWS_PROBE_IDENTITY_MARKER = "process-start:";

export interface ProcessOwnershipLockDependencies {
  now(): number;
  delay(ms: number): Promise<void>;
  currentOwner(): Promise<ProcessLockOwner>;
  inspectProcess(pid: number): Promise<ProcessIdentity>;
}

export class ProcessLockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessLockTimeoutError";
  }
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
    const parent = dirname(options.path);
    await mkdir(parent, { recursive: true });
    const deadline = deps.now() + options.timeoutMs;
    while (true) {
      const owner = await deps.currentOwner();
      // The owner record is complete before the final name exists. A rename
      // publishes the whole directory at once, or replaces an empty directory
      // that an interrupted old-style acquisition left behind.
      const stagingPath = join(
        parent,
        `.${basename(options.path)}.acquire-${process.pid}-${randomUUID()}`,
      );
      await mkdir(stagingPath);
      let occupied = false;
      try {
        await writeFile(
          join(stagingPath, "owner.json"),
          `${JSON.stringify(owner)}\n`,
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
        try {
          await rename(stagingPath, options.path);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
          occupied = true;
        }
      } finally {
        await rm(stagingPath, { recursive: true, force: true });
      }
      if (!occupied) return new ProcessOwnershipDirectoryLock(options.path, owner);
      if (await reclaimStaleOwnershipDirectory(options.path, deps)) continue;
      if (deps.now() >= deadline) throw new ProcessLockTimeoutError(options.heldMessage);
      await deps.delay(LOCK_RETRY_MS);
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    const current = await readProcessLockOwner(join(this.path, "owner.json"));
    if (!sameOwner(current, this.owner)) {
      throw new Error(`process ownership changed before release: ${this.path}`);
    }
    const releasedPath = join(
      dirname(this.path),
      `.${basename(this.path)}.release-${process.pid}-${randomUUID()}`,
    );
    try {
      await rename(this.path, releasedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rm(releasedPath, { recursive: true, force: true });
    this.released = true;
  }
}

export async function reclaimStaleOwnershipDirectory(
  path: string,
  deps: ProcessOwnershipLockDependencies,
): Promise<boolean> {
  const owner = await readProcessLockOwner(join(path, "owner.json"));
  if (!owner) {
    let modifiedAt: number;
    try {
      modifiedAt = (await stat(path)).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    if (deps.now() - modifiedAt <= OWNERLESS_LOCK_GRACE_MS) return false;
    await quarantineAndRemove(path);
    return true;
  }
  if (!await isProvenStale(owner, deps)) return false;
  await quarantineAndRemove(path);
  return true;
}

async function quarantineAndRemove(path: string): Promise<void> {
  const quarantinePath = `${path}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(path, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(quarantinePath, { recursive: true, force: true });
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
    currentOwner: currentProcessLockOwner,
    inspectProcess: inspectProcessIdentity,
  };
}

export async function currentProcessLockOwner(): Promise<ProcessLockOwner> {
  return {
    pid: process.pid,
    startIdentity: await getCurrentProcessStartIdentity(),
  };
}

async function getCurrentProcessStartIdentity(): Promise<string> {
  if (process.platform === "win32") return currentProcessFallbackIdentity;
  currentProcessStartIdentity ??= readProcessStartIdentity(process.pid)
    .then((probe) => probe.kind === "identity" ? probe.value : currentProcessFallbackIdentity);
  return await currentProcessStartIdentity;
}

export async function inspectProcessIdentity(pid: number): Promise<ProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`process identity pid must be positive: ${pid}`);
  }
  if (!isProcessAlive(pid)) return { alive: false, startIdentity: null };
  const probe = await readProcessStartIdentity(pid);
  return {
    alive: probe.kind !== "absent" || isProcessAlive(pid),
    startIdentity: probe.kind === "identity" ? probe.value : null,
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
): { kind: "node" | "windows" | "darwin"; value: number } | null {
  const nodeMatch = /^node-start-(\d+)$/.exec(identity);
  if (nodeMatch) {
    const epochMs = Number(nodeMatch[1]);
    return Number.isSafeInteger(epochMs) ? { kind: "node", value: epochMs } : null;
  }
  const darwinMatch = /^darwin-process-(\d+)$/.exec(identity);
  if (darwinMatch) {
    const epochMs = Number(darwinMatch[1]);
    return Number.isSafeInteger(epochMs) ? { kind: "darwin", value: epochMs } : null;
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

/**
 * Parses the `ps -o lstart=` shape, for example `Sun Nov  8 01:57:19 2026`.
 *
 * The weekday and month tables plus Date.UTC keep the conversion independent
 * of the runtime's non-standard Date.parse behavior. A component mismatch
 * (out-of-range fields normalized by Date, or a weekday that does not belong
 * to the parsed date) is malformed output, not an identity.
 */
function parseDarwinLstart(value: string): number | null {
  const match =
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/
      .exec(value.replace(/\s+/g, " ").trim());
  if (!match) return null;
  const weekday = match[1]!;
  const month = match[2]!;
  const dayOfMonth = Number(match[3]!);
  const hours = Number(match[4]!);
  const minutes = Number(match[5]!);
  const seconds = Number(match[6]!);
  const year = Number(match[7]!);
  const monthIndex = DARWIN_LSTART_MONTHS.indexOf(month);
  const epochMs = Date.UTC(year, monthIndex, dayOfMonth, hours, minutes, seconds);
  if (!Number.isSafeInteger(epochMs)) return null;
  const parsed = new Date(epochMs);
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== monthIndex
    || parsed.getUTCDate() !== dayOfMonth
    || parsed.getUTCHours() !== hours
    || parsed.getUTCMinutes() !== minutes
    || parsed.getUTCSeconds() !== seconds
    || parsed.getUTCDay() !== DARWIN_LSTART_WEEKDAYS.indexOf(weekday)
  ) return null;
  return epochMs;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A process start time, used as the identity that survives pid reuse.
 *
 * On Windows this migration reader stays on `Get-Process`: changing its source
 * would invalidate persisted `windows-process-<ticks>` identities because CIM
 * `CreationDate` and `StartTime` do not have identical precision.
 *
 * Darwin has neither `/proc` nor PowerShell, so the start time comes from
 * `/bin/ps -o lstart=` in a fixed C locale and UTC timezone. That source is
 * second-precision and is only consulted for legacy ownership records; the
 * schema-2 runner liveness decision is the kernel lock.
 */
export async function readProcessStartIdentity(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessStartIdentityProbe> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`process start identity pid must be positive: ${pid}`);
  }
  if (platform === "darwin") {
    let stdout: string;
    try {
      const result = await execFileAsync(
        "/bin/ps",
        ["-p", String(pid), "-o", "lstart="],
        {
          timeout: DARWIN_PROCESS_PROBE_TIMEOUT_MS,
          encoding: "utf8",
          env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
        },
      );
      stdout = result.stdout;
    } catch (error) {
      if ((error as { code?: unknown }).code !== 1) return { kind: "unavailable" };
      return isProcessAlive(pid) ? { kind: "unavailable" } : { kind: "absent" };
    }
    const normalized = stdout.trim();
    if (!normalized) {
      return isProcessAlive(pid) ? { kind: "unavailable" } : { kind: "absent" };
    }
    const epochMs = parseDarwinLstart(normalized);
    return epochMs === null
      ? { kind: "unavailable" }
      : { kind: "identity", value: `darwin-process-${epochMs}` };
  }
  if (platform === "win32") {
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$found = @(Get-Process -Id ${pid} -ErrorAction SilentlyContinue); `
          + `if ($found.Count -eq 0) { '${WINDOWS_PROBE_ABSENT_MARKER}' } `
          + `else { try { '${WINDOWS_PROBE_IDENTITY_MARKER}' `
          + `+ $found[0].StartTime.ToUniversalTime().Ticks } `
          + `catch { '${WINDOWS_PROBE_UNAVAILABLE_MARKER}' } }`,
        ],
        { timeout: WINDOWS_PROCESS_PROBE_TIMEOUT_MS, windowsHide: true },
      );
      const reported = stdout.trim();
      if (reported === WINDOWS_PROBE_ABSENT_MARKER) return { kind: "absent" };
      if (reported === WINDOWS_PROBE_UNAVAILABLE_MARKER) return { kind: "unavailable" };
      if (!reported.startsWith(WINDOWS_PROBE_IDENTITY_MARKER)) return { kind: "unavailable" };
      const ticks = reported.slice(WINDOWS_PROBE_IDENTITY_MARKER.length).trim();
      return ticks
        ? { kind: "identity", value: `windows-process-${ticks}` }
        : { kind: "unavailable" };
    } catch {
      return { kind: "unavailable" };
    }
  }
  if (platform !== "linux") return { kind: "unavailable" };
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return { kind: "unavailable" };
    const fields = stat.slice(closeParen + 1).trim().split(/\s+/);
    const startTime = fields[19];
    return startTime
      ? { kind: "identity", value: `linux-proc-${startTime}` }
      : { kind: "unavailable" };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "unavailable" };
  }
}

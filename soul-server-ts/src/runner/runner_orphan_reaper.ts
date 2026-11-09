import { readdir, readFile } from "node:fs/promises";
import type { Logger } from "pino";

import { readProcessStartIdentity, type ProcessStartIdentityProbe } from "./runner_process_lock.js";

type ProcFile = "status" | "environ" | "comm";
type Signal = "SIGTERM" | "SIGKILL";
type Owner = { marker: string; pid: number; identity: string };
type Candidate = { pid: number; ppid: number; owner: Owner; identity: string };
type Signalled = { identity: string; termAtMs: number };

export interface RunnerOrphanReaperOptions {
  logger: Pick<Logger, "info" | "warn">;
  intervalMs?: number;
  platform?: NodeJS.Platform;
  selfPid?: number;
  uid?: number;
  listPids?: () => Promise<string[]>;
  readProc?: (pid: number, file: ProcFile) => Promise<string>;
  readIdentity?: (pid: number) => Promise<ProcessStartIdentityProbe>;
  kill?: (pid: number, signal: Signal) => void;
  now?: () => number;
}

/** Reaps only processes whose runner has died and whose ancestry leads to init. */
export class RunnerOrphanReaper {
  private readonly platform: NodeJS.Platform;
  private readonly selfPid: number;
  private readonly uid: number | undefined;
  private readonly listPids: () => Promise<string[]>;
  private readonly readProc: (pid: number, file: ProcFile) => Promise<string>;
  private readonly readIdentity: (pid: number) => Promise<ProcessStartIdentityProbe>;
  private readonly kill: (pid: number, signal: Signal) => void;
  private readonly now: () => number;
  private readonly signalled = new Map<number, Signalled>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(private readonly options: RunnerOrphanReaperOptions) {
    this.platform = options.platform ?? process.platform;
    this.selfPid = options.selfPid ?? process.pid;
    this.uid = options.uid ?? process.getuid?.();
    this.listPids = options.listPids ?? (() => readdir("/proc"));
    this.readProc = options.readProc ?? ((pid, file) => readFile(`/proc/${pid}/${file}`, "utf8"));
    this.readIdentity = options.readIdentity ?? readProcessStartIdentity;
    this.kill = options.kill ?? ((pid, signal) => { process.kill(pid, signal); });
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.platform !== "linux" || this.timer) return;
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = this.sweep().catch((error: unknown) => {
        this.options.logger.warn({ err: error }, "Runner orphan sweep failed");
      }).finally(() => { this.inFlight = undefined; });
    }, this.options.intervalMs ?? 15_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  async sweep(): Promise<void> {
    if (this.platform !== "linux") return;
    const exempt = await this.ancestorMarkers();
    const owners = new Map<string, boolean>();
    const possible = new Map<number, Candidate>();
    for (const entry of await this.listPids()) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (!this.safePid(pid)) continue;
      const identity = await this.readIdentity(pid);
      if (identity.kind !== "identity") continue;
      let status: string;
      let environ: string;
      try {
        status = await this.readProc(pid, "status");
        environ = await this.readProc(pid, "environ");
      } catch { continue; }
      const info = parseStatus(status);
      const owner = parseOwner(environ);
      if (!info || info.uid !== this.uid || !owner || owner.pid === pid || exempt.has(owner.marker)) continue;
      let dead = owners.get(owner.marker);
      if (dead === undefined) {
        const identity = await this.readIdentity(owner.pid);
        dead = identity.kind === "absent"
          || (identity.kind === "identity" && identity.value !== owner.identity);
        owners.set(owner.marker, dead);
      }
      if (!dead) continue;
      const checked = await this.readIdentity(pid);
      if (checked.kind !== "identity" || checked.value !== identity.value) continue;
      possible.set(pid, { pid, ppid: info.ppid, owner, identity: identity.value });
    }

    const candidates = new Map<number, Candidate>();
    let changed: boolean;
    do {
      changed = false;
      for (const [pid, candidate] of possible) {
        if (candidates.has(pid)) continue;
        const parent = candidates.get(candidate.ppid);
        if (candidate.ppid === 1 || parent?.owner.marker === candidate.owner.marker) {
          candidates.set(pid, candidate);
          changed = true;
        }
      }
    } while (changed);

    for (const pid of this.signalled.keys()) {
      if (!candidates.has(pid)) this.signalled.delete(pid);
    }
    for (const candidate of candidates.values()) await this.signalCandidate(candidate);
  }

  private async ancestorMarkers(): Promise<Set<string>> {
    const markers = new Set<string>();
    let pid = this.selfPid;
    while (pid > 0) {
      let status: string;
      try { status = await this.readProc(pid, "status"); } catch { break; }
      try {
        const owner = parseOwner(await this.readProc(pid, "environ"));
        if (owner) markers.add(owner.marker);
      } catch { /* Process environment is not always readable. */ }
      if (pid === 1) break;
      const info = parseStatus(status);
      if (!info || info.ppid === pid) break;
      pid = info.ppid;
    }
    return markers;
  }

  private async signalCandidate(candidate: Candidate): Promise<void> {
    const { pid, owner, identity } = candidate;
    const previous = this.signalled.get(pid);
    if (previous && previous.identity !== identity) {
      this.signalled.delete(pid);
      return;
    }
    const now = this.now();
    if (previous && now - previous.termAtMs < 10_000) return;
    const signal: Signal = previous ? "SIGKILL" : "SIGTERM";
    let comm: string;
    try { comm = (await this.readProc(pid, "comm")).trim(); } catch { return; }
    const checked = await this.readIdentity(pid);
    if (checked.kind !== "identity" || checked.value !== identity) return;
    if (!this.safePid(pid)) throw new Error("unsafe runner orphan pid");
    try {
      this.kill(pid, signal);
      if (!previous) this.signalled.set(pid, { identity, termAtMs: now });
      this.options.logger.info({ pid, ownerPid: owner.pid, comm, signal }, "Signalled runner orphan");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        this.options.logger.warn({ pid, err: error }, "Failed to signal runner orphan");
      }
    }
  }

  private safePid(pid: number): boolean {
    return Number.isSafeInteger(pid) && pid > 1 && pid !== this.selfPid && pid !== process.pid;
  }
}

function parseStatus(status: string): { ppid: number; uid: number } | undefined {
  const parent = /^PPid:\s*(\d+)/m.exec(status);
  const uid = /^Uid:\s*(\d+)/m.exec(status);
  if (!parent || !uid) return undefined;
  return { ppid: Number(parent[1]), uid: Number(uid[1]) };
}

function parseOwner(environ: string): Owner | undefined {
  const marker = environ.split("\0").find((part) => part.startsWith("SOUL_RUNNER_OWNER="))?.slice(18);
  const match = marker && /^(\d+):(linux-proc-\d+)$/.exec(marker);
  if (!match) return undefined;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  return { marker, pid, identity: match[2]! };
}

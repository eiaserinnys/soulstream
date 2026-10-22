import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";

import type {
  NodeDiskQueueMetrics,
  NodeResourceSnapshot,
} from "@soulstream/wire-schema/node-resources";

type DiskSample = {
  device: string;
  inFlight: number;
  ioTimeMs: number;
  weightedIoTimeMs: number;
};

export interface NodeResourceCollectorOptions {
  diskPath: string;
  enableWindowsTypeperf?: boolean;
  platform?: NodeJS.Platform;
  cpus?: typeof os.cpus;
  totalmem?: typeof os.totalmem;
  freemem?: typeof os.freemem;
  loadavg?: typeof os.loadavg;
  readFileSync?: (path: string, encoding: "utf8") => string;
  statfsSync?: typeof fs.statfsSync;
  now?: () => Date;
  spawnTypeperf?: typeof spawn;
}

const TYPEPERF_COUNTERS = [
  "\\PhysicalDisk(_Total)\\Current Disk Queue Length",
  "\\PhysicalDisk(_Total)\\Avg. Disk Queue Length",
  "\\PhysicalDisk(_Total)\\% Disk Time",
  "-si",
  "10",
];

const WHOLE_DISK_DEVICE = /^(?:sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

export class NodeResourceCollector {
  private readonly platform: NodeJS.Platform;
  private readonly cpus: typeof os.cpus;
  private readonly totalmem: typeof os.totalmem;
  private readonly freemem: typeof os.freemem;
  private readonly loadavg: typeof os.loadavg;
  private readonly readFileSync: (path: string, encoding: "utf8") => string;
  private readonly statfsSync: typeof fs.statfsSync;
  private readonly now: () => Date;
  private readonly diskPath: string;
  private previousCpuSample: { total: number; idle: number } | undefined;
  private previousDiskSample: (DiskSample & { sampledAtMs: number }) | undefined;
  private typeperfProcess: ChildProcess | undefined;
  private typeperfQueue: NodeDiskQueueMetrics | null = null;
  private typeperfBuffer = "";

  constructor(options: NodeResourceCollectorOptions) {
    this.platform = options.platform ?? process.platform;
    this.cpus = options.cpus ?? os.cpus;
    this.totalmem = options.totalmem ?? os.totalmem;
    this.freemem = options.freemem ?? os.freemem;
    this.loadavg = options.loadavg ?? os.loadavg;
    this.readFileSync = options.readFileSync ?? ((path, encoding) => fs.readFileSync(path, encoding));
    this.statfsSync = options.statfsSync ?? fs.statfsSync;
    this.now = options.now ?? (() => new Date());
    this.diskPath = options.diskPath;
    if (this.platform === "win32" && options.enableWindowsTypeperf !== false) {
      this.startWindowsTypeperf(options.spawnTypeperf ?? spawn);
    }
  }

  collectSync(): NodeResourceSnapshot {
    const now = this.now();
    const cpus = this.cpus();
    let cpuTotal = 0;
    let cpuIdle = 0;
    for (const core of cpus) {
      const times = core.times;
      cpuTotal += times.user + times.nice + times.sys + times.idle + times.irq;
      cpuIdle += times.idle;
    }
    const previousCpuSample = this.previousCpuSample;
    const deltaTotal = previousCpuSample ? cpuTotal - previousCpuSample.total : 0;
    const deltaIdle = previousCpuSample ? cpuIdle - previousCpuSample.idle : 0;
    const usagePercent = deltaTotal > 0
      ? round1(clamp((deltaTotal - deltaIdle) / deltaTotal * 100, 0, 100))
      : cpuTotal > 0
        ? round1(clamp((cpuTotal - cpuIdle) / cpuTotal * 100, 0, 100))
        : 0;
    this.previousCpuSample = { total: cpuTotal, idle: cpuIdle };

    const totalBytes = this.totalmem();
    const availableBytes = this.readAvailableMemory();
    const usedBytes = Math.max(0, totalBytes - availableBytes);
    const memory = {
      usagePercent: totalBytes > 0
        ? round1(clamp(usedBytes / totalBytes * 100, 0, 100))
        : 0,
      usedBytes,
      availableBytes,
      totalBytes,
    };

    let disk: NodeResourceSnapshot["disk"] = null;
    try {
      const stats = this.statfsSync(this.diskPath);
      const diskTotalBytes = Number(stats.blocks) * Number(stats.bsize);
      const diskAvailableBytes = Number(stats.bavail) * Number(stats.bsize);
      const diskUsedBytes = Math.max(0, diskTotalBytes - diskAvailableBytes);
      disk = {
        path: this.diskPath,
        usagePercent: diskTotalBytes > 0
          ? round1(clamp(diskUsedBytes / diskTotalBytes * 100, 0, 100))
          : 0,
        usedBytes: diskUsedBytes,
        availableBytes: diskAvailableBytes,
        totalBytes: diskTotalBytes,
      };
    } catch {
      disk = null;
    }

    const diskQueue = this.platform === "linux"
      ? this.collectLinuxDiskQueue(now.getTime())
      : this.platform === "win32"
        ? this.typeperfQueue
        : null;

    return {
      collectedAt: now.toISOString(),
      cpu: {
        usagePercent,
        cores: cpus.length,
        loadAvg1m: this.platform === "win32" ? null : round2(this.loadavg()[0] ?? 0),
      },
      memory,
      disk,
      diskQueue,
    };
  }

  close(): void {
    this.typeperfProcess?.kill();
    this.typeperfProcess = undefined;
  }

  private readAvailableMemory(): number {
    if (this.platform === "linux") {
      try {
        const meminfo = this.readFileSync("/proc/meminfo", "utf8");
        const match = /MemAvailable:\s+(\d+)\s+kB/.exec(meminfo);
        if (match) return Number(match[1]) * 1024;
      } catch {
        // If meminfo cannot be read, the OS free memory value remains available.
      }
    }
    return this.freemem();
  }

  private collectLinuxDiskQueue(nowMs: number): NodeDiskQueueMetrics | null {
    let mounts: string;
    let diskstats: string;
    try {
      mounts = this.readFileSync("/proc/mounts", "utf8");
      diskstats = this.readFileSync("/proc/diskstats", "utf8");
    } catch {
      return null;
    }
    const rows = diskstats.split(/\r?\n/)
      .map(parseDiskStatsRow)
      .filter((row): row is DiskSample => row !== undefined);
    const mountedDevice = findMountDevice(mounts, this.diskPath);
    const sample = rows.find((row) => row.device === mountedDevice)
      ?? rows.filter((row) => WHOLE_DISK_DEVICE.test(row.device))
        .sort((left, right) => right.ioTimeMs - left.ioTimeMs)[0];
    if (!sample) return null;

    const previous = this.previousDiskSample;
    let busyPercent = 0;
    let avgQueueDepth = sample.inFlight;
    if (previous?.device === sample.device) {
      const elapsedMs = nowMs - previous.sampledAtMs;
      if (elapsedMs > 0) {
        busyPercent = round1(clamp(
          (sample.ioTimeMs - previous.ioTimeMs) / elapsedMs * 100,
          0,
          100,
        ));
        avgQueueDepth = Math.max(0, round2(
          (sample.weightedIoTimeMs - previous.weightedIoTimeMs) / elapsedMs,
        ));
      }
    }
    this.previousDiskSample = { ...sample, sampledAtMs: nowMs };
    return {
      device: sample.device,
      inFlight: sample.inFlight,
      avgQueueDepth,
      busyPercent,
    };
  }

  private startWindowsTypeperf(spawnTypeperf: typeof spawn): void {
    try {
      const child = spawnTypeperf("typeperf.exe", TYPEPERF_COUNTERS, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      this.typeperfProcess = child;
      child.unref();
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: Buffer | string) => {
        this.consumeTypeperfOutput(String(chunk));
      });
      child.once("error", () => this.failWindowsTypeperf());
      child.once("exit", () => this.failWindowsTypeperf());
    } catch {
      this.failWindowsTypeperf();
    }
  }

  private consumeTypeperfOutput(chunk: string): void {
    this.typeperfBuffer += chunk;
    const lines = this.typeperfBuffer.split(/\r?\n/);
    this.typeperfBuffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const fields = parseCsvLine(rawLine.replace(/^\uFEFF/, ""));
      if (fields.length < 4) continue;
      const [inFlight, avgQueueDepth, busyPercent] = fields.slice(1, 4).map(Number);
      if (![inFlight, avgQueueDepth, busyPercent].every(Number.isFinite)) continue;
      this.typeperfQueue = {
        device: "_Total",
        inFlight: inFlight!,
        avgQueueDepth: avgQueueDepth!,
        busyPercent: busyPercent!,
      };
    }
  }

  private failWindowsTypeperf(): void {
    this.typeperfQueue = null;
    this.typeperfProcess = undefined;
  }
}

function parseDiskStatsRow(line: string): DiskSample | undefined {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 14) return undefined;
  const [inFlight, ioTimeMs, weightedIoTimeMs] = parts.slice(11, 14).map(Number);
  if (![inFlight, ioTimeMs, weightedIoTimeMs].every(Number.isFinite)) return undefined;
  return {
    device: parts[2]!,
    inFlight: inFlight!,
    ioTimeMs: ioTimeMs!,
    weightedIoTimeMs: weightedIoTimeMs!,
  };
}

function findMountDevice(mounts: string, diskPath: string): string | undefined {
  const matching = mounts.split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && isPathPrefix(parts[1]!, diskPath))
    .sort((left, right) => right[1]!.length - left[1]!.length)[0];
  const source = matching?.[0];
  return source?.startsWith("/dev/") ? source.slice("/dev/".length) : undefined;
}

function isPathPrefix(mountPath: string, targetPath: string): boolean {
  if (mountPath === "/") return targetPath.startsWith("/");
  return targetPath === mountPath || targetPath.startsWith(`${mountPath.replace(/\/$/, "")}/`);
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === '"' && quoted && line[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      fields.push(field.trim());
      field = "";
    } else {
      field += character;
    }
  }
  fields.push(field.trim());
  return fields;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

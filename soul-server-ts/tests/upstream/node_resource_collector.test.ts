import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  NodeResourceCollector,
  type NodeResourceCollectorOptions,
} from "../../src/upstream/node_resource_collector.js";

function cpu(user: number, idle: number) {
  return [{
    model: "test",
    speed: 1000,
    times: { user, nice: 0, sys: 0, idle, irq: 0 },
  }];
}

describe("NodeResourceCollector", () => {
  it("collects Linux CPU, available memory, filesystem and disk queue deltas", () => {
    let nowMs = 0;
    let cpuIndex = 0;
    let diskIndex = 0;
    const cpuSamples = [cpu(40, 60), cpu(50, 70)];
    const diskSamples = [
      "8 0 sda 0 0 0 0 0 0 0 0 2 100 200",
      "8 0 sda 0 0 0 0 0 0 0 0 3 150 300",
    ];
    const readFileSync = vi.fn((path: string) => {
      if (path === "/proc/meminfo") return "MemAvailable: 512 kB\n";
      if (path === "/proc/mounts") return "/dev/sda / ext4 rw 0 0\n";
      if (path === "/proc/diskstats") return `${diskSamples[diskIndex++]!}\n`;
      throw new Error(`unexpected path ${path}`);
    });
    const collector = new NodeResourceCollector({
      diskPath: "/",
      platform: "linux",
      cpus: () => cpuSamples[cpuIndex++]!,
      totalmem: () => 1024 * 1024,
      freemem: () => 256 * 1024,
      loadavg: () => [0.456, 0.2, 0.1],
      readFileSync,
      statfsSync: () => ({ blocks: 200, bsize: 1024, bavail: 50 }) as never,
      now: () => new Date(nowMs),
    });

    const first = collector.collectSync();
    expect(first.cpu).toEqual({ usagePercent: 40, cores: 1, loadAvg1m: 0.46 });
    expect(first.memory).toEqual({
      usagePercent: 50,
      usedBytes: 512 * 1024,
      availableBytes: 512 * 1024,
      totalBytes: 1024 * 1024,
    });
    expect(first.disk).toEqual({
      path: "/",
      usagePercent: 75,
      usedBytes: 153_600,
      availableBytes: 51_200,
      totalBytes: 204_800,
    });
    expect(first.diskQueue).toEqual({
      device: "sda",
      inFlight: 2,
      avgQueueDepth: 2,
      busyPercent: 0,
    });

    nowMs = 1000;
    expect(collector.collectSync()).toMatchObject({
      cpu: { usagePercent: 50 },
      diskQueue: { device: "sda", inFlight: 3, avgQueueDepth: 0.1, busyPercent: 5 },
    });
    expect(readFileSync).toHaveBeenCalledWith("/proc/meminfo", "utf8");
    collector.close();
  });

  it("uses the busiest whole disk when the mount source is not in diskstats", () => {
    const collector = new NodeResourceCollector({
      diskPath: "/work",
      platform: "linux",
      cpus: () => cpu(1, 1),
      totalmem: () => 100,
      freemem: () => 50,
      loadavg: () => [0, 0, 0],
      readFileSync: (path) => path === "/proc/mounts"
        ? "overlay /work overlay rw 0 0\n"
        : path === "/proc/diskstats"
          ? [
              "8 0 sda 0 0 0 0 0 0 0 0 0 10 20",
              "259 0 nvme0n1 0 0 0 0 0 0 0 0 1 50 60",
              "259 1 nvme0n1p1 0 0 0 0 0 0 0 0 9 90 100",
            ].join("\n")
          : "",
      statfsSync: () => ({ blocks: 1, bsize: 1, bavail: 1 }) as never,
      now: () => new Date(0),
      enableWindowsTypeperf: false,
    });

    expect(collector.collectSync().diskQueue).toMatchObject({
      device: "nvme0n1",
      inFlight: 1,
      busyPercent: 0,
    });
  });

  it("reads the resident Windows typeperf stream once and closes it", () => {
    const stdout = new PassThrough();
    const process = Object.assign(new EventEmitter(), {
      stdout,
      unref: vi.fn(),
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    const spawnTypeperf = vi.fn(() => process) as unknown as NonNullable<
      NodeResourceCollectorOptions["spawnTypeperf"]
    >;
    const collector = new NodeResourceCollector({
      diskPath: "C:\\",
      platform: "win32",
      cpus: () => cpu(25, 75),
      totalmem: () => 1024,
      freemem: () => 256,
      loadavg: () => [],
      statfsSync: () => ({ blocks: 1, bsize: 1, bavail: 1 }) as never,
      spawnTypeperf,
      now: () => new Date(0),
    });

    stdout.write('"10/22/2026 12:00:00 AM","4","1.5","25"\r\n');
    expect(collector.collectSync()).toMatchObject({
      cpu: { loadAvg1m: null },
      diskQueue: { device: "_Total", inFlight: 4, avgQueueDepth: 1.5, busyPercent: 25 },
    });
    expect(spawnTypeperf).toHaveBeenCalledWith("typeperf.exe", [
      "\\PhysicalDisk(_Total)\\Current Disk Queue Length",
      "\\PhysicalDisk(_Total)\\Avg. Disk Queue Length",
      "\\PhysicalDisk(_Total)\\% Disk Time",
      "-si",
      "10",
    ], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    expect(spawnTypeperf).toHaveBeenCalledOnce();
    collector.close();
    expect(process.kill).toHaveBeenCalledOnce();
  });
});

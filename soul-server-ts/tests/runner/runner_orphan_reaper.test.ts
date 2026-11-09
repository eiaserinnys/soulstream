import { describe, expect, it, vi } from "vitest";

import { RunnerOrphanReaper } from "../../src/runner/runner_orphan_reaper.js";
import type { ProcessStartIdentityProbe } from "../../src/runner/runner_process_lock.js";

const self = 9000;
const owner = "500:linux-proc-123";
type Proc = { ppid: number; uid?: number; marker?: string; identity?: string; unreadable?: boolean };

function fixture(processes: Record<number, Proc>, owners: Record<number, ProcessStartIdentityProbe> = {}) {
  const all: Record<number, Proc> = { [self]: { ppid: 1 }, ...processes };
  let clock = 0;
  const kill = vi.fn();
  const readIdentity = vi.fn(async (pid: number): Promise<ProcessStartIdentityProbe> => {
    if (owners[pid]) return owners[pid];
    return all[pid]?.identity ? { kind: "identity", value: all[pid].identity! } : { kind: "absent" };
  });
  const reaper = new RunnerOrphanReaper({
    platform: "linux", selfPid: self, uid: 1000,
    listPids: async () => Object.keys(all),
    readProc: async (pid, file) => {
      const proc = all[pid];
      if (!proc || (file === "environ" && proc.unreadable)) throw new Error("unreadable");
      if (file === "status") return `Name:\ttest\nPPid:\t${proc.ppid}\nUid:\t${proc.uid ?? 1000}\t1000\t1000\t1000\n`;
      if (file === "environ") return proc.marker ? `SOUL_RUNNER_OWNER=${proc.marker}\0` : "";
      return "test-process\n";
    },
    readIdentity, kill, now: () => clock,
    logger: { info: vi.fn(), warn: vi.fn() },
  });
  return { reaper, kill, all, readIdentity, advance: (ms: number) => { clock += ms; } };
}

describe("RunnerOrphanReaper", () => {
  it("does nothing on non-Linux platforms", async () => {
    const kill = vi.fn();
    const listPids = vi.fn();
    const reaper = new RunnerOrphanReaper({ platform: "darwin", kill, listPids, logger: { info: vi.fn(), warn: vi.fn() } });
    reaper.start();
    await reaper.sweep();
    await reaper.stop();
    expect(listPids).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("leaves processes of a live or uninspectable owner alone", async () => {
    for (const probe of [{ kind: "identity", value: "linux-proc-123" }, { kind: "unavailable" }] as const) {
      const f = fixture({ 101: { ppid: 1, marker: owner, identity: "a" } }, { 500: probe });
      await f.reaper.sweep();
      expect(f.kill).not.toHaveBeenCalled();
    }
  });

  it("leaves an isolated process under unmarked bwrap while its host runner lives", async () => {
    const f = fixture({
      700: { ppid: 500 },
      101: { ppid: 700, marker: owner, identity: "a" },
    }, { 500: { kind: "identity", value: "linux-proc-123" } });
    await f.reaper.sweep();
    expect(f.kill).not.toHaveBeenCalled();
  });

  it("sends TERM then KILL after ten seconds to the same orphan identity", async () => {
    const f = fixture({ 101: { ppid: 1, marker: owner, identity: "a" } });
    await f.reaper.sweep();
    f.advance(10_000);
    await f.reaper.sweep();
    expect(f.kill.mock.calls).toEqual([[101, "SIGTERM"], [101, "SIGKILL"]]);
  });

  it("does not send KILL to a reused pid", async () => {
    const f = fixture({ 101: { ppid: 1, marker: owner, identity: "a" } });
    await f.reaper.sweep();
    f.all[101]!.identity = "b";
    f.advance(10_000);
    await f.reaper.sweep();
    expect(f.kill.mock.calls).toEqual([[101, "SIGTERM"]]);
  });

  it("refuses a pid reused during candidate collection or before the signal", async () => {
    for (const stableReads of [1, 2]) {
      const f = fixture({ 101: { ppid: 1, marker: owner, identity: "a" } });
      f.readIdentity.mockImplementation(async (pid) => pid === 101
        ? (f.readIdentity.mock.calls.filter(([p]) => p === 101).length <= stableReads
          ? { kind: "identity", value: "a" } : { kind: "identity", value: "b" })
        : { kind: "absent" });
      await f.reaper.sweep();
      expect(f.kill).not.toHaveBeenCalled();
    }
  });

  it("ignores children of unrelated live parents and exempt owners", async () => {
    const f = fixture({
      [self]: { ppid: 700, marker: "600:linux-proc-456" },
      700: { ppid: 1 },
      101: { ppid: 700, marker: owner, identity: "a" },
      102: { ppid: 1, marker: "600:linux-proc-456", identity: "b" },
    });
    await f.reaper.sweep();
    expect(f.kill).not.toHaveBeenCalled();
  });

  it("skips a different uid and an unreadable environment", async () => {
    const f = fixture({
      101: { ppid: 1, uid: 1001, marker: owner, identity: "a" },
      102: { ppid: 1, marker: owner, identity: "b", unreadable: true },
      103: { ppid: 1, marker: owner, identity: "c" },
    });
    await f.reaper.sweep();
    expect(f.kill.mock.calls).toEqual([[103, "SIGTERM"]]);
  });

  it("never signals pid 0, pid 1, self, or the marker's owner", async () => {
    const kill = vi.fn();
    const environReads = new Map<number, number>();
    const reaper = new RunnerOrphanReaper({
      platform: "linux", selfPid: self, uid: 1000,
      listPids: async () => ["-1", "0", "1", String(self), "500"],
      readProc: async (pid, file) => {
        if (file === "status") return "PPid:\t1\nUid:\t1000\t1000\t1000\t1000\n";
        if (file === "environ") {
          const count = environReads.get(pid) ?? 0;
          environReads.set(pid, count + 1);
          // Ancestor exemption is empty; a candidate read would reveal the marker.
          return (pid === self || pid === 1) && count === 0 ? "" : `SOUL_RUNNER_OWNER=${owner}\0`;
        }
        return "test-process";
      },
      readIdentity: async (pid) => pid === 500
        ? { kind: "identity", value: "linux-proc-reused" }
        : { kind: "identity", value: `identity-${pid}` },
      kill, now: () => 0, logger: { info: vi.fn(), warn: vi.fn() },
    });
    await reaper.sweep();
    expect(kill).not.toHaveBeenCalled();
  });

  it("finds every member of a same-owner orphan chain", async () => {
    const f = fixture({
      103: { ppid: 102, marker: owner, identity: "c" },
      102: { ppid: 101, marker: owner, identity: "b" },
      101: { ppid: 1, marker: owner, identity: "a" },
    }, { 500: { kind: "identity", value: "linux-proc-reused" } });
    await f.reaper.sweep();
    expect(f.kill.mock.calls.map(([pid]) => pid).sort()).toEqual([101, 102, 103]);
    expect(f.readIdentity.mock.calls.filter(([pid]) => pid === 500)).toHaveLength(1);
  });
});

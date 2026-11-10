import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it, vi } from "vitest";

import { RunnerOrphanReaper } from "../../src/runner/runner_orphan_reaper.js";
import { readProcessStartIdentity } from "../../src/runner/runner_process_lock.js";

const childCode = `
  const { spawn } = require('node:child_process');
  // Until the test acknowledges the PID, EOF makes the unarmed child exit.
  const grandchild = spawn('sh', ['-c', 'IFS= read -r ready || exit; exec sleep 300'],
    { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  console.log(JSON.stringify({ grandchild: grandchild.pid }));
  let armed = false;
  const timeout = setTimeout(() => process.exit(1), 6000);
  process.stdin.once('data', () => {
    armed = true;
    clearTimeout(timeout);
    grandchild.stdin.end('ready\\n');
    console.log(JSON.stringify({ armed: true }));
  });
  process.stdin.once('end', () => { if (!armed) process.exit(1); });
  setInterval(() => {}, 1000);
`;
const runnerCode = `
  const { spawn } = require('node:child_process');
  const { readFileSync } = require('node:fs');
  const stat = readFileSync('/proc/self/stat', 'utf8');
  const start = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\\s+/)[19];
  process.env.SOUL_RUNNER_OWNER = process.pid + ':linux-proc-' + start;
  const child = spawn(process.execPath, ['-e', process.env.TEST_CHILD_CODE],
    { stdio: ['pipe', 'inherit', 'inherit'], env: process.env });
  console.log(JSON.stringify({ child: child.pid }));
  const timeout = setTimeout(() => process.exit(1), 6000);
  process.stdin.once('data', () => { clearTimeout(timeout); child.stdin.end('ready\\n'); });
  process.stdin.once('end', () => process.exit(1));
  setInterval(() => {}, 1000);
`;

async function alive(pid: number): Promise<boolean> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    return !/^State:\s+Z/m.test(status);
  } catch (error) {
    // ESRCH: the process exited and was reaped after open() and before read().
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return false;
    throw error;
  }
}

async function waitUntilStopped(pids: number[]): Promise<void> {
  for (let n = 0; n < 100; n++) {
    if ((await Promise.all(pids.map(alive))).every((value) => !value)) return;
    await delay(20);
  }
  throw new Error(`test processes did not stop: ${pids.join(", ")}`);
}

async function waitForSleep(pid: number): Promise<void> {
  for (let n = 0; n < 100; n++) {
    if ((await readFile(`/proc/${pid}/comm`, "utf8")).trim() === "sleep") return;
    await delay(20);
  }
  throw new Error("setsid grandchild did not start sleep");
}

describe.skipIf(process.platform !== "linux")("runner orphan reaper integration", () => {
  it("cleans the test runner's child and setsid grandchild only after the runner dies", async () => {
    const runner = spawn(process.execPath, ["-e", runnerCode], {
      env: { ...process.env, TEST_CHILD_CODE: childCode },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const allowed = new Set<number>();
    const identities = new Map<number, string>();
    const identityReadings: Array<Promise<void>> = [];
    const rejected: number[] = [];
    const signals: Array<[number, NodeJS.Signals]> = [];
    if (!runner.pid) throw new Error("test runner did not start");
    allowed.add(runner.pid);
    const guardedKill = (pid: number, signal: NodeJS.Signals): void => {
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || !allowed.has(pid)) {
        rejected.push(pid);
        throw new Error(`refused non-test pid ${pid}`);
      }
      signals.push([pid, signal]);
      process.kill(pid, signal);
    };
    let child = 0;
    let grandchild = 0;
    let acknowledged = false;
    const remember = (pid: number): void => {
      allowed.add(pid);
      identityReadings.push(readProcessStartIdentity(pid).then((probe) => {
        if (probe.kind === "identity") identities.set(pid, probe.value);
      }));
    };
    try {
      const runnerIdentity = await readProcessStartIdentity(runner.pid);
      if (runnerIdentity.kind !== "identity") throw new Error("no identity for test runner");
      identities.set(runner.pid, runnerIdentity.value);
      const lines = createInterface({ input: runner.stdout });
      try {
        await Promise.race([
          new Promise<void>((resolve, reject) => {
            lines.on("line", (line) => {
              try {
                const item = JSON.parse(line) as { child?: number; grandchild?: number; armed?: boolean };
                if (item.child) { child = item.child; remember(child); }
                if (item.grandchild) { grandchild = item.grandchild; remember(grandchild); }
                if (child && grandchild && !acknowledged) {
                  acknowledged = true;
                  runner.stdin.write("ready\n");
                }
                if (item.armed) resolve();
              } catch (error) { reject(error); }
            });
            lines.on("close", () => { if (!child || !grandchild) reject(new Error("runner output closed")); });
          }),
          delay(5_000).then(() => { throw new Error("test process startup timed out"); }),
        ]);
      } finally { lines.close(); }
      expect(child).toBeGreaterThan(1);
      expect(grandchild).toBeGreaterThan(1);
      await waitForSleep(grandchild);
      for (const pid of allowed) {
        const probe = await readProcessStartIdentity(pid);
        if (probe.kind !== "identity") throw new Error(`no identity for test pid ${pid}`);
        identities.set(pid, probe.value);
      }
      let now = 0;
      const reaper = new RunnerOrphanReaper({
        kill: guardedKill, now: () => now,
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await reaper.sweep();
      expect(signals).toEqual([]);
      expect(await alive(child)).toBe(true);
      expect(await alive(grandchild)).toBe(true);
      guardedKill(runner.pid, "SIGKILL");
      await waitUntilStopped([runner.pid]);
      await reaper.sweep();
      now += 10_000;
      await reaper.sweep();
      await waitUntilStopped([child, grandchild]);
      expect(signals.some(([pid]) => pid === child)).toBe(true);
      expect(signals.some(([pid]) => pid === grandchild)).toBe(true);
      expect(rejected).toEqual([]);
    } finally {
      runner.stdin.destroy();
      await Promise.all(identityReadings);
      for (const pid of allowed) {
        const probe = await readProcessStartIdentity(pid);
        if (await alive(pid) && probe.kind === "identity" && identities.get(pid) === probe.value) {
          guardedKill(pid, "SIGKILL");
        }
      }
      await waitUntilStopped([...allowed]);
    }
  }, 60_000);
});

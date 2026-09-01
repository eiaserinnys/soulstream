#!/usr/bin/env node
/**
 * R30 evidence harness — Windows liveness probe fail-open measurement.
 *
 * `isProcessAlive` in src/runner/runner_process_lock.ts decides "this pid is
 * live" from `process.kill(pid, 0)`, treating EPERM as alive. On Windows that
 * verdict diverges from the real process table in two ways:
 *
 *   1. ACCESS_DENIED on protected processes -> EPERM -> reported alive.
 *   2. Aggressive pid recycling -> a released runner pid lands on an unrelated
 *      live process, so the number still answers "alive".
 *
 * Either way the probe proves only that *some* process may hold the number,
 * never that our runner is there. Run this on the affected node to quantify
 * the divergence before and after a fix.
 *
 *   node scripts/r30_windows_pid_probe.mjs
 */
import { execFileSync } from "node:child_process";

function killProbe(pid) {
  try {
    process.kill(pid, 0);
    return "ok";
  } catch (error) {
    return error.code;
  }
}

function osProcessIds() {
  const stdout = execFileSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-Process | Select-Object -ExpandProperty Id",
  ], { encoding: "utf8", timeout: 20_000, windowsHide: true });
  return new Set(
    stdout.trim().split(/\r?\n/).map((line) => Number(line.trim())).filter(Number.isSafeInteger),
  );
}

if (process.platform !== "win32") {
  console.error("r30_windows_pid_probe is a win32-only measurement");
  process.exit(2);
}

const real = osProcessIds();
const failOpen = [];
let scanned = 0;
let reportedAlive = 0;
for (let pid = 4; pid <= 70_000; pid += 4) {
  scanned++;
  const code = killProbe(pid);
  if (code !== "ok" && code !== "EPERM") continue;
  reportedAlive++;
  if (!real.has(pid)) failOpen.push({ pid, code });
}

console.log(JSON.stringify({
  osProcessCount: real.size,
  scannedPids: scanned,
  reportedAlive,
  // isProcessAlive() === true while the OS process table has no such process.
  failOpenCount: failOpen.length,
  failOpen,
  // Probability that any recycled runner pid answers "alive" by coincidence.
  occupancyRatio: Number((reportedAlive / scanned).toFixed(4)),
}, null, 2));

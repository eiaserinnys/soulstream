import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_RESIDUAL_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_ROOT = join(tmpdir(), "soulstream-playwright-locks");
const BROWSER_COMMAND_PATTERN = /(?:^|[/\\\s-])(?:chrome|chromium|headless_shell)(?:$|[/\\\s-])/i;

export class HarnessAlreadyRunningError extends Error {
  constructor(lockName, owner) {
    const ownerLabel = Number.isInteger(owner?.pid) ? `pid ${owner.pid}` : "another process";
    super(`Playwright run \"${lockName}\" is already owned by ${ownerLabel}`);
    this.name = "HarnessAlreadyRunningError";
    this.code = "PLAYWRIGHT_HARNESS_ALREADY_RUNNING";
    this.owner = owner;
  }
}

export class HarnessTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Playwright run exceeded the ${timeoutMs}ms global timeout`);
    this.name = "HarnessTimeoutError";
    this.code = "PLAYWRIGHT_HARNESS_TIMEOUT";
    this.timeoutMs = timeoutMs;
  }
}

export class HarnessSignalError extends Error {
  constructor(signal) {
    super(`Playwright run interrupted by ${signal}`);
    this.name = "HarnessSignalError";
    this.code = "PLAYWRIGHT_HARNESS_SIGNAL";
    this.signal = signal;
  }
}

export class HarnessResidualProcessError extends Error {
  constructor(processes) {
    super(`Playwright cleanup left ${processes.length} Chromium process(es): ${processes.map(({ pid }) => pid).join(", ")}`);
    this.name = "HarnessResidualProcessError";
    this.code = "PLAYWRIGHT_HARNESS_RESIDUAL_PROCESS";
    this.processes = processes;
  }
}

export async function runPlaywrightLifecycle(options, callback) {
  validateOptions(options, callback);

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const residualTimeoutMs = options.residualTimeoutMs ?? DEFAULT_RESIDUAL_TIMEOUT_MS;
  const lock = await acquireLock(options.lockName, options.lockRoot ?? DEFAULT_LOCK_ROOT);
  const baseline = new Set(listBrowserDescendants().map(({ pid }) => pid));
  const observed = new Map();
  const abortController = new AbortController();
  const stop = createStopBoundary(timeoutMs, abortController);
  let browser;
  let result;
  let primaryError;
  let cleanupError;

  const launchPromise = Promise.resolve().then(() =>
    options.launchBrowser
      ? options.launchBrowser(options.launchOptions ?? { headless: true })
      : chromium.launch(options.launchOptions ?? { headless: true }),
  );
  const executionPromise = launchPromise.then(async (launchedBrowser) => {
    browser = launchedBrowser;
    observeNewBrowserProcesses(baseline, observed);
    if (abortController.signal.aborted) throw abortController.signal.reason;
    return callback({ browser: launchedBrowser, signal: abortController.signal });
  });

  try {
    result = await Promise.race([executionPromise, stop.promise]);
  } catch (error) {
    primaryError = toError(error);
  } finally {
    stop.dispose();
    try {
      await cleanupBrowser({
        baseline,
        browser,
        closeTimeoutMs,
        launchPromise,
        observed,
        residualTimeoutMs,
      });
    } catch (error) {
      cleanupError = toError(error);
    }

    try {
      await lock.release();
    } catch (error) {
      cleanupError = combineErrors(cleanupError, toError(error), "Playwright lock cleanup failed");
    }
  }

  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      `${primaryError.message}; cleanup also failed: ${cleanupError.message}`,
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return result;
}

export function listBrowserDescendants(rootPid = process.pid) {
  if (process.platform !== "linux") return [];

  const processes = readLinuxProcesses();
  const childrenByParent = new Map();
  for (const processInfo of processes.values()) {
    const children = childrenByParent.get(processInfo.ppid) ?? [];
    children.push(processInfo.pid);
    childrenByParent.set(processInfo.ppid, children);
  }

  const descendants = [];
  const pending = [...(childrenByParent.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.pop();
    const processInfo = processes.get(pid);
    if (!processInfo) continue;
    if (BROWSER_COMMAND_PATTERN.test(processInfo.command)) descendants.push(processInfo);
    pending.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
}

async function cleanupBrowser({
  baseline,
  browser,
  closeTimeoutMs,
  launchPromise,
  observed,
  residualTimeoutMs,
}) {
  let closeError;
  observeNewBrowserProcesses(baseline, observed);

  if (browser) {
    try {
      await withDeadline(browser.close(), closeTimeoutMs, "browser.close() timed out");
    } catch (error) {
      closeError = toError(error);
    }
  } else {
    const lateClose = launchPromise.then(async (lateBrowser) => {
      observeNewBrowserProcesses(baseline, observed);
      await lateBrowser.close();
    }).catch(() => undefined);
    await Promise.race([lateClose, delay(closeTimeoutMs)]);
  }

  observeNewBrowserProcesses(baseline, observed);
  let residual = aliveProcesses(observed.values());
  if (residual.length > 0) {
    terminateProcesses(residual, "SIGTERM");
    residual = await waitForProcessExit(observed.values(), residualTimeoutMs);
  }
  if (residual.length > 0) {
    terminateProcesses(residual, "SIGKILL");
    residual = await waitForProcessExit(observed.values(), residualTimeoutMs);
  }
  if (residual.length > 0) throw new HarnessResidualProcessError(residual);
  if (closeError) throw closeError;
}

function createStopBoundary(timeoutMs, abortController) {
  let rejectStop;
  const promise = new Promise((_, reject) => {
    rejectStop = reject;
  });
  const timeout = setTimeout(() => {
    const error = new HarnessTimeoutError(timeoutMs);
    abortController.abort(error);
    rejectStop(error);
  }, timeoutMs);
  const signalHandlers = new Map(["SIGINT", "SIGTERM"].map((signal) => [signal, () => {
    const error = new HarnessSignalError(signal);
    abortController.abort(error);
    rejectStop(error);
  }]));
  for (const [signal, handler] of signalHandlers) process.once(signal, handler);

  return {
    promise,
    dispose() {
      clearTimeout(timeout);
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    },
  };
}

async function acquireLock(lockName, lockRoot) {
  await mkdir(lockRoot, { recursive: true });
  const digest = createHash("sha256").update(lockName).digest("hex").slice(0, 12);
  const readableName = lockName.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 48) || "playwright";
  const lockPath = join(lockRoot, `${readableName}-${digest}.lock`);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({
          lockName,
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }));
      } finally {
        await handle.close();
      }
      let released = false;
      return {
        path: lockPath,
        async release() {
          if (released) return;
          released = true;
          await rm(lockPath, { force: true });
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = await readLockOwner(lockPath);
      if (owner?.pid && isProcessAlive(owner.pid)) {
        throw new HarnessAlreadyRunningError(lockName, owner);
      }
      await rm(lockPath, { force: true });
    }
  }
  throw new Error(`Could not acquire Playwright lock \"${lockName}\"`);
}

async function readLockOwner(lockPath) {
  try {
    return JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function observeNewBrowserProcesses(baseline, observed) {
  for (const processInfo of listBrowserDescendants()) {
    if (!baseline.has(processInfo.pid)) observed.set(processInfo.pid, processInfo);
  }
}

function readLinuxProcesses() {
  const processes = new Map();
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const processInfo = readLinuxProcess(Number(entry.name));
    if (processInfo) processes.set(processInfo.pid, processInfo);
  }
  return processes;
}

function readLinuxProcess(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
    const commandLine = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
    return {
      pid,
      ppid: Number(fields[1]),
      startTime: fields[19],
      command: commandLine || stat.slice(stat.indexOf("(") + 1, commandEnd),
    };
  } catch {
    return null;
  }
}

function aliveProcesses(processes) {
  return [...processes].filter((expected) => {
    const current = readLinuxProcess(expected.pid);
    return current?.startTime === expected.startTime;
  });
}

async function waitForProcessExit(processes, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let residual = aliveProcesses(processes);
  while (residual.length > 0 && Date.now() < deadline) {
    await delay(50);
    residual = aliveProcesses(processes);
  }
  return residual;
}

function terminateProcesses(processes, signal) {
  for (const processInfo of [...processes].reverse()) {
    try {
      process.kill(processInfo.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function validateOptions(options, callback) {
  if (!options || typeof options.lockName !== "string" || options.lockName.trim() === "") {
    throw new TypeError("runPlaywrightLifecycle requires a non-empty lockName");
  }
  if (typeof callback !== "function") {
    throw new TypeError("runPlaywrightLifecycle requires a callback");
  }
  for (const [name, value] of [
    ["timeoutMs", options.timeoutMs ?? DEFAULT_TIMEOUT_MS],
    ["closeTimeoutMs", options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS],
    ["residualTimeoutMs", options.residualTimeoutMs ?? DEFAULT_RESIDUAL_TIMEOUT_MS],
  ]) {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive number`);
  }
}

async function withDeadline(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function combineErrors(first, second, message) {
  if (!first) return second;
  return new AggregateError([first, second], message);
}

function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

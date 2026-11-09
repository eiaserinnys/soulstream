import type { ChildProcess } from "node:child_process";

import type { IsolationProcessPorts } from "../security/session_isolation_contract.js";

import { SessionIsolationUnavailableError } from "./session_isolation_preflight.js";

/**
 * 상자 실행이 직접 띄운 프로세스의 소유권 확인과 회수만 담당한다.
 * 회수 경로는 `ports.kill` 하나를 지나며, 검증되지 않은 pid는 그 앞에서 막힌다.
 */

/** 실행이 소유한 pid만 시그널 대상으로 인정한다. (#1102 재발 방지) */
export function assertOwnedProcessId(pid: unknown, label: string): number {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) {
    throw new SessionIsolationUnavailableError(
      `${label} pid is not a positive integer: ${describeValue(pid)}`,
    );
  }
  return pid;
}

/** 소유가 확인된 프로세스에만 시그널을 보낸다. 검증되지 않은 pid는 건드리지 않는다. */
export async function terminateOwnedProcess(
  child: ChildProcess,
  ports: IsolationProcessPorts,
  graceMs: number,
): Promise<void> {
  if (hasExited(child)) return;
  const rawPid: unknown = child.pid;
  if (typeof rawPid !== "number" || !Number.isInteger(rawPid) || rawPid <= 1) return;
  const pid = rawPid;
  try {
    ports.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  if (await waitForExit(child, graceMs)) return;
  try {
    ports.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  await waitForExit(child, graceMs);
}

export function stopImmediately(
  ports: IsolationProcessPorts,
  pid: number,
): void {
  try {
    ports.kill(pid, "SIGKILL");
  } catch {
    // 이미 끝난 프로세스다.
  }
}

export function waitForCompletion(child: ChildProcess): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}> {
  if (hasExited(child)) {
    return Promise.resolve({ exitCode: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (exitCode, signal) => {
      resolve({ exitCode, signal });
    });
    child.once("error", () => {
      resolve({ exitCode: null, signal: null });
    });
  });
}

export function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SessionIsolationUnavailableError(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 상자 준비 실패는 모두 SESSION_ISOLATION_UNAVAILABLE로 모은다. pasta의 stderr는
 * 원인 파악에만 쓰고 네트워크 대체 경로로 쓰지 않는다.
 */
export function asIsolationUnavailable(error: unknown, pastaDiagnostics: string): Error {
  const diagnostics = pastaDiagnostics.trim();
  const suffix = diagnostics.length === 0 ? "" : `; pasta stderr: ${diagnostics}`;
  if (error instanceof SessionIsolationUnavailableError) {
    return diagnostics.length === 0 ? error : new SessionIsolationUnavailableError(
      `${error.detail}${suffix}`,
      { cause: error },
    );
  }
  const message = error instanceof Error ? error.message : describeValue(error);
  return new SessionIsolationUnavailableError(`${message}${suffix}`, { cause: error });
}

export function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return Object.prototype.toString.call(value);
}

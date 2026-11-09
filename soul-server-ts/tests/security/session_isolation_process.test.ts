import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { IsolationProcessPorts } from "../../src/security/session_isolation_contract.js";
import {
  assertOwnedProcessId,
  terminateOwnedProcess,
  waitForCompletion,
  withTimeout,
} from "../../src/runner/session_isolation_process.js";
import { SessionIsolationUnavailableError } from "../../src/runner/session_isolation_preflight.js";

class FakeChild extends EventEmitter {
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(pid: unknown) {
    super();
    this.pid = pid as number | undefined;
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

function fakePorts() {
  const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const ports: IsolationProcessPorts = {
    spawn: vi.fn(),
    awaitNetworkReady: vi.fn(async () => undefined),
    kill(pid: number, signal: NodeJS.Signals) {
      killCalls.push({ pid, signal });
      return true;
    },
  };
  return { ports, killCalls };
}

describe("pid ownership guard", () => {
  it("returns a verified positive integer pid unchanged", () => {
    expect(assertOwnedProcessId(4242, "helper")).toBe(4242);
  });

  it("refuses everything that is not a positive integer (#1102 regression)", () => {
    const invalidPids: unknown[] = [
      1,
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "4242",
      {},
      null,
      undefined,
    ];
    for (const pid of invalidPids) {
      expect(() => assertOwnedProcessId(pid, "helper")).toThrow(
        SessionIsolationUnavailableError,
      );
    }
  });
});

describe("terminateOwnedProcess", () => {
  it("never reaches the kill port when the child pid was not a number", async () => {
    const fake = fakePorts();
    const child = new FakeChild("4242");
    await terminateOwnedProcess(child.asChildProcess(), fake.ports, 10);
    expect(fake.killCalls).toEqual([]);
  });

  it("sends SIGTERM and stops once the child exits", async () => {
    const fake = fakePorts();
    const child = new FakeChild(4242);
    const terminating = terminateOwnedProcess(child.asChildProcess(), fake.ports, 50);
    await new Promise((resolve) => setTimeout(resolve, 0));
    child.finish(null, "SIGTERM");
    await terminating;
    expect(fake.killCalls).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const fake = fakePorts();
    const child = new FakeChild(4242);
    await terminateOwnedProcess(child.asChildProcess(), fake.ports, 5);
    expect(fake.killCalls).toEqual([
      { pid: 4242, signal: "SIGTERM" },
      { pid: 4242, signal: "SIGKILL" },
    ]);
  });

  it("does nothing for a child that already exited", async () => {
    const fake = fakePorts();
    const child = new FakeChild(4242);
    child.finish(0);
    await terminateOwnedProcess(child.asChildProcess(), fake.ports, 10);
    expect(fake.killCalls).toEqual([]);
  });
});

describe("completion and timeout helpers", () => {
  it("resolves the completion with the exit code and signal", async () => {
    const child = new FakeChild(4242);
    const completion = waitForCompletion(child.asChildProcess());
    child.finish(3, null);
    await expect(completion).resolves.toEqual({ exitCode: 3, signal: null });
  });

  it("turns an over-time promise into SESSION_ISOLATION_UNAVAILABLE", async () => {
    const never = new Promise<void>(() => undefined);
    await expect(withTimeout(never, 5, "network readiness")).rejects.toThrow(
      /network readiness timed out after 5ms/,
    );
  });
});

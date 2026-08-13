import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { installProcessErrorHandlers } from "../../src/runtime/process_error_handlers.js";

type Listener = (...args: never[]) => void;

function fakeProcess() {
  const listeners = new Map<string, Listener[]>();
  return {
    listeners,
    on(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return this;
    },
    removeListener(event: string, listener: Listener) {
      listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== listener));
      return this;
    },
  };
}

function fakeLogger() {
  const calls: Array<{ context: Record<string, unknown>; message: string }> = [];
  return {
    calls,
    error(context: Record<string, unknown>, message: string) {
      calls.push({ context, message });
    },
  };
}

describe("process error handlers", () => {
  it("logs an unhandled rejection without rethrowing", () => {
    const runtimeProcess = fakeProcess();
    const logger = fakeLogger();
    installProcessErrorHandlers({
      component: "soul-server",
      logger,
      runtimeProcess: runtimeProcess as unknown as NodeJS.Process,
    });

    const handler = runtimeProcess.listeners.get("unhandledRejection")?.[0];
    expect(handler).toBeDefined();
    const reason = new Error("stray rejection");
    expect(() => (handler as (reason: unknown) => void)(reason)).not.toThrow();

    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0].context).toMatchObject({
      event: "process.unhandled_rejection",
      component: "soul-server",
      err: reason,
      survived: true,
    });
  });

  it("observes uncaught exceptions without taking over Node's exit policy", () => {
    const runtimeProcess = fakeProcess();
    const logger = fakeLogger();
    installProcessErrorHandlers({
      component: "session-runner",
      logger,
      runtimeProcess: runtimeProcess as unknown as NodeJS.Process,
    });

    // Subscribing to `uncaughtException` would suppress the default crash.
    // `uncaughtExceptionMonitor` only observes, which is what we want.
    expect(runtimeProcess.listeners.get("uncaughtException") ?? []).toHaveLength(0);
    const handler = runtimeProcess.listeners.get("uncaughtExceptionMonitor")?.[0];
    expect(handler).toBeDefined();

    const error = new Error("boom");
    (handler as (error: Error, origin: string) => void)(error, "uncaughtException");
    expect(logger.calls[0].context).toMatchObject({
      event: "process.uncaught_exception",
      component: "session-runner",
      err: error,
      fatal: true,
    });
  });

  it("removes both listeners on uninstall", () => {
    const runtimeProcess = fakeProcess();
    const uninstall = installProcessErrorHandlers({
      component: "soul-server",
      logger: fakeLogger(),
      runtimeProcess: runtimeProcess as unknown as NodeJS.Process,
    });

    uninstall();
    expect(runtimeProcess.listeners.get("unhandledRejection")).toHaveLength(0);
    expect(runtimeProcess.listeners.get("uncaughtExceptionMonitor")).toHaveLength(0);
  });

  // Entry points boot real processes, so they cannot be exercised in-process.
  // Pin the wiring at the source level instead — an entry point that loses
  // this call regains the single-stray-rejection-kills-everything failure mode.
  it.each([
    ["../../src/main.ts", "soul-server"],
    ["../../src/runner/runner_entry.ts", "session-runner"],
  ])("installs the handlers in %s", (relativePath, component) => {
    const source = readFileSync(
      fileURLToPath(new URL(relativePath, import.meta.url)),
      "utf8",
    );
    expect(source).toContain("installProcessErrorHandlers(");
    expect(source).toContain(`component: "${component}"`);
  });
});

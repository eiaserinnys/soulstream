import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startNodeStallMonitor,
  type EventLoopDelayHistogram,
} from "../../src/runtime/node_stall_monitor.js";

const monitors: Array<{ stop(): Promise<void> }> = [];
const tempDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(monitors.splice(0).map(async (monitor) => await monitor.stop()));
  await Promise.all(tempDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("node stall monitor", () => {
  it("logs p50, p99, and max and warns when the event-loop threshold is exceeded", async () => {
    vi.useFakeTimers();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const histogram: EventLoopDelayHistogram = {
      enable: vi.fn(),
      disable: vi.fn(),
      reset: vi.fn(),
      percentile: vi.fn((percentile: number) => percentile === 50 ? 8_000_000 : 24_000_000),
      max: 31_000_000,
    };
    const monitor = startNodeStallMonitor({
      logger,
      histogram,
      histogramIntervalMs: 100,
      eventLoopWarningThresholdMs: 30,
      watchdogEnabled: false,
    });
    monitors.push(monitor);

    await vi.advanceTimersByTimeAsync(100);

    expect(histogram.enable).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventLoopDelayMs: { p50: 8, p99: 24, max: 31 },
      }),
      "node event loop delay threshold exceeded",
    );
    expect(histogram.reset).toHaveBeenCalledOnce();
  });

  it("records a stall from a worker while the main thread is blocked", async () => {
    const directory = await mkdtemp(join(tmpdir(), "node-stall-monitor-"));
    tempDirectories.push(directory);
    const diagnosticPath = join(directory, "watchdog.jsonl");
    const monitor = startNodeStallMonitor({
      logger: { info: vi.fn(), warn: vi.fn() },
      histogramIntervalMs: 1_000,
      watchdogPingIntervalMs: 20,
      watchdogStallThresholdMs: 50,
      watchdogDiagnosticPath: diagnosticPath,
    });
    monitors.push(monitor);
    const finishRunnerOperation = monitor.beginRunnerOperation({
      sessionId: "session-stalled",
      commandId: "execute:stalled",
      operation: "execute",
    });
    monitor.observeSqliteTransaction({
      transactionId: "tx-stalled",
      transactionLabel: "event_outbox.acknowledge_host_frame",
      sessionId: "session-stalled",
      attempt: 1,
      stage: "begin",
      startedAtMonoMs: 10,
      attemptStartedAtMonoMs: 10,
      observedAtMonoMs: 11,
      elapsedMs: 1,
      attemptElapsedMs: 1,
    });

    await delay(60);
    const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    Atomics.wait(signal, 0, 0, 140);
    await delay(80);
    finishRunnerOperation();
    await monitor.stop();
    monitors.splice(monitors.indexOf(monitor), 1);

    const records = (await readFile(diagnosticPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const detected = records.find((record) => record.msg === "main thread stall detected");
    const recovered = records.find((record) => record.msg === "main thread stall recovered");
    expect(detected).toMatchObject({
      source: "node-stall-watchdog",
      activeRunnerOperations: [{
        sessionId: "session-stalled",
        commandId: "execute:stalled",
        operation: "execute",
      }],
      activeSqliteTransactions: [{
        transactionId: "tx-stalled",
        stage: "begin",
      }],
    });
    expect(detected?.stalledForMs).toEqual(expect.any(Number));
    expect(recovered?.maxRoundTripMs).toEqual(expect.any(Number));
    expect(Number(recovered?.maxRoundTripMs)).toBeGreaterThanOrEqual(50);
  });
});

async function delay(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

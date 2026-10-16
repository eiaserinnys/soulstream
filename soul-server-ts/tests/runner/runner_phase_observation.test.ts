import { describe, expect, it, vi } from "vitest";

import { createRunnerPhaseObservation } from "../../src/runner/runner_phase_observation.js";

describe("runner phase observation", () => {
  it("times async and sync phases and finishes each monitor operation", async () => {
    let now = 100;
    const begins: Array<Record<string, unknown>> = [];
    const finishes: string[] = [];
    const observation = createRunnerPhaseObservation({
      nodeId: "node-a",
      scopeId: "scan-7",
      operation: "runnerRecovery.scan",
      logger: { warn: vi.fn() },
      monotonicNow: () => now,
      beginRunnerOperation: (context) => {
        begins.push(context);
        return () => finishes.push(context.phase ?? "missing-phase");
      },
    });

    const result = await observation.runAsync(
      "registration",
      { sessionId: "session-a", label: "scan" },
      async () => {
        now += 17;
        return "registered";
      },
    );
    const value = observation.runSync(
      "dbRead",
      { sessionId: "session-a", databasePath: "/tmp/runner.sqlite", label: "lifecycle" },
      () => {
        now += 5;
        return 42;
      },
    );

    expect(result).toBe("registered");
    expect(value).toBe(42);
    expect(begins).toEqual([
      expect.objectContaining({
        nodeId: "node-a",
        scanId: "scan-7",
        sessionId: "session-a",
        commandId: "scan-7",
        phase: "registration",
      }),
      expect.objectContaining({
        nodeId: "node-a",
        scanId: "scan-7",
        sessionId: "session-a",
        commandId: "scan-7",
        phase: "dbRead",
        databasePath: "/tmp/runner.sqlite",
      }),
    ]);
    expect(finishes).toEqual(["registration", "dbRead"]);
    expect(observation.phaseDurationsMs()).toEqual({ registration: 17 });
    expect(observation.databaseSummary()).toMatchObject({
      counts: { dbOpen: 0, dbRead: 1 },
      totalMs: { dbOpen: 0, dbRead: 5 },
      maxMs: { dbOpen: 0, dbRead: 5 },
      failures: { dbOpen: 0, dbRead: 0 },
      recentSamples: [{
        phase: "dbRead",
        sessionId: "session-a",
        databasePath: "/tmp/runner.sqlite",
        label: "lifecycle",
        elapsedMs: 5,
        outcome: "ok",
      }],
    });
  });

  it("preserves a failing operation and bounds database samples to 32", () => {
    let now = 0;
    const warning = vi.fn();
    const observation = createRunnerPhaseObservation({
      nodeId: "node-a",
      scopeId: "gc-3",
      operation: "runnerRecovery.releaseGc",
      logger: { warn: warning },
      monotonicNow: () => now,
      beginRunnerOperation: () => () => undefined,
    });
    const expectedError = new Error("read failed");

    expect(() => observation.runSync(
      "inspect",
      { sessionId: "session-a" },
      () => {
        now += 4;
        throw expectedError;
      },
    )).toThrow(expectedError);

    for (let index = 0; index < 40; index += 1) {
      observation.runSync(
        "dbRead",
        { sessionId: `session-${index}`, databasePath: `/tmp/${index}.sqlite`, label: "inspect" },
        () => { now += 1; },
      );
    }

    expect(observation.failureFor(expectedError)).toEqual({ phase: "inspect", elapsedMs: 4 });
    expect(observation.databaseSummary()).toMatchObject({
      counts: { dbOpen: 0, dbRead: 40 },
      totalMs: { dbOpen: 0, dbRead: 40 },
      maxMs: { dbOpen: 0, dbRead: 1 },
      failures: { dbOpen: 0, dbRead: 0 },
      recentSamples: expect.arrayContaining([
        expect.objectContaining({ sessionId: "session-8" }),
        expect.objectContaining({ sessionId: "session-39" }),
      ]),
    });
    expect(observation.databaseSummary()?.recentSamples).toHaveLength(32);
    expect(observation.databaseSummary()?.recentSamples[0]?.sessionId).toBe("session-8");
    expect(observation.phaseDurationsMs()).toEqual({ inspect: 4 });
    expect(warning).not.toHaveBeenCalled();
  });

  it("keeps the original action result when monitor observation fails", () => {
    const warning = vi.fn();
    const observation = createRunnerPhaseObservation({
      nodeId: "node-a",
      scopeId: "scan-1",
      operation: "runnerRecovery.scan",
      logger: { warn: warning },
      monotonicNow: () => 1,
      beginRunnerOperation: () => { throw new Error("monitor unavailable"); },
    });

    expect(observation.runSync("unreadable", {}, () => "unchanged")).toBe("unchanged");
    expect(warning).toHaveBeenCalledOnce();
  });
});

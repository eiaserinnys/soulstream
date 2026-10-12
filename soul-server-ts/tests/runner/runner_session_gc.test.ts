import { describe, expect, it, vi } from "vitest";

import {
  RunnerSessionGarbageCollector,
  type RunnerSessionGarbageCollectorDependencies,
} from "../../src/runner/runner_session_gc.js";
import type {
  RunnerRegistration,
  RunnerRegistrationScan,
} from "../../src/runner/runner_process_registry.js";
import { createRunnerPhaseObservation } from "../../src/runner/runner_phase_observation.js";

const NOW = Date.parse("2026-08-12T00:00:00.000Z");
const RETENTION_MS = 86_400_000;

describe("RunnerSessionGarbageCollector", () => {
  it.each(["completed", "failed", "reaped", "closed"] as const)(
    "removes an expired terminal pre-bootstrap %s session only when durable evidence is empty",
    async (lifecycleState) => {
      const subject = makeSubject();

      await expect(subject.collector.collect(scan([
        registration({
          sessionId: `empty-${lifecycleState}`,
          bootstrap: false,
          lifecycleState,
        }),
      ]))).resolves.toEqual({ removed: [`empty-${lifecycleState}`], retained: [] });
      expect(subject.removeDirectory).toHaveBeenCalledWith(`/state/empty-${lifecycleState}`);
      expect(subject.logger.info).toHaveBeenCalledWith(
        {
          sessionId: `empty-${lifecycleState}`,
          reason: "expired_terminal_prebootstrap_without_durable_work",
          executionState: lifecycleState,
          durableRecordCount: 0,
          unacknowledgedIpcFrameCount: 0,
          pendingInterventionCount: 0,
        },
        "removed expired terminal runner session state",
      );
    },
  );

  it.each([
    ["durable outbox records", "durable-records"],
    ["unacknowledged IPC frames", "unacknowledged-ipc"],
    ["pending interventions", "pending-interventions"],
  ] as const)(
    "retains an expired terminal pre-bootstrap session with %s",
    async (_evidence, evidenceKind) => {
      const sessionId = `retained-${evidenceKind}`;
      const subject = makeSubject({
        durableRecordSessions: evidenceKind === "durable-records" ? new Set([sessionId]) : undefined,
        unacknowledgedIpcSessions: evidenceKind === "unacknowledged-ipc"
          ? new Set([sessionId])
          : undefined,
        pendingInterventionSessions: evidenceKind === "pending-interventions"
          ? new Set([sessionId])
          : undefined,
      });

      await expect(subject.collector.collect(scan([
        registration({ sessionId, bootstrap: false, lifecycleState: "closed" }),
      ]))).resolves.toEqual({
        removed: [],
        retained: [{ sessionId, reason: "incomplete_bootstrap" }],
      });
      expect(subject.removeDirectory).not.toHaveBeenCalled();
    },
  );

  it("removes a legacy dead terminal session with final ACK after retention", async () => {
    const subject = makeSubject();

    await expect(subject.collector.collect(scan([
      registration({
        sessionId: "expired",
        progressedAt: "2026-08-10T23:59:59.000Z",
        registrationId: null,
        pidStartIdentity: null,
      }),
    ]))).resolves.toEqual({ removed: ["expired"], retained: [] });
    expect(subject.removeDirectory).toHaveBeenCalledWith("/state/expired");
    expect(subject.logger.info).toHaveBeenLastCalledWith(
      {
        inspected: 1,
        deleted: 1,
        deletedSessionIds: ["expired"],
        retained: 0,
        retainedByReason: {},
        retainedSessions: [],
        retentionProbeDecisions: { full_inspection_required: 1 },
        durableInspectionCount: 1,
        mutationLockCallbackEntries: 1,
        unreadableRegistrations: 0,
        startedAtMs: NOW,
        durationMs: 1,
      },
      "runner session GC sweep completed",
    );
  });

  it("uses the proven retirement marker to collect stale running lifecycle and pid evidence", async () => {
    const subject = makeSubject();

    await expect(subject.collector.collect(scan([
      registration({
        sessionId: "retired-running",
        lifecycleState: "running",
        pidAlive: true,
        retiredAt: "2026-08-10T00:00:00.000Z",
      }),
    ]))).resolves.toEqual({ removed: ["retired-running"], retained: [] });
    expect(subject.removeDirectory).toHaveBeenCalledWith("/state/retired-running");
  });

  it("never removes a legacy terminal session whose orch ACK is behind the durable tail", async () => {
    const subject = makeSubject({ pendingSessions: new Set(["pending"]) });

    await expect(subject.collector.collect(scan([
      registration({
        sessionId: "pending",
        registrationId: null,
        pidStartIdentity: null,
      }),
    ]))).resolves.toEqual({
      removed: [],
      retained: [{ sessionId: "pending", reason: "final_ack_pending" }],
    });
    expect(subject.removeDirectory).not.toHaveBeenCalled();
  });

  it("collects retired kernel-free evidence when the central session is deleted", async () => {
    const subject = makeSubject({ pendingSessions: new Set(["deleted"]) });

    await expect(subject.collector.collect(
      scan([registration({
        sessionId: "deleted",
        pid: null,
        pidAlive: false,
        pidStartIdentity: null,
        retiredAt: "2026-08-10T00:00:00.000Z",
      })]),
      { centralSessionExists: vi.fn(async () => false) },
    )).resolves.toEqual({ removed: ["deleted"], retained: [] });
    expect(subject.removeDirectory).toHaveBeenCalledWith("/state/deleted");
  });

  it("does not bypass durable replay evidence while the central session exists", async () => {
    const subject = makeSubject({ pendingSessions: new Set(["retained"]) });

    await expect(subject.collector.collect(
      scan([registration({
        sessionId: "retained",
        pid: null,
        pidAlive: false,
        pidStartIdentity: null,
        retiredAt: "2026-08-10T00:00:00.000Z",
      })]),
      { centralSessionExists: vi.fn(async () => true) },
    )).resolves.toEqual({
      removed: [],
      retained: [{ sessionId: "retained", reason: "final_ack_pending" }],
    });
    expect(subject.removeDirectory).not.toHaveBeenCalled();
  });

  it("retains metadata-proven blockers without running the full inspector", async () => {
    const subject = makeSubject({
      probeRetention: async (item) => ({
        registration: item,
        localRetentionReason: "final_ack_pending",
      }),
    });
    const session = registration({ sessionId: "metadata-pending" });

    await expect(subject.collector.collect(scan([session]))).resolves.toEqual({
      removed: [],
      retained: [{ sessionId: "metadata-pending", reason: "final_ack_pending" }],
    });
    expect(subject.inspect).not.toHaveBeenCalled();
    expect(subject.logger.info).toHaveBeenLastCalledWith(expect.objectContaining({
      retentionProbeDecisions: { final_ack_pending: 1 },
      durableInspectionCount: 0,
      mutationLockCallbackEntries: 1,
    }), "runner session GC sweep completed");
  });

  it("runs the full inspector before the existing central-deletion bypass", async () => {
    const events: string[] = [];
    const centralSessionExists = vi.fn(async () => {
      events.push("central");
      return false;
    });
    const subject = makeSubject({
      pendingSessions: new Set(["deleted-pending"]),
      probeRetention: async (item) => ({
        registration: item,
        localRetentionReason: "final_ack_pending",
      }),
    });
    const inspect = subject.inspect.getMockImplementation()!;
    subject.inspect.mockImplementation(async (...args) => {
      events.push("inspect");
      return await inspect(...args);
    });
    const session = registration({
      sessionId: "deleted-pending",
      pid: null,
      pidAlive: false,
      pidStartIdentity: null,
      retiredAt: "2026-08-10T00:00:00.000Z",
    });

    await expect(subject.collector.collect(scan([session]), { centralSessionExists }))
      .resolves.toEqual({ removed: ["deleted-pending"], retained: [] });
    expect(subject.inspect).toHaveBeenCalledTimes(1);
    expect(centralSessionExists).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["central", "inspect", "central"]);
    expect(subject.removeDirectory).toHaveBeenCalledWith("/state/deleted-pending");
  });

  it("retains a metadata blocker if the central session reappears before deletion", async () => {
    const centralSessionExists = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const subject = makeSubject({
      probeRetention: async (item) => ({
        registration: item,
        localRetentionReason: "final_ack_pending",
      }),
    });
    const session = registration({
      sessionId: "reappeared-pending",
      pid: null,
      pidAlive: false,
      pidStartIdentity: null,
      retiredAt: "2026-08-10T00:00:00.000Z",
    });

    await expect(subject.collector.collect(scan([session]), { centralSessionExists }))
      .resolves.toEqual({
        removed: [],
        retained: [{ sessionId: "reappeared-pending", reason: "central_session_present" }],
      });
    expect(subject.inspect).toHaveBeenCalledTimes(1);
    expect(centralSessionExists).toHaveBeenCalledTimes(2);
    expect(subject.removeDirectory).not.toHaveBeenCalled();
  });

  it("keeps metadata-proven blockers when the central session exists", async () => {
    const centralSessionExists = vi.fn(async () => true);
    const subject = makeSubject({
      probeRetention: async (item) => ({
        registration: item,
        localRetentionReason: "durable_replay_pending",
      }),
    });
    const session = registration({
      sessionId: "central-present",
      pid: null,
      pidAlive: false,
      pidStartIdentity: null,
      retiredAt: "2026-08-10T00:00:00.000Z",
    });

    await expect(subject.collector.collect(scan([session]), { centralSessionExists }))
      .resolves.toEqual({
        removed: [],
        retained: [{ sessionId: "central-present", reason: "durable_replay_pending" }],
      });
    expect(centralSessionExists).toHaveBeenCalledTimes(1);
    expect(subject.inspect).not.toHaveBeenCalled();
  });

  it("retains live, recent, and missing-pid evidence fail-closed", async () => {
    const subject = makeSubject({ pendingSessions: new Set(["pending"]) });

    const result = await subject.collector.collect(scan([
      registration({ sessionId: "live", pidAlive: true }),
      registration({
        sessionId: "recent",
        bootstrap: false,
        lifecycleState: "closed",
        progressedAt: "2026-08-11T12:00:00.000Z",
      }),
      registration({ sessionId: "missing", pid: null }),
    ]));

    expect(result).toEqual({
      removed: [],
      retained: [
        { sessionId: "live", reason: "live_runner" },
        { sessionId: "recent", reason: "retention_window" },
        { sessionId: "missing", reason: "pid_evidence_missing" },
      ],
    });
    expect(subject.removeDirectory).not.toHaveBeenCalled();
  });

  it("isolates unreadable session evidence and still collects healthy neighbors", async () => {
    const evidenceError = new Error("corrupt sqlite evidence");
    const subject = makeSubject({
      hydrate: async (item) => {
        if (item.config.sessionId === "broken") throw evidenceError;
        return item;
      },
    });

    await expect(subject.collector.collect({
      ...scan([
        registration({ sessionId: "broken" }),
        registration({ sessionId: "healthy" }),
      ]),
      errors: [{ directory: "/state/unreadable-neighbor", error: new Error("bad config") }],
    })).resolves.toEqual({
      removed: ["healthy"],
      retained: [{ sessionId: "broken", reason: "evidence_unreadable" }],
    });
    expect(subject.logger.warn).toHaveBeenCalledWith(
      { err: evidenceError, sessionId: "broken" },
      "runner session GC retained unreadable session evidence",
    );
  });

  it("re-reads registration ownership immediately before deletion and retains a revived runner", async () => {
    const stale = registration({ sessionId: "revived" });
    const refreshed = vi.fn()
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce({
        ...stale,
        pidAlive: true,
        pidStartIdentity: "replacement-process",
      });
    const subject = makeSubject({ refresh: refreshed });

    await expect(subject.collector.collect(scan([stale]))).resolves.toEqual({
      removed: [],
      retained: [{ sessionId: "revived", reason: "registration_changed" }],
    });
    expect(refreshed).toHaveBeenCalledTimes(2);
    expect(subject.removeDirectory).not.toHaveBeenCalled();
  });

  it("observes fresh registration, durable inspection, and final refresh in order", async () => {
    const candidate = registration({ sessionId: "observed" });
    const phases: string[] = [];
    let now = 10;
    const subject = makeSubject();
    const observation = createRunnerPhaseObservation({
      nodeId: "node-a",
      scopeId: "session-gc-1",
      operation: "runner.recovery.sessionGc",
      logger: subject.logger as never,
      monotonicNow: () => now++,
      beginRunnerOperation: (context) => {
        phases.push(context.phase ?? "missing");
        return () => {};
      },
    });

    await subject.collector.collect(scan([candidate]), undefined, observation);

    expect(phases).toEqual([
      "freshRegistration",
      "durableRetentionProbe",
      "durableInspection",
      "freshRegistration",
      "removeDirectory",
    ]);
    expect(subject.withMutationLock).toHaveBeenCalledWith(
      "/state/observed",
      expect.any(Function),
      { phaseObservation: observation, sessionId: "observed" },
    );
    expect(subject.logger.info).toHaveBeenLastCalledWith(expect.objectContaining({
      startedAtMs: NOW,
      durationMs: expect.any(Number),
      phaseDurationsMs: expect.objectContaining({
        freshRegistration: expect.any(Number),
        durableInspection: expect.any(Number),
        otherMs: expect.any(Number),
      }),
    }), "runner session GC sweep completed");
    const sweepSummary = subject.logger.info.mock.calls.at(-1)?.[0] as {
      durationMs: number;
      phaseDurationsMs: Record<string, number>;
    };
    const measuredNonDbMs = [
      "mutationQueueWait",
      "mutationAcquire",
      "mutationRelease",
      "freshRegistration",
      "durableRetentionProbe",
      "durableInspection",
      "centralSessionLookup",
      "removeDirectory",
    ].reduce((total, phase) => total + (sweepSummary.phaseDurationsMs[phase] ?? 0), 0);
    expect(sweepSummary.phaseDurationsMs.otherMs).toBe(
      Math.max(0, sweepSummary.durationMs - measuredNonDbMs),
    );
    expect(sweepSummary.phaseDurationsMs).not.toHaveProperty("dbOpen");
    expect(sweepSummary.phaseDurationsMs).not.toHaveProperty("dbRead");
  });

  it("labels only guarded central session lookups", async () => {
    const centralSessionExists = vi.fn(async () => false);
    const contexts: Array<{ phase?: string; operation?: string; sessionId?: string }> = [];
    const subject = makeSubject();
    const observation = createRunnerPhaseObservation({
      nodeId: "node-a",
      scopeId: "session-gc-central-lookup",
      operation: "runner.recovery.sessionGc",
      logger: subject.logger as never,
      monotonicNow: (() => {
        let now = 0;
        return () => now++;
      })(),
      beginRunnerOperation: (context) => {
        contexts.push({ phase: context.phase, operation: context.operation, sessionId: context.sessionId });
        return () => {};
      },
    });

    await subject.collector.collect(scan([
      registration({
        sessionId: "deleted",
        pid: null,
        pidStartIdentity: null,
        retiredAt: "2026-08-10T00:00:00.000Z",
      }),
      registration({ sessionId: "legacy" }),
    ]), { centralSessionExists }, observation);

    expect(centralSessionExists.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      "deleted",
      "deleted",
    ]);
    expect(contexts.filter((context) => context.phase === "centralSessionLookup")).toEqual([
      {
        phase: "centralSessionLookup",
        operation: "runner.recovery.sessionGc.centralSessionLookup.initial",
        sessionId: "deleted",
      },
      {
        phase: "centralSessionLookup",
        operation: "runner.recovery.sessionGc.centralSessionLookup.beforeDelete",
        sessionId: "deleted",
      },
    ]);
  });

  it("records failed sweep duration and preserves the original error", async () => {
    const failure = new Error("mutation acquire failed");
    const subject = makeSubject({
      monotonicNow: vi.fn()
        .mockReturnValueOnce(20)
        .mockReturnValueOnce(32),
      withMutationLock: async () => { throw failure; },
    });

    await expect(subject.collector.collect(scan([registration({ sessionId: "failed" })])))
      .rejects.toBe(failure);
    expect(subject.logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      err: failure,
      startedAtMs: NOW,
      durationMs: 12,
    }), "runner session GC sweep failed");
  });
});

function makeSubject(options: {
  pendingSessions?: Set<string>;
  durableRecordSessions?: Set<string>;
  unacknowledgedIpcSessions?: Set<string>;
  pendingInterventionSessions?: Set<string>;
  hydrate?: (registration: RunnerRegistration) => Promise<RunnerRegistration>;
  refresh?: (registration: RunnerRegistration) => Promise<RunnerRegistration>;
  probeRetention?: (
    registration: RunnerRegistration,
  ) => Promise<{
    registration: RunnerRegistration;
    localRetentionReason: "incomplete_bootstrap" | "final_ack_pending" | "durable_replay_pending" | null;
  }>;
  monotonicNow?: () => number;
  withMutationLock?: RunnerSessionGarbageCollectorDependencies["withMutationLock"];
} = {}) {
  const removeDirectory = vi.fn(async () => {});
  let monotonicTime = 0;
  const withMutationLock = vi.fn(options.withMutationLock ?? (async <T>(
    _path: string,
    operation: () => Promise<T>,
  ) => await operation()));
  const probeRetention = vi.fn(options.probeRetention ?? (async (item) => ({
    registration: item,
    localRetentionReason: null,
  })));
  const inspect = vi.fn(async (item) => {
    const hydrated = await (options.hydrate ?? (async (candidate) => candidate))(item);
    const hasBootstrap = hydrated.bootstrap !== null;
    return {
      registration: hydrated,
      acknowledgedThrough: hasBootstrap
        ? options.pendingSessions?.has(item.config.sessionId) ? 2 : 3
        : null,
      latestDurableSourceSeq: hasBootstrap ? 3 : null,
      incompleteDurableWork: options.pendingSessions?.has(item.config.sessionId) ?? false,
      durableRecordCount: options.durableRecordSessions?.has(item.config.sessionId)
        ? 1
        : hydrated.bootstrap === null ? 0 : 3,
      unacknowledgedIpcFrameCount: options.unacknowledgedIpcSessions
        ?.has(item.config.sessionId) ? 1 : 0,
      pendingInterventionCount: options.pendingInterventionSessions
        ?.has(item.config.sessionId) ? 1 : 0,
    };
  });
  const deps = {
    now: () => NOW,
    monotonicNow: options.monotonicNow ?? (() => monotonicTime++),
    withMutationLock,
    refresh: options.refresh ?? (async (item: RunnerRegistration) => item),
    probeRetention,
    inspect,
    removeDirectory,
  } as RunnerSessionGarbageCollectorDependencies;
  const logger = { info: vi.fn(), warn: vi.fn() };
  return {
    collector: new RunnerSessionGarbageCollector(
      "/state",
      RETENTION_MS,
      logger as never,
      deps,
    ),
    removeDirectory,
    withMutationLock,
    probeRetention,
    inspect,
    logger,
  };
}

function scan(registrations: RunnerRegistration[]): RunnerRegistrationScan {
  return { registrations, errors: [] };
}

function registration(options: {
  sessionId: string;
  pid?: number | null;
  pidAlive?: boolean;
  progressedAt?: string;
  registrationId?: string | null;
  pidStartIdentity?: string | null;
  bootstrap?: boolean;
  lifecycleState?: "running" | "completed" | "failed" | "reaped" | "closed";
  retiredAt?: string;
}): RunnerRegistration {
  const sessionId = options.sessionId;
  return {
    config: {
      sessionId,
      codeSha: "release-a",
      paths: {
        sessionDirectory: `/state/${sessionId}`,
        databasePath: `/state/${sessionId}/runner.sqlite`,
      },
    } as never,
    pid: options.pid === undefined ? 42 : options.pid,
    pidAlive: options.pidAlive ?? false,
    registrationId: options.registrationId === undefined
      ? "registration-a"
      : options.registrationId,
    pidStartIdentity: options.pidStartIdentity === undefined
      ? "process-start-a"
      : options.pidStartIdentity,
    retiredAt: options.retiredAt ?? null,
    registeredAtMs: NOW - RETENTION_MS * 2,
    bootstrap: options.bootstrap === false
      ? null
      : { payload: { code_sha: "release-a" } } as never,
    lifecycle: {
      session_id: sessionId,
      runner_pid: 42,
      execution_command_id: "execute-a",
      execution_state: options.lifecycleState ?? "completed",
      progress_seq: 2,
      progress_at: options.progressedAt ?? "2026-08-10T00:00:00.000Z",
      liveness_at: options.progressedAt ?? "2026-08-10T00:00:00.000Z",
      in_flight_tools: [],
      terminal_error: null,
    },
  };
}

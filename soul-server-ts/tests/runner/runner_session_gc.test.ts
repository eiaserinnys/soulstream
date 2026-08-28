import { describe, expect, it, vi } from "vitest";

import {
  RunnerSessionGarbageCollector,
  type RunnerSessionGarbageCollectorDependencies,
} from "../../src/runner/runner_session_gc.js";
import type {
  RunnerRegistration,
  RunnerRegistrationScan,
} from "../../src/runner/runner_process_registry.js";

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
        unreadableRegistrations: 0,
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
});

function makeSubject(options: {
  pendingSessions?: Set<string>;
  durableRecordSessions?: Set<string>;
  unacknowledgedIpcSessions?: Set<string>;
  pendingInterventionSessions?: Set<string>;
  hydrate?: (registration: RunnerRegistration) => Promise<RunnerRegistration>;
  refresh?: (registration: RunnerRegistration) => Promise<RunnerRegistration>;
} = {}) {
  const removeDirectory = vi.fn(async () => {});
  const deps = {
    now: () => NOW,
    withMutationLock: async <T>(_path: string, operation: () => Promise<T>) =>
      await operation(),
    refresh: options.refresh ?? (async (item: RunnerRegistration) => item),
    inspect: async (item) => {
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
    },
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

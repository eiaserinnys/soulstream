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
      registration({ sessionId: "recent", progressedAt: "2026-08-11T12:00:00.000Z" }),
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
  hydrate?: (registration: RunnerRegistration) => Promise<RunnerRegistration>;
  refresh?: (registration: RunnerRegistration) => Promise<RunnerRegistration>;
} = {}) {
  const removeDirectory = vi.fn(async () => {});
  const deps = {
    now: () => NOW,
    refresh: options.refresh ?? (async (item: RunnerRegistration) => item),
    inspect: async (item) => ({
      registration: await (options.hydrate ?? (async (candidate) => candidate))(item),
      acknowledgedThrough: options.pendingSessions?.has(item.config.sessionId) ? 2 : 3,
      latestDurableSourceSeq: 3,
      incompleteDurableWork: options.pendingSessions?.has(item.config.sessionId) ?? false,
    }),
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
    registeredAtMs: NOW - RETENTION_MS * 2,
    bootstrap: { payload: { code_sha: "release-a" } } as never,
    lifecycle: {
      session_id: sessionId,
      runner_pid: 42,
      execution_command_id: "execute-a",
      execution_state: "completed",
      progress_seq: 2,
      progress_at: options.progressedAt ?? "2026-08-10T00:00:00.000Z",
      liveness_at: options.progressedAt ?? "2026-08-10T00:00:00.000Z",
      in_flight_tools: [],
      terminal_error: null,
    },
  };
}

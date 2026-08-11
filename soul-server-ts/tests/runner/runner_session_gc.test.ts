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
  it("removes only a dead terminal session with final ACK after retention", async () => {
    const subject = makeSubject();

    await expect(subject.collector.collect(scan([
      registration({ sessionId: "expired", progressedAt: "2026-08-10T23:59:59.000Z" }),
    ]))).resolves.toEqual({ removed: ["expired"], retained: [] });
    expect(subject.removeDirectory).toHaveBeenCalledWith("/state/expired");
  });

  it("retains live, recent, missing-pid, and final-ACK-pending evidence fail-closed", async () => {
    const subject = makeSubject({ pendingSessions: new Set(["pending"]) });

    const result = await subject.collector.collect(scan([
      registration({ sessionId: "live", pidAlive: true }),
      registration({ sessionId: "recent", progressedAt: "2026-08-11T12:00:00.000Z" }),
      registration({ sessionId: "missing", pid: null }),
      registration({ sessionId: "pending" }),
    ]));

    expect(result).toEqual({
      removed: [],
      retained: [
        { sessionId: "live", reason: "live_runner" },
        { sessionId: "recent", reason: "retention_window" },
        { sessionId: "missing", reason: "pid_evidence_missing" },
        { sessionId: "pending", reason: "final_ack_pending" },
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
      { error: evidenceError, sessionId: "broken" },
      "runner session GC retained unreadable session evidence",
    );
  });
});

function makeSubject(options: {
  pendingSessions?: Set<string>;
  hydrate?: (registration: RunnerRegistration) => Promise<RunnerRegistration>;
} = {}) {
  const removeDirectory = vi.fn(async () => {});
  const deps: RunnerSessionGarbageCollectorDependencies = {
    now: () => NOW,
    inspect: async (item) => ({
      registration: await (options.hydrate ?? (async (candidate) => candidate))(item),
      incompleteDurableWork: options.pendingSessions?.has(item.config.sessionId) ?? false,
    }),
    removeDirectory,
  };
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
    registeredAtMs: NOW - RETENTION_MS * 2,
    bootstrap: { payload: { code_sha: "release-a" } } as never,
    lifecycle: {
      session_id: sessionId,
      runner_pid: 42,
      execution_command_id: "execute-a",
      execution_state: "completed",
      progress_seq: 2,
      progress_at: options.progressedAt ?? "2026-08-10T00:00:00.000Z",
      terminal_error: null,
    },
  };
}

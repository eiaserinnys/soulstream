import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RunnerParentOutbox } from "../../src/runner/runner_parent_outbox.js";
import { createRunnerPhaseObservation } from "../../src/runner/runner_phase_observation.js";
import {
  RunnerHostStateStore,
  runnerHostStatePath,
} from "../../src/runner/runner_host_state_store.js";
import type { RunnerSqliteTransactionEvent } from "../../src/runner/runner_sqlite_connection.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

describe("RunnerHostStateStore observation", () => {
  it("observes host open, reads, transactions, and close with the session id", async () => {
    const path = runnerHostStatePath(join(await tempDirectory(), "runner.sqlite"));
    const events: RunnerSqliteTransactionEvent[] = [];
    const activeTransactions = new Set<string>();
    const observation = createRunnerPhaseObservation({
      nodeId: "node-test",
      scopeId: "host-observation",
      operation: "runner.host",
      logger: { warn: vi.fn() },
      monotonicNow: () => 1,
    });
    const store = RunnerHostStateStore.open(
      path,
      { phaseObservation: observation, sessionId: "session-a", label: "runner host state open" },
      {
        sessionId: "session-a",
        transactionObserver: (event) => {
          events.push(event);
          if (event.stage === "completed" || event.stage === "failed") {
            activeTransactions.delete(event.transactionId);
          } else {
            activeTransactions.add(event.transactionId);
          }
        },
      },
    );

    store.initializeEventCheckpoint({
      streamId: "stream-a",
      sessionId: "session-a",
      acknowledgedThrough: 1,
    });
    expect(store.readAcknowledgedThrough("stream-a", "session-a")).toBe(1);
    store.acknowledgeEvent({
      streamId: "stream-a",
      sessionId: "session-a",
      acknowledgedThrough: 2,
      latestDurableSourceSeq: 2,
    });
    store.recordHostCallApplied({
      sessionId: "session-a",
      correlationId: "host:1",
      service: "snapshot",
      operation: "persistRunState",
      createdAt: "2026-11-10T00:00:00.000Z",
    });
    expect(store.readHostCallApplied("session-a", "host:1")).toMatchObject({
      correlationId: "host:1",
    });
    store.acknowledgeHostCall("session-a", "host:1");
    expect(store.stageInterventionFallback({
      sessionId: "session-a",
      interventionId: "intervention-a",
      message: { text: "stop now" },
      queued: true,
      stagedAt: "2026-11-10T00:00:01.000Z",
    })).toEqual({ queuePosition: 1 });
    expect(store.readPendingInterventionFallbacks("session-a")).toEqual([
      {
        interventionId: "intervention-a",
        message: { text: "stop now" },
        queued: true,
      },
    ]);
    store.removeInterventionFallback("session-a", "intervention-a");
    store.close();

    const labels = [...new Set(events.map((event) => event.transactionLabel))].sort();
    expect(labels).toEqual([
      "runner_host.acknowledge_event",
      "runner_host.acknowledge_host_call",
      "runner_host.initialize_checkpoint",
      "runner_host.record_host_call_applied",
      "runner_host.remove_intervention_fallback",
      "runner_host.stage_intervention_fallback",
    ]);
    for (const label of labels) {
      expect(stagesFor(events, label), label).toEqual([
        "begin",
        "operation",
        "commit",
        "completed",
      ]);
    }
    for (const event of events) {
      expect(event.sessionId).toBe("session-a");
    }
    expect([...activeTransactions]).toEqual([]);

    const summary = observation.databaseSummary();
    expect(summary?.counts.dbOpen).toBe(1);
    expect(summary?.counts.dbClose).toBe(1);
    expect(summary?.counts.dbRead).toBeGreaterThanOrEqual(3);
    expect(summary?.failures).toEqual({ dbOpen: 0, dbRead: 0, dbClose: 0 });
    expect(summary?.recentSamples).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase: "dbOpen",
        sessionId: "session-a",
        label: "runner host state open",
      }),
      expect.objectContaining({
        phase: "dbRead",
        sessionId: "session-a",
        label: "runner_host.read_acknowledged_through",
      }),
      expect.objectContaining({
        phase: "dbRead",
        sessionId: "session-a",
        label: "runner_host.read_host_call_applied",
      }),
      expect.objectContaining({
        phase: "dbRead",
        sessionId: "session-a",
        label: "runner_host.read_pending_intervention_fallbacks",
      }),
      expect.objectContaining({
        phase: "dbClose",
        sessionId: "session-a",
        label: "runner_host.close",
        outcome: "ok",
      }),
    ]));
  });

  it("ends a failed host transaction with rollback and failed stages", async () => {
    const path = runnerHostStatePath(join(await tempDirectory(), "runner.sqlite"));
    const first = RunnerHostStateStore.open(path);
    first.initializeEventCheckpoint({
      streamId: "stream-a",
      sessionId: "session-a",
      acknowledgedThrough: 1,
    });
    first.close();

    const events: RunnerSqliteTransactionEvent[] = [];
    const activeTransactions = new Set<string>();
    const store = RunnerHostStateStore.open(path, undefined, {
      sessionId: "session-a",
      transactionObserver: (event) => {
        events.push(event);
        if (event.stage === "completed" || event.stage === "failed") {
          activeTransactions.delete(event.transactionId);
        } else {
          activeTransactions.add(event.transactionId);
        }
      },
    });

    expect(() => store.initializeEventCheckpoint({
      streamId: "stream-a",
      sessionId: "session-b",
      acknowledgedThrough: 1,
    })).toThrow("stream is already owned by another session");
    store.close();

    expect(events.map((event) => event.stage)).toEqual([
      "begin",
      "operation",
      "rollback",
      "failed",
    ]);
    expect(events.every(
      (event) => event.transactionLabel === "runner_host.initialize_checkpoint",
    )).toBe(true);
    expect(events.every((event) => event.sessionId === "session-a")).toBe(true);
    expect([...activeTransactions]).toEqual([]);
  });

  it("threads the parent outbox observer into the host store", async () => {
    const directory = await tempDirectory();
    const runnerDatabasePath = join(directory, "runner.sqlite");
    const child = await RunnerSqliteEventOutbox.create(runnerDatabasePath);
    const bootstrap = await child.initializeBootstrap({
      session_id: "session-a",
      created_at: "2026-11-10T00:00:00.000Z",
      resume: {
        schema_version: 1,
        backend_session_id: "backend-a",
        cwd: "/workspace/a",
        codex_home: "/home/test/.codex",
        rollout_root: "/home/test/.codex/sessions",
        code_sha: "sha-a",
        snapshot_path: "/release/sha-a/soul-server-ts",
      },
    });
    const event = await child.append({
      session_id: "session-a",
      event_type: "assistant_message",
      payload: { type: "assistant_message", content: "durable" },
      searchable_text: "durable",
      created_at: "2026-11-10T00:00:01.000Z",
      semantic_dedupe_key: null,
      session_effect: null,
    });
    const events: RunnerSqliteTransactionEvent[] = [];
    const observation = createRunnerPhaseObservation({
      nodeId: "node-test",
      scopeId: "parent-outbox-observation",
      operation: "runner.parent",
      logger: { warn: vi.fn() },
      monotonicNow: () => 1,
    });

    const parent = await RunnerParentOutbox.open(runnerDatabasePath, "session-a", {
      phaseObservation: observation,
      transactionObserver: (transactionEvent) => events.push(transactionEvent),
    });
    await parent.acknowledge(bootstrap.stream_id, event.source_seq);
    expect(parent.ackedSeq).toBe(event.source_seq);
    parent.close();
    child.close();

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        transactionLabel: "runner_host.initialize_checkpoint",
        stage: "completed",
        sessionId: "session-a",
      }),
      expect.objectContaining({
        transactionLabel: "runner_host.acknowledge_event",
        stage: "completed",
        sessionId: "session-a",
      }),
    ]));
    expect(observation.databaseSummary()?.recentSamples).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase: "dbRead",
        sessionId: "session-a",
        label: "runner_host.read_acknowledged_through",
      }),
      expect.objectContaining({
        phase: "dbClose",
        sessionId: "session-a",
        label: "runner_host.close",
      }),
    ]));
  });
});

function stagesFor(
  events: RunnerSqliteTransactionEvent[],
  label: string,
): string[] {
  return events
    .filter((event) => event.transactionLabel === label)
    .map((event) => event.stage);
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runner-host-observation-"));
  directories.push(directory);
  return directory;
}

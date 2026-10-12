import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import { createRunnerPhaseObservation } from "../../src/runner/runner_phase_observation.js";
import {
  hydrateRunnerRegistration,
  type RunnerRegistration,
} from "../../src/runner/runner_process_registry.js";
import { recoverRunnerDirectoryIdentity } from "../../src/runner/runner_registration_identity.js";
import { openRunnerSqliteReadOnlyDatabase } from "../../src/runner/runner_sqlite_connection.js";
import {
  RunnerSqliteLifecycle,
  readRunnerSqliteLifecycle,
} from "../../src/runner/sqlite_runner_lifecycle.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("runner database phase observation", () => {
  it("observes real SQLite open and read work without wrapping native objects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runner-phase-db-"));
    directories.push(directory);
    const databasePath = join(directory, "runner.sqlite");
    const created = await RunnerSqliteEventOutbox.create(databasePath, { sessionId: "session-a" });
    const lifecycle = RunnerSqliteLifecycle.open(databasePath, "session-a");
    lifecycle.begin({
      pid: 5123,
      commandId: "execute-a",
      progressedAt: "2026-10-12T00:00:00.000Z",
    });
    const expectedLifecycle = lifecycle.read();
    lifecycle.close();
    created.close();

    let now = 10;
    const observation = createRunnerPhaseObservation({
      nodeId: "node-test",
      scopeId: "scan-test",
      operation: "runnerRecovery.scan",
      logger: { warn: vi.fn() },
      monotonicNow: () => now++,
    });
    const reader = await RunnerSqliteEventOutbox.openReadOnly(databasePath, {
      sessionId: "session-a",
      phaseObservation: observation,
    });
    const database = openRunnerSqliteReadOnlyDatabase(databasePath, {
      phaseObservation: observation,
      sessionId: "session-a",
      label: "native-object-check",
    });
    const statement = database.prepare("SELECT 7 AS value");
    const queryResult = statement.get() as { value: number };
    database.close();
    reader.close();

    const actualLifecycle = readRunnerSqliteLifecycle(databasePath, {
      phaseObservation: observation,
      sessionId: "session-a",
      label: "lifecycle",
    });
    expect(actualLifecycle).toEqual(expectedLifecycle);
    expect(queryResult).toEqual({ value: 7 });
    expect(database.constructor.name).toBe("DatabaseSync");
    expect(statement.constructor.name).toBe("StatementSync");
    expect(observation.databaseSummary()).toMatchObject({
      counts: { dbOpen: 3, dbRead: 2 },
      failures: { dbOpen: 0, dbRead: 0 },
      recentSamples: expect.arrayContaining([
        expect.objectContaining({ phase: "dbOpen", databasePath }),
        expect.objectContaining({ phase: "dbRead", databasePath }),
      ]),
    });
  });

  it("preserves the original SQLite open failure", () => {
    const directory = "/tmp/runner-phase-missing-db";
    const observation = createRunnerPhaseObservation({
      nodeId: "node-test",
      scopeId: "scan-test",
      operation: "runnerRecovery.scan",
      logger: { warn: vi.fn() },
      monotonicNow: () => 1,
    });

    expect(() => openRunnerSqliteReadOnlyDatabase(directory, {
      phaseObservation: observation,
      sessionId: "session-a",
      label: "missing",
    })).toThrow();
    expect(observation.databaseSummary()).toMatchObject({
      counts: { dbOpen: 1, dbRead: 0 },
      failures: { dbOpen: 1, dbRead: 0 },
      recentSamples: [{ outcome: "failed", label: "missing" }],
    });
  });

  it("threads observation through recovery outbox preparation and native lifecycle reads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runner-phase-hydrate-"));
    directories.push(directory);
    const databasePath = join(directory, "runner.sqlite");
    const outbox = await RunnerSqliteEventOutbox.create(databasePath, { sessionId: "session-b" });
    outbox.close();
    const lifecycleStore = RunnerSqliteLifecycle.open(databasePath, "session-b");
    lifecycleStore.close();
    let now = 50;
    const observation = createRunnerPhaseObservation({
      nodeId: "node-test",
      scopeId: "hydrate-test",
      operation: "runnerRecovery.scan",
      logger: { warn: vi.fn() },
      monotonicNow: () => now++,
    });
    const registration = {
      config: {
        sessionId: "session-b",
        paths: { databasePath },
      },
    } as unknown as RunnerRegistration;

    const hydrated = await hydrateRunnerRegistration(registration, observation);

    expect(hydrated.bootstrap).toBeNull();
    expect(hydrated.lifecycle).toBeNull();
    expect(observation.databaseSummary()).toMatchObject({
      counts: { dbOpen: 3, dbRead: 4 },
      failures: { dbOpen: 0, dbRead: 0 },
      recentSamples: expect.arrayContaining([
        expect.objectContaining({ phase: "dbOpen", databasePath }),
        expect.objectContaining({ phase: "dbRead", databasePath }),
        expect.objectContaining({ phase: "dbOpen", label: "runner host state open" }),
      ]),
    });
  });

  it("observes SQLite identity recovery when a registration sidecar is unreadable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runner-phase-identity-"));
    directories.push(directory);
    const databasePath = join(directory, "runner.sqlite");
    const outbox = await RunnerSqliteEventOutbox.create(databasePath, { sessionId: "session-c" });
    outbox.close();
    const lifecycleStore = RunnerSqliteLifecycle.open(databasePath, "session-c");
    lifecycleStore.close();
    const observation = createRunnerPhaseObservation({
      nodeId: "node-test",
      scopeId: "identity-test",
      operation: "runnerRecovery.scan",
      logger: { warn: vi.fn() },
      monotonicNow: () => 70,
    });

    await expect(recoverRunnerDirectoryIdentity(directory, observation)).resolves.toBeNull();

    expect(observation.databaseSummary()).toMatchObject({
      counts: { dbOpen: 1, dbRead: 1 },
      failures: { dbOpen: 0, dbRead: 0 },
      recentSamples: [
        expect.objectContaining({ phase: "dbOpen", databasePath }),
        expect.objectContaining({ phase: "dbRead", databasePath }),
      ],
    });
  });
});

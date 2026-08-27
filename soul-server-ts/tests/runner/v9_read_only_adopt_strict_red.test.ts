import { mkdtemp, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClosedRunnerTailDrainer } from "../../src/runner/closed_runner_tail_drainer.js";
import { RunnerParentOutbox } from "../../src/runner/runner_parent_outbox.js";
import {
  RunnerRecoveryCoordinator,
  type RunnerRecoveryCoordinatorOptions,
} from "../../src/runner/runner_recovery_coordinator.js";
import type { RunnerRegistration } from "../../src/runner/runner_process_registry.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import type { RunnerExecutionState } from "../../src/runner/sqlite_event_outbox_schema.js";
import {
  RunnerSqliteLifecycle,
  readRunnerSqliteLifecycle,
} from "../../src/runner/sqlite_runner_lifecycle.js";
import type { Task } from "../../src/task/task_models.js";
import {
  computeEventOutboxPayloadHash,
  type EventOutboxRecord,
} from "../../src/upstream/event_outbox.js";
import type { EventOutboxPump } from "../../src/upstream/event_outbox_pump.js";
import {
  compatibilityMutationViolations,
  failSafeViolations,
  identityContinuityViolations,
  liveV9AdoptViolations,
  newViolationNames,
  terminalHarvestViolations,
  type CompatibilityMutationObservation,
  type FailSafeObservation,
  type GenerationObservation,
  type IdentityContinuityObservation,
  type LiveV9AdoptObservation,
  type TerminalHarvestObservation,
} from "./v9_read_only_adopt_strict_red_oracle.js";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type SqliteDatabase = InstanceType<typeof DatabaseSync>;
const temporaryDirectories = new Set<string>();
afterEach(async () => {
  await Promise.all([...temporaryDirectories].map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
    temporaryDirectories.delete(directory);
  }));
});
describe("v9 read-only rolling adoption strict RED", () => {
  it("axis 1: adopts a live v9 writer read-only without mutating its file", async () => {
    const ideal: LiveV9AdoptObservation = {
      adopted: true,
      userVersionAfterAdopt: 9,
      mtimeUnchangedByAdopt: true,
      schemaUnchangedByAdopt: true,
      writerAppendAfterAdoptSucceeded: true,
    };
    expect(liveV9AdoptViolations(ideal)).toEqual([]);
    const actual = await observeLiveV9Adopt();
    diagnose("axis-1", actual, liveV9AdoptViolations(actual));
    expect(liveV9AdoptViolations(actual)).toEqual([]);
  });
  it("axis 2: re-adopts the same v9 registration with NULL generation and no successor", async () => {
    // Contract: a missing v9 execution_generation is explicitly projected as
    // NULL. Identity continuity never depends on inventing generation 0 or 1.
    const ideal: IdentityContinuityObservation = {
      adoptedRegistrationIds: ["registration-v9-stable", "registration-v9-stable"],
      expectedRegistrationId: "registration-v9-stable",
      newRunnerCount: 0,
      projectedGenerations: [null, null],
    };
    expect(identityContinuityViolations(ideal)).toEqual([]);
    const actual = await observeDisconnectAndReadopt();
    diagnose("axis-2", actual, identityContinuityViolations(actual));
    expect(identityContinuityViolations(actual)).toEqual([]);
  });
  it("axis 3: harvests a completed v9 terminal and event tail exactly once", async () => {
    const expectedTail = [
      { sourceSeq: 2, eventType: "assistant_message" },
      { sourceSeq: 3, eventType: "session_ended" },
    ];
    const ideal: TerminalHarvestObservation = {
      harvestErrors: [],
      harvestedTail: expectedTail,
      expectedTail,
      duplicateCentralEventCount: 0,
      terminalTransitionCount: 1,
      centralStatus: "completed",
    };
    expect(terminalHarvestViolations(ideal)).toEqual([]);
    const actual = await observeCompletedTailHarvest(expectedTail);
    diagnose("axis-3", actual, terminalHarvestViolations(actual));
    expect(terminalHarvestViolations(actual)).toEqual([]);
  });
  it("axis 4: preserves v10 and rejects future or structurally invalid databases fail-safe", async () => {
    const ideal: FailSafeObservation = {
      v9TailAdopted: true,
      v10ReadAdopted: true,
      v10TailAdopted: true,
      futureVersionRejected: true,
      futureVersionReturnedData: false,
      malformedV9Rejected: true,
      malformedV10Rejected: true,
      malformedReturnedData: false,
      rejectedSourcesUnchanged: true,
    };
    expect(failSafeViolations(ideal)).toEqual([]);
    const actual = await observeVersionAndStructureGuards();
    diagnose("axis-4", actual, failSafeViolations(actual));
    expect(failSafeViolations(actual)).toEqual([]);
  });
  it("axis 5: every inverse mutation adds a new named violation over the fixed baseline", async () => {
    const fixed: CompatibilityMutationObservation = {
      supportedVersions: [9, 10],
      v9Accepted: true,
      v11Accepted: false,
      v9SourceMutated: false,
      projectedGeneration: null,
    };
    const baseline = compatibilityMutationViolations(fixed);
    expect(baseline).toEqual([]);
    const mutants: Array<[string, CompatibilityMutationObservation]> = [
      ["supported-set-dropped-v9", {
        ...fixed, supportedVersions: [10], v9Accepted: false, projectedGeneration: "unobserved",
      }],
      ["future-version-accepted", {
        ...fixed, supportedVersions: [9, 10, 11], v11Accepted: true,
      }],
      ["v9-reader-mutated-source", { ...fixed, v9SourceMutated: true }],
      ["v9-generation-fabricated", { ...fixed, projectedGeneration: 1 }],
    ];
    const mutationEvidence = Object.fromEntries(mutants.map(([name, mutant]) => [
      name,
      newViolationNames(baseline, compatibilityMutationViolations(mutant)),
    ]));
    for (const [name] of mutants) expect(mutationEvidence[name]).toContain(name);
    const actual = await observeCompatibilityBaseline();
    const violations = compatibilityMutationViolations(actual);
    diagnose("axis-5", { actual, mutationEvidence }, violations);
    expect(violations).toEqual([]);
  });
});
async function observeLiveV9Adopt(): Promise<LiveV9AdoptObservation> {
  const fixture = await createFixture(9);
  const writer = new ActiveV9Writer(fixture);
  writer.append("before adopt");
  const before = writer.fingerprint();
  let adopted = false;
  let reader: RunnerSqliteEventOutbox | undefined;
  try {
    reader = await RunnerSqliteEventOutbox.openReadOnly(fixture.databasePath);
    adopted = true;
  } catch {}
  const afterAdopt = writer.fingerprint();
  let writerAppendAfterAdoptSucceeded = false;
  try {
    writer.append("after adopt");
    writerAppendAfterAdoptSucceeded = true;
  } catch {}
  reader?.close();
  writer.close();
  return {
    adopted,
    userVersionAfterAdopt: afterAdopt.userVersion,
    mtimeUnchangedByAdopt: before.mtimeMs === afterAdopt.mtimeMs,
    schemaUnchangedByAdopt: before.schema === afterAdopt.schema,
    writerAppendAfterAdoptSucceeded,
  };
}
async function observeDisconnectAndReadopt(): Promise<IdentityContinuityObservation> {
  const fixture = await createFixture(9, "running");
  const registration = makeRegistration(fixture, true);
  const observation: IdentityContinuityObservation = {
    adoptedRegistrationIds: [],
    expectedRegistrationId: "registration-v9-stable",
    newRunnerCount: 0,
    projectedGenerations: [],
  };
  for (let host = 0; host < 2; host += 1) {
    const coordinator = makeCoordinator(registration, observation);
    await coordinator.scanOnce();
    await coordinator.waitForSettled();
    await coordinator.stop();
  }
  return observation;
}
async function observeCompletedTailHarvest(
  expectedTail: TerminalHarvestObservation["expectedTail"],
): Promise<TerminalHarvestObservation> {
  const fixture = await createFixture(9, "completed", true);
  const harvestedTail: TerminalHarvestObservation["harvestedTail"] = [];
  const seen = new Set<string>();
  let duplicateCentralEventCount = 0;
  let terminalTransitionCount = 0;
  let centralStatus: "running" | "completed" = "running";
  const register = (pump: EventOutboxPump) => {
    pump.connect(async (batch) => {
      for (const event of batch.events) {
        const key = `${event.stream_id}:${event.source_seq}`;
        if (seen.has(key)) duplicateCentralEventCount += 1;
        seen.add(key);
        harvestedTail.push({ sourceSeq: event.source_seq, eventType: event.event_type });
        if (event.event_type === "session_ended"
          && (event.payload as { status?: string }).status === "completed"
          && centralStatus !== "completed") {
          centralStatus = "completed";
          terminalTransitionCount += 1;
        }
      }
      await pump.handleAck({
        type: "event_append_ack",
        stream_id: batch.stream_id,
        acked_through: batch.events.at(-1)!.source_seq,
        events: batch.events.map((event) => ({
          source_seq: event.source_seq,
          event_id: 10_000 + event.source_seq,
        })),
      });
    });
    return () => {};
  };
  const drainer = new ClosedRunnerTailDrainer({
    pumpMux: { register },
    logger: quietLogger(),
  });
  const harvestErrors: string[] = [];
  for (let host = 0; host < 2; host += 1) {
    try {
      await drainer.drain(makeRegistration(fixture, false));
    } catch (error) {
      harvestErrors.push(errorMessage(error));
    }
  }
  return {
    harvestErrors,
    harvestedTail,
    expectedTail,
    duplicateCentralEventCount,
    terminalTransitionCount,
    centralStatus,
  };
}
async function observeVersionAndStructureGuards(): Promise<FailSafeObservation> {
  const v9 = await createFixture(9);
  const v10 = await createFixture(10);
  const v11 = await createFixture(10);
  setUserVersion(v11.databasePath, 11);
  const malformedV9 = await createFixture(9);
  const malformedV10 = await createFixture(10);
  removeRequiredColumn(malformedV9.databasePath);
  removeRequiredColumn(malformedV10.databasePath);
  const guarded = [v11, malformedV9, malformedV10];
  const before = await Promise.all(guarded.map((fixture) => fingerprint(fixture.databasePath)));
  const [v9Tail, v10Read, v10Tail, future, bad9, bad10] = await Promise.all([
    attemptRead(v9.databasePath, "tail"),
    attemptRead(v10.databasePath, "full"),
    attemptRead(v10.databasePath, "tail"),
    attemptRead(v11.databasePath, "full"),
    attemptRead(malformedV9.databasePath, "full"),
    attemptRead(malformedV10.databasePath, "full"),
  ]);
  const after = await Promise.all(guarded.map((fixture) => fingerprint(fixture.databasePath)));
  return {
    v9TailAdopted: v9Tail.adopted,
    v10ReadAdopted: v10Read.adopted,
    v10TailAdopted: v10Tail.adopted,
    futureVersionRejected: !future.adopted,
    futureVersionReturnedData: future.returnedData,
    malformedV9Rejected: !bad9.adopted,
    malformedV10Rejected: !bad10.adopted,
    malformedReturnedData: bad9.returnedData || bad10.returnedData,
    rejectedSourcesUnchanged: before.every((item, index) => sameFingerprint(item, after[index]!)),
  };
}
async function observeCompatibilityBaseline(): Promise<CompatibilityMutationObservation> {
  const v9 = await createFixture(9);
  const v10 = await createFixture(10);
  const v11 = await createFixture(10);
  setUserVersion(v11.databasePath, 11);
  const before = await fingerprint(v9.databasePath);
  const [read9, read10, read11] = await Promise.all([
    attemptRead(v9.databasePath, "full"),
    attemptRead(v10.databasePath, "full"),
    attemptRead(v11.databasePath, "full"),
  ]);
  const after = await fingerprint(v9.databasePath);
  const supportedVersions = [
    ...(read9.adopted ? [9] : []),
    ...(read10.adopted ? [10] : []),
    ...(read11.adopted ? [11] : []),
  ];
  return {
    supportedVersions,
    v9Accepted: read9.adopted,
    v11Accepted: read11.adopted,
    v9SourceMutated: !sameFingerprint(before, after),
    projectedGeneration: read9.generation,
  };
}
interface Fixture {
  directory: string;
  databasePath: string;
  sessionId: string;
  streamId: string;
  bootstrap: RunnerRegistration["bootstrap"];
}
async function createFixture(
  version: 9 | 10,
  state: RunnerExecutionState = "running",
  terminalTail = false,
): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "v9-read-only-adopt-red-"));
  temporaryDirectories.add(directory);
  const databasePath = join(directory, "runner.sqlite");
  const sessionId = `session-${version}-${temporaryDirectories.size}`;
  const writer = await RunnerSqliteEventOutbox.create(databasePath);
  const bootstrap = await writer.initializeBootstrap({
    session_id: sessionId,
    created_at: "2026-08-28T00:00:00.000Z",
    resume: {
      schema_version: 1,
      backend_session_id: `backend-${sessionId}`,
      cwd: `/workspace/${sessionId}`,
      codex_home: null,
      rollout_root: null,
      code_sha: "release-v9-compat",
      snapshot_path: "/release/v9-compat",
    },
  });
  await writer.append(eventInput(sessionId, "assistant_message", "v9 tail one", 1));
  if (terminalTail) {
    await writer.append({
      ...eventInput(sessionId, "session_ended", null, 2),
      payload: { type: "session_ended", status: "completed" },
      semantic_dedupe_key: `terminal:${sessionId}`,
    });
  }
  const lifecycle = RunnerSqliteLifecycle.open(databasePath, sessionId);
  lifecycle.begin({ pid: 4123, commandId: "execute-v9", progressedAt: "2026-08-28T00:00:00.500Z" });
  if (state !== "running") lifecycle.finish("execute-v9", state, "2026-08-28T00:00:03.000Z");
  lifecycle.close();
  writer.close();
  if (version === 9) {
    const database = new DatabaseSync(databasePath);
    database.exec("ALTER TABLE runner_event_outbox DROP COLUMN execution_generation; PRAGMA user_version = 9");
    database.close();
  }
  return { directory, databasePath, sessionId, streamId: bootstrap.stream_id, bootstrap };
}
function makeRegistration(fixture: Fixture, pidAlive: boolean): RunnerRegistration {
  return {
    config: {
      schemaVersion: 1, sessionId: fixture.sessionId, backend: "codex",
      agent: { id: "agent-v9", name: "Agent V9", backend: "codex", workspace_dir: fixture.directory },
      paths: {
        sessionDirectory: fixture.directory, databasePath: fixture.databasePath,
        socketPath: join(fixture.directory, "runner.sock"), pidPath: join(fixture.directory, "runner.pid"),
        lockPath: join(fixture.directory, "runner.lock"), configPath: join(fixture.directory, "runner-config.json"),
      },
      codeSha: "release-v9-compat", snapshotPath: "/release/v9-compat", codexAdapterMode: "sdk",
      claudeRuntimeV2Enabled: true, claudeRuntimeIdleTtlMs: 300_000,
      claudeRuntimeMaxEntries: 16, claudeRuntimeTurnTimeoutMs: 600_000,
      internalMcpUrl: "http://127.0.0.1:4206/mcp/internal", codexHome: null, rolloutRoot: null,
    },
    pid: 4123, registrationId: "registration-v9-stable", pidStartIdentity: "start-4123-v9",
    pidAlive, registeredAtMs: Date.parse("2026-08-28T00:00:00.000Z"),
    bootstrap: fixture.bootstrap, lifecycle: readRunnerSqliteLifecycle(fixture.databasePath),
  };
}
function makeCoordinator(
  registration: RunnerRegistration,
  observation: IdentityContinuityObservation,
): RunnerRecoveryCoordinator {
  const task: Task = {
    agentSessionId: registration.config.sessionId, prompt: "continue", status: "running",
    createdAt: new Date("2026-08-28T00:00:00.000Z"), lastEventId: 0,
    lastReadEventId: 0, interventionQueue: [],
  };
  const options = {
    nodeId: "node-v9", stateDirectory: registration.config.paths.sessionDirectory,
    leaseTimeoutMs: 120_000, scanIntervalMs: 15_000, closedTailDrainer: { drain: async () => {} },
    logger: quietLogger(), scan: async () => ({ registrations: [registration], errors: [] }),
    now: () => Date.parse("2026-08-28T00:00:30.000Z"),
    spawner: { terminate: async () => {}, invalidateRegistration: async () => {}, retireTerminalRegistration: async () => {} },
    taskExecutor: {
      recoverRegisteredRunner: async (_task: Task, hydrated: RunnerRegistration) => {
        observation.adoptedRegistrationIds.push(hydrated.registrationId ?? "missing");
        const parent = await RunnerParentOutbox.open(
          hydrated.config.paths.databasePath,
          hydrated.config.sessionId,
        );
        try {
          const batch = await parent.readBatch();
          const first = batch?.events[0];
          observation.projectedGenerations.push(first
            ? (first.execution_generation ?? null)
            : "unobserved");
        } finally {
          parent.close();
        }
      },
      restartRegisteredRunner: async () => { observation.newRunnerCount += 1; },
    },
    taskManager: {
      hydrateRunnerRecoveryTask: async () => task,
      markRunnerFailureAndResume: async () => {}, projectClosedRunner: async () => true,
      listOwnerNullRunningInventory: async () => [],
      reconcileExecutionOwnershipObservations: async () => false,
    },
  } as unknown as RunnerRecoveryCoordinatorOptions;
  return new RunnerRecoveryCoordinator(options);
}
class ActiveV9Writer {
  private readonly database: DatabaseSync;
  constructor(private readonly fixture: Fixture) {
    this.database = new DatabaseSync(fixture.databasePath);
  }
  append(content: string): void {
    const sourceSeq = Number((this.database.prepare(
      "SELECT COALESCE(MAX(source_seq), 0) + 1 AS value FROM runner_event_outbox",
    ).get() as { value: number }).value);
    const unsigned: Omit<EventOutboxRecord, "payload_hash"> = {
      stream_id: this.fixture.streamId, source_seq: sourceSeq, session_id: this.fixture.sessionId,
      event_type: "assistant_message", payload: { type: "assistant_message", content },
      searchable_text: content, created_at: new Date(1_777_500_000_000 + sourceSeq).toISOString(),
      semantic_dedupe_key: null, session_effect: null,
    };
    this.database.prepare(`INSERT INTO runner_event_outbox (
      source_seq, record_kind, stream_id, session_id, event_type, payload_json, searchable_text,
      created_at, semantic_dedupe_key, session_effect_json, payload_hash, runner_metadata_json, acked_through
    ) VALUES (?, 'event', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL)`).run(
      sourceSeq, unsigned.stream_id, unsigned.session_id, unsigned.event_type,
      JSON.stringify(unsigned.payload), unsigned.searchable_text, unsigned.created_at,
      computeEventOutboxPayloadHash(unsigned),
    );
  }
  fingerprint() { return fingerprintFrom(this.database, this.fixture.databasePath); }
  close() { this.database.close(); }
}
async function attemptRead(path: string, mode: "full" | "tail"): Promise<{
  adopted: boolean; returnedData: boolean; generation: GenerationObservation;
}> {
  let reader: RunnerSqliteEventOutbox | undefined;
  try {
    reader = mode === "full"
      ? await RunnerSqliteEventOutbox.openReadOnly(path)
      : await RunnerSqliteEventOutbox.openReadOnlyTail(path);
    const batch = await reader.readBatch();
    const first = batch?.events[0];
    return { adopted: true, returnedData: Boolean(first), generation: first ? (first.execution_generation ?? null) : "unobserved" };
  } catch {
    return { adopted: false, returnedData: false, generation: "unobserved" };
  } finally {
    reader?.close();
  }
}
function eventInput(sessionId: string, eventType: string, content: string | null, second: number) {
  return {
    session_id: sessionId, event_type: eventType,
    payload: { type: eventType, ...(content === null ? {} : { content }) },
    searchable_text: content, created_at: `2026-08-28T00:00:0${second}.000Z`,
    semantic_dedupe_key: null, session_effect: null,
  };
}
async function fingerprint(path: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  try { return fingerprintFrom(database, path); } finally { database.close(); }
}
function fingerprintFrom(database: SqliteDatabase, path: string) {
  return {
    userVersion: Number((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version),
    mtimeMs: statSync(path).mtimeMs,
    schema: JSON.stringify(database.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
    ).all()),
  };
}
function sameFingerprint(left: Awaited<ReturnType<typeof fingerprint>>, right: Awaited<ReturnType<typeof fingerprint>>) {
  return left.userVersion === right.userVersion && left.mtimeMs === right.mtimeMs && left.schema === right.schema;
}
function setUserVersion(path: string, version: number): void {
  const database = new DatabaseSync(path);
  database.exec(`PRAGMA user_version = ${version}`);
  database.close();
}
function removeRequiredColumn(path: string): void {
  const database = new DatabaseSync(path);
  database.exec("ALTER TABLE runner_event_outbox DROP COLUMN runner_metadata_json");
  database.close();
}
function quietLogger() {
  return { error: () => {}, info: () => {}, warn: () => {} } as never;
}
function diagnose(axis: string, observation: unknown, violations: string[]): void {
  console.info(`[strict-red diagnostic] ${axis}`, JSON.stringify({ observation, violations }));
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

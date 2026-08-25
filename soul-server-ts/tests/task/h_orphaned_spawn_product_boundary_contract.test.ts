import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { EventSessionTransitionApplication } from
  "../../src/db/event_transition_publisher.js";
import type { EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import { runnerCommandResultFrame } from "../../src/runner/frame_protocol.js";
import type { RunnerIpcConnection } from "../../src/runner/runner_ipc_connection.js";
import { readAuthoritativeRunnerLifecycle } from
  "../../src/runner/runner_lifecycle_reader.js";
import { RunnerProcessDispatcher } from
  "../../src/runner/runner_process_dispatcher.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import { readRunnerPid, resolveRegisteredRunnerPid } from
  "../../src/runner/runner_process_registration.js";
import { RunnerProcessSpawner } from "../../src/runner/runner_process_spawn.js";
import {
  pendingRunnerRegistrationIdentity,
  readRunnerRegistrationIdentity,
  writeRunnerRegistrationIdentity,
} from "../../src/runner/runner_registration_identity.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import { RunnerSqliteLifecycle } from "../../src/runner/sqlite_runner_lifecycle.js";
import type { TaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";
import type { CanonicalExecutionOwnership } from
  "../../src/task/execution_ownership.js";
import {
  TaskExecutor,
  type RunnerProcessRuntimeFactory,
} from "../../src/task/task_executor.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import { EventOutboxPump } from "../../src/upstream/event_outbox_pump.js";
import { EventOutboxPumpMux } from "../../src/upstream/event_outbox_pump_mux.js";
import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";
import {
  applyHProductBoundaryMutation,
  applyHProductBoundaryRepair,
  hProductBoundaryAssertionResults,
  hProductBoundaryViolations,
  idealHProductBoundaryObservation,
  productFixedHProductBoundaryCounterfactual,
  type HProductBoundaryMutation,
  type HProductBoundaryObservation,
  type HProductBoundaryRepair,
  type HProductBoundaryViolation,
} from "./h_orphaned_spawn_product_boundary_oracle.js";

const SESSION_ID = "session-h-product-boundary";
const MESSAGE_ID = "message-h-1";
const EXISTING_PID = 7_201;
const SPAWNED_PID = 7_202;
const EXISTING_START_IDENTITY = "start-existing-h";
const SPAWNED_START_IDENTITY = "start-spawned-h";
const OBSERVED_AT = "2026-08-25T15:10:12.000Z";
const silentLogger = pino({ level: "silent" });
const temporaryDirectories: string[] = [];

interface HProductBoundaryDiagnostic {
  trace: string[];
  signalTargets: Array<{ pid: number; signal: NodeJS.Signals }>;
  resolverError: string | null;
  taskStatus: Task["status"];
  emittedEventTypes: SSEEventPayload["type"][];
}

interface HProductBoundaryFixtureResult {
  observation: HProductBoundaryObservation;
  diagnostic: HProductBoundaryDiagnostic;
}

const agent: AgentProfile = {
  id: "codex-h",
  name: "Codex H",
  backend: "codex",
  workspace_dir: "/tmp/codex-h",
};

const mutations: ReadonlyArray<readonly [
  HProductBoundaryMutation,
  HProductBoundaryViolation[],
]> = [
  ["orphan_child_survives", ["live_unowned_child"]],
  ["identity_evidence_splits", ["identity_evidence_not_single_owner"]],
  ["weaken_fail_closed_identity_check", ["identity_evidence_not_single_owner"]],
  ["followup_delivery_blocks", ["followup_delivery_blocked"]],
  ["model_and_user_outcome_missing", ["message_not_delivered_or_visible_failure"]],
  ["unsafe_replacement_spawn", ["spawn_not_exactly_once", "existing_runner_killed"]],
];

const repairReachability: ReadonlyArray<readonly [
  HProductBoundaryRepair,
  HProductBoundaryViolation[],
]> = [
  ["terminate_spawned_child", ["live_unowned_child"]],
  ["settle_identity_owner", ["identity_evidence_not_single_owner"]],
  ["restore_delivery", ["followup_delivery_blocked"]],
  ["surface_model_or_user_outcome", ["message_not_delivered_or_visible_failure"]],
  [
    "preserve_single_spawn_and_existing_runner",
    ["spawn_not_exactly_once", "existing_runner_killed"],
  ],
];

describe("H orphaned_spawn product-boundary contract", () => {
  let productFixture: HProductBoundaryFixtureResult;

  beforeAll(async () => {
    productFixture = await observeCurrentProductRollback();
  });

  afterAll(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(
      async (directory) => await rm(directory, { recursive: true, force: true }),
    ));
  });

  it("has satisfiable oracle arithmetic", () => {
    expect(hProductBoundaryViolations(idealHProductBoundaryObservation({
      authoritativeOwnerPid: EXISTING_PID,
      messageId: MESSAGE_ID,
    }))).toEqual([]);
  });

  it("keeps every contract assertion true under the product-fixed counterfactual", () => {
    const fixed = productFixedHProductBoundaryCounterfactual(
      productFixture.observation,
      { authoritativeOwnerPid: EXISTING_PID, messageId: MESSAGE_ID },
    );
    const results = hProductBoundaryAssertionResults(fixed);
    console.error(`ORPHANED_SPAWN_PRODUCT_FIXED_COUNTERFACTUAL ${JSON.stringify(results)}`);
    expect(results.filter((result) => !result.passes)).toEqual([]);
  });

  it("makes each product repair axis independently reachable without requiring a defect", () => {
    const baseline = new Set(hProductBoundaryViolations(productFixture.observation));
    const results = repairReachability.map(([repair, targetedViolations]) => {
      const repaired = applyHProductBoundaryRepair(
        productFixture.observation,
        repair,
        { authoritativeOwnerPid: EXISTING_PID, messageId: MESSAGE_ID },
      );
      const after = new Set(hProductBoundaryViolations(repaired));
      const applicable = targetedViolations.filter((violation) => baseline.has(violation));
      return {
        repair,
        applicable,
        unresolved: applicable.filter((violation) => after.has(violation)),
      };
    });
    console.error(`ORPHANED_SPAWN_REPAIR_REACHABILITY ${JSON.stringify(results)}`);
    expect(results.flatMap((result) => result.unresolved)).toEqual([]);
  });

  it.each(mutations)("mutation %s adds only its independent violation names", (
    mutation,
    expectedNewViolations,
  ) => {
    const ideal = idealHProductBoundaryObservation({
      authoritativeOwnerPid: EXISTING_PID,
      messageId: MESSAGE_ID,
    });
    const baseline = hProductBoundaryViolations(ideal);
    const mutated = hProductBoundaryViolations(
      applyHProductBoundaryMutation(ideal, mutation),
    );
    const baselineSet = new Set(baseline);
    const newViolations = mutated.filter((violation) => !baselineSet.has(violation));
    console.error(`ORPHANED_SPAWN_MUTATION ${JSON.stringify({ mutation, newViolations })}`);
    expect(newViolations).toEqual(expectedNewViolations);
  });

  it("requires the live product boundary to reach only repaired outcomes", () => {
    const violations = hProductBoundaryViolations(productFixture.observation);
    console.error(
      `ORPHANED_SPAWN_PRODUCT_BOUNDARY_DIAGNOSTIC ${JSON.stringify(productFixture)}`,
    );
    console.error(`ORPHANED_SPAWN_PRODUCT_BOUNDARY_RED ${JSON.stringify(violations)}`);
    expect(violations).toEqual([]);
  });
});

async function observeCurrentProductRollback(): Promise<HProductBoundaryFixtureResult> {
  const stateDirectory = await mkdtemp(join(tmpdir(), "h-product-boundary-v3-"));
  temporaryDirectories.push(stateDirectory);
  const paths = runnerProcessPaths(stateDirectory, SESSION_ID);
  const trace: string[] = [];
  const livePids = new Set([EXISTING_PID, SPAWNED_PID]);
  const signalTargets: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const persistenceDouble = makeEventPersistenceTestDouble();
  const canonicalOwner: CanonicalExecutionOwnership = {
    ownershipGeneration: 1,
    ownerKind: "runner_process",
    manifestId: "release-existing",
    runtimeEnvIdentity: "runtime-existing",
    registrationId: "registration-existing",
    pid: EXISTING_PID,
    startIdentity: EXISTING_START_IDENTITY,
    executionCommandId: "execute-existing",
    phase: "active",
    failureReason: null,
  };

  const outbox = await RunnerSqliteEventOutbox.create(paths.databasePath);
  await outbox.initializeBootstrap({
    session_id: SESSION_ID,
    created_at: OBSERVED_AT,
    resume: {
      schema_version: 1,
      backend_session_id: "backend-h",
      cwd: agent.workspace_dir,
      codex_home: null,
      rollout_root: null,
      code_sha: "sha-h",
      snapshot_path: "/release/sha-h/soul-server-ts",
    },
  });
  outbox.close();
  const lifecycle = RunnerSqliteLifecycle.open(paths.databasePath, SESSION_ID);
  lifecycle.begin({
    pid: EXISTING_PID,
    commandId: canonicalOwner.executionCommandId!,
    progressedAt: OBSERVED_AT,
  });
  lifecycle.close();
  const registration = {
    ...pendingRunnerRegistrationIdentity(SESSION_ID, "sha-h"),
    pid: SPAWNED_PID,
    startIdentity: SPAWNED_START_IDENTITY,
  };
  await writeRunnerRegistrationIdentity(paths.sessionDirectory, registration);
  await writeFile(paths.pidPath, `${SPAWNED_PID}\n`, { mode: 0o600 });

  const spawner = new RunnerProcessSpawner({
    prepareDatabase: async () => {},
    validateEntry: async () => {},
    spawnProcess: () => { throw new Error("rollback contract must not spawn a replacement"); },
    registerPid: async () => {},
    inspectProcess: async (pid) => ({
      alive: livePids.has(pid),
      startIdentity: pid === SPAWNED_PID
        ? SPAWNED_START_IDENTITY
        : pid === EXISTING_PID
          ? EXISTING_START_IDENTITY
          : null,
    }),
    isPidAlive: (pid) => livePids.has(pid),
    signalPid: (pid, signal) => {
      signalTargets.push({ pid, signal });
      livePids.delete(pid);
    },
    now: () => Date.parse(OBSERVED_AT),
    delay: async () => {},
    readLifecycle: async (databasePath) => {
      trace.push("rollback_read_lifecycle");
      return await readAuthoritativeRunnerLifecycle(databasePath);
    },
  });
  const connection = inertConnection();
  const dispatcher = new RunnerProcessDispatcher({
    spawn: spawnInput(stateDirectory),
    runnerProcess: {
      pid: SPAWNED_PID,
      registrationId: registration.registrationId,
      paths,
      config: {} as never,
      adopted: false,
    },
    spawner,
    connectSocket: async () => connection,
    pumpMux: new EventOutboxPumpMux(new EventOutboxPump(emptyStore("node-stream-h"), vi.fn())),
    logger: silentLogger,
    handleHostCall: async () => null,
  });
  const runner: TaskRunnerRuntime = {
    engine: inertEngine(),
    dispatcher,
    eventPersistence: "runner",
  };

  Object.assign(persistenceDouble.persistence, {
    reserveExecutionOwnershipAndWaitForApplication: vi.fn(async () => {
      trace.push("reserve_applied");
      return transition(true, "initializing", canonicalOwner);
    }),
    proveExecutionOwnershipAndWaitForApplication: vi.fn(async () => {
      trace.push("prove_applied");
      return transition(true, "initializing", canonicalOwner);
    }),
    activateExecutionOwnershipAndWaitForApplication: vi.fn(async () => {
      trace.push("activate_rejected");
      return transition(false, "running", canonicalOwner);
    }),
    markExecutionOrphanedSpawnAndWaitForApplication: vi.fn(async () => {
      trace.push("orphaned_spawn_rejected");
      return transition(false, "running", canonicalOwner);
    }),
    failExecutionOwnershipAndWaitForApplication: vi.fn(async () =>
      transition(true, "error", {
        ...canonicalOwner,
        phase: "failed",
        failureReason: "activation_rejected",
      })),
  });

  const processFactory = vi.fn(() => {
    trace.push("spawn");
    return runner;
  }) as unknown as RunnerProcessRuntimeFactory;
  processFactory.describe = vi.fn(async () => ({
    ownerKind: "runner_process",
    manifestId: "release-spawned",
    runtimeEnvIdentity: "runtime-spawned",
  }));
  const executor = new TaskExecutor(
    () => inertEngine(),
    {
      updateSession: vi.fn(async () => undefined),
      setClaudeSessionId: vi.fn(async () => undefined),
    } as unknown as SessionDB,
    persistenceDouble.persistence,
    {
      emitEventEnvelope: vi.fn(async () => undefined),
      emitSessionUpdated: vi.fn(async () => undefined),
    } as unknown as SessionBroadcaster,
    silentLogger,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    processFactory,
  );
  const task: Task = {
    agentSessionId: SESSION_ID,
    prompt: "message that must reach the model or produce a visible failure",
    status: "initializing",
    profileId: agent.id,
    createdAt: new Date(OBSERVED_AT),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };

  await executor.startExecution(task, agent);
  await task.executionActivationPromise?.catch(() => undefined);

  const identity = await readRunnerRegistrationIdentity(paths.sessionDirectory);
  const authoritativeLifecycle = await readAuthoritativeRunnerLifecycle(paths.databasePath);
  const pidFilePid = await readRunnerPid(paths.pidPath);
  const identityEvidence = {
    pidFilePid,
    identityPid: identity?.pid ?? null,
    lifecyclePid: authoritativeLifecycle?.runner_pid ?? null,
  };
  let resolverError: string | null = null;
  try {
    resolveRegisteredRunnerPid(
      identityEvidence.pidFilePid,
      identityEvidence.lifecyclePid,
      identityEvidence.identityPid,
      paths.sessionDirectory,
      (pid) => livePids.has(pid),
    );
  } catch (error) {
    resolverError = errorMessage(error);
    trace.push("followup_delivery_blocked");
  }
  const emitted = persistenceDouble.enqueueEvent.mock.calls.map(
    (call) => call[1] as SSEEventPayload,
  );
  const delivered = emitted.some((event) =>
    event.type === "assistant_message" || event.type === "complete" || event.type === "result"
  );
  const visibleFailure = task.status === "error"
    || emitted.some((event) => event.type === "error" || event.type === "session_notification");
  const outcome = delivered
    ? "delivered" as const
    : visibleFailure
      ? "visible_failure" as const
      : "not_observed_by_model_or_user" as const;
  if (outcome === "not_observed_by_model_or_user") {
    trace.push("message_not_observed_by_model_or_user");
  }

  return {
    observation: {
      spawnCount: processFactory.mock.calls.length,
      liveUnownedChildPids: [SPAWNED_PID].filter(
        (pid) => livePids.has(pid) && pid !== canonicalOwner.pid,
      ),
      identityEvidence,
      followupDeliveryErrors: resolverError === null ? [] : [resolverError],
      messages: [{ messageId: MESSAGE_ID, outcome }],
      killedExistingRunnerPids: signalTargets
        .filter((call) => call.pid === EXISTING_PID)
        .map((call) => call.pid),
    },
    diagnostic: {
      trace,
      signalTargets,
      resolverError,
      taskStatus: task.status,
      emittedEventTypes: emitted.map((event) => event.type),
    },
  };
}

function transition(
  applied: boolean,
  status: "initializing" | "running" | "error",
  canonicalExecutionOwnership: CanonicalExecutionOwnership,
): EventSessionTransitionApplication {
  return {
    eventId: 10,
    applied,
    canonicalSession: {
      status,
      termination_reason: status === "error" ? "error_aborted" : null,
      termination_detail: status === "error" ? "activation_rejected" : null,
      review_state: "not_required",
      last_assistant_text: null,
      termination_event_id: status === "error" ? 10 : null,
      updated_at: OBSERVED_AT,
      last_event_id: 10,
    },
    canonicalExecutionOwnership,
  };
}

function spawnInput(stateDirectory: string) {
  return {
    stateDirectory,
    sessionId: SESSION_ID,
    backend: "codex" as const,
    agent,
    codeSha: "sha-h",
    snapshotPath: "/release/sha-h/soul-server-ts",
    codexAdapterMode: "sdk" as const,
    claudeRuntimeV2Enabled: true,
    claudeRuntimeIdleTtlMs: 300_000,
    claudeRuntimeMaxEntries: 16,
    claudeRuntimeTurnTimeoutMs: 1_800_000,
    internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
    codexHome: null,
    rolloutRoot: null,
  };
}

function inertConnection(): RunnerIpcConnection {
  return {
    onFrame: vi.fn(),
    onFailure: vi.fn(),
    close: vi.fn(),
    request: vi.fn(async (frame: { commandId: string }) =>
      runnerCommandResultFrame(frame.commandId, { status: "ok" })),
    send: vi.fn(async () => true),
  } as unknown as RunnerIpcConnection;
}

function inertEngine(): EnginePort {
  return {
    backendId: "codex",
    workspaceDir: "/tmp/codex-h",
    async *execute() {},
    async interrupt() { return true; },
    async close() {},
  };
}

function emptyStore(streamId: string) {
  return {
    streamId,
    ackedSeq: 0,
    onAppend: () => () => {},
    async readBatch() { return null; },
    async acknowledge() {},
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

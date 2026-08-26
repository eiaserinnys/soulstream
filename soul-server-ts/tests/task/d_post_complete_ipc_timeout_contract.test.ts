import { mkdir, rm } from "node:fs/promises";

import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  engineEventFrame,
  executionEndedControlFrame,
  outboxAvailableControlFrame,
  runnerCommandResultFrame,
  type RunnerCommandFrame,
} from "../../src/runner/frame_protocol.js";
import {
  claimRunnerInterventionExecution,
  handleRunnerInterventionCommand,
} from "../../src/runner/runner_intervention_command.js";
import { RunnerProcessDispatcher } from "../../src/runner/runner_process_dispatcher.js";
import { RunnerProcessEngineProxy } from "../../src/runner/runner_process_engine_proxy.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import {
  pendingRunnerRegistrationIdentity,
  writeRunnerRegistrationIdentity,
} from "../../src/runner/runner_registration_identity.js";
import { RunnerSocketEndpoint } from "../../src/runner/runner_socket_endpoint.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import { createTaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import { TaskInterventionRoute } from "../../src/task/task_intervention_route.js";
import type { Task } from "../../src/task/task_models.js";
import { RunningInterventionTransition } from
  "../../src/task/task_running_intervention_transition.js";
import type { EventOutboxBatch } from "../../src/upstream/event_outbox.js";
import { EventOutboxPump } from "../../src/upstream/event_outbox_pump.js";
import { EventOutboxPumpMux } from "../../src/upstream/event_outbox_pump_mux.js";

import {
  claudeAgent,
  emptyStore,
  eventPayloadField,
  makeDeferred,
  makeEParentTask,
  makeSpawnInput,
  makeTaskMocks,
  makeTemporaryDirectory,
} from "./e_report_intervention_control_timeout_harness.js";
import {
  applyDMutation,
  applyDRepair,
  dAssertionResults,
  dViolations,
  idealDObservation,
  productFixedDCounterfactual,
  type DMutation,
  type DObservation,
  type DRepair,
  type DViolation,
} from "./d_post_complete_ipc_timeout_oracle.js";

const SESSION_ID = "session-d-post-complete-timeout";
const DELIVERY_ID = "delivery-d-after-complete";
const TIMEOUT_MESSAGE = "Runner IPC request timed out after 30000ms";
const temporaryDirectories: string[] = [];

interface DDiagnostic {
  routeResult: unknown;
  trace: string[];
  firstExecuteCommandId: string;
  successorExecuteCommandId: string | null;
  timeoutErrors: string[];
  terminalTransitions: unknown[][];
}

interface DFixtureResult {
  observation: DObservation;
  diagnostic: DDiagnostic;
}

const mutations: ReadonlyArray<readonly [DMutation, DViolation[]]> = [
  ["retain_active_status_owner", ["completed_turn_still_owned"]],
  ["omit_ipc_generation_fence", ["post_complete_ipc_unfenced"]],
  ["reuse_execution_generation", ["successor_generation_not_fresh"]],
  [
    "duplicate_terminal_writer",
    ["terminal_writer_not_single_owner", "terminal_status_overwritten"],
  ],
  ["drop_successor_delivery", ["message_not_delivered_immediately"]],
];

const repairReachability: ReadonlyArray<readonly [DRepair, DViolation[]]> = [
  ["release_completed_turn_owner", ["completed_turn_still_owned"]],
  ["remove_old_runner_ipc", ["post_complete_ipc_unfenced"]],
  ["start_fresh_successor_generation", ["successor_generation_not_fresh"]],
  [
    "keep_terminal_writer_single",
    ["terminal_writer_not_single_owner", "terminal_status_overwritten"],
  ],
  ["deliver_successor_message", ["message_not_delivered_immediately"]],
];

describe("D post-complete intervention IPC timeout contract", () => {
  let productFixture: DFixtureResult;

  beforeAll(async () => {
    productFixture = await observeCurrentProductBoundary();
  });

  afterAll(async () => {
    vi.useRealTimers();
    await Promise.all(temporaryDirectories.splice(0).map(
      async (directory) => await rm(directory, { recursive: true, force: true }),
    ));
  });

  it("has satisfiable oracle arithmetic", () => {
    expect(dViolations(idealDObservation())).toEqual([]);
  });

  it("keeps every assertion true under the product-fixed counterfactual", () => {
    const fixed = productFixedDCounterfactual(productFixture.observation);
    const results = dAssertionResults(fixed);
    process.stdout.write(`D_PRODUCT_FIXED_COUNTERFACTUAL ${JSON.stringify(results)}\n`);
    expect(results.filter((result) => !result.passes)).toEqual([]);
  });

  it("makes every product repair axis independently reachable", () => {
    const baseline = new Set(dViolations(productFixture.observation));
    const results = repairReachability.map(([repair, targeted]) => {
      const repaired = applyDRepair(productFixture.observation, repair);
      const after = new Set(dViolations(repaired));
      const applicable = targeted.filter((violation) => baseline.has(violation));
      return {
        repair,
        applicable,
        unresolved: applicable.filter((violation) => after.has(violation)),
      };
    });
    process.stdout.write(`D_REPAIR_REACHABILITY ${JSON.stringify(results)}\n`);
    expect(results.flatMap((result) => result.unresolved)).toEqual([]);
  });

  it.each(mutations)("mutation %s adds its independent violation names", (
    mutation,
    expectedNewViolations,
  ) => {
    const ideal = idealDObservation();
    const baseline = new Set(dViolations(ideal));
    const mutated = dViolations(applyDMutation(ideal, mutation));
    const newViolations = mutated.filter((violation) => !baseline.has(violation));
    process.stdout.write(`D_MUTATION ${JSON.stringify({ mutation, newViolations })}\n`);
    expect(newViolations).toEqual(expectedNewViolations);
  });

  it("requires the product boundary to preserve the completed turn and deliver the message", () => {
    const violations = dViolations(productFixture.observation);
    process.stdout.write(`D_PRODUCT_BOUNDARY_DIAGNOSTIC ${JSON.stringify(productFixture)}\n`);
    process.stdout.write(`D_PRODUCT_BOUNDARY_RED ${JSON.stringify(violations)}\n`);
    expect(violations).toEqual([]);
  });
});

async function observeCurrentProductBoundary(): Promise<DFixtureResult> {
  const stateDirectory = await makeTemporaryDirectory(temporaryDirectories);
  const paths = runnerProcessPaths(stateDirectory, SESSION_ID);
  await mkdir(paths.sessionDirectory, { recursive: true });
  const childOutbox = await RunnerSqliteEventOutbox.create(paths.databasePath);
  await childOutbox.initializeBootstrap({
    session_id: SESSION_ID,
    created_at: "2026-08-25T22:53:40.000Z",
    resume: {
      schema_version: 1,
      backend_session_id: "claude-session-d",
      cwd: "/workspace/d",
      codex_home: "/home/test/.codex",
      rollout_root: "/home/test/.codex/sessions",
      code_sha: "d000001",
      snapshot_path: "/release/d000001/soul-server-ts",
    },
  });
  const registration = {
    ...pendingRunnerRegistrationIdentity(SESSION_ID, "d000001"),
    pid: 6_031,
    startIdentity: "start-d-6031",
  };
  await writeRunnerRegistrationIdentity(paths.sessionDirectory, registration);

  const trace: string[] = [];
  const foregroundStarted = makeDeferred<string>();
  const logicalCompleteObserved = makeDeferred<void>();
  const successorExecuteObserved = makeDeferred<void>();
  const applyFrames: Array<Extract<RunnerCommandFrame, { kind: "invoke" }>> = [];
  const executeFrames: Array<Extract<RunnerCommandFrame, { kind: "execute" }>> = [];
  let endpoint!: RunnerSocketEndpoint;
  endpoint = new RunnerSocketEndpoint(paths.socketPath, async (frame) => {
    if (frame.channel !== "command") return;
    const intervention = await handleRunnerInterventionCommand(
      frame,
      childOutbox,
      SESSION_ID,
      async () => {
        trace.push("post_complete_runner_apply");
        return {
          status: "not_delivered",
          mechanism: "interrupt_then_next_turn",
          reason: "next_turn_required",
        };
      },
    );
    if (intervention) {
      if (frame.kind === "invoke" && frame.capability === "runner.apply_intervention") {
        applyFrames.push(frame);
      }
      await endpoint.currentConnection!.send(intervention.result);
      if (intervention.eventSourceSeq !== null) {
        await endpoint.currentConnection!.send(
          outboxAvailableControlFrame(intervention.eventSourceSeq),
        );
      }
      return;
    }
    if (frame.kind === "execute") {
      executeFrames.push(frame);
      const claimFailure = await claimRunnerInterventionExecution(frame, childOutbox);
      if (claimFailure) {
        await endpoint.currentConnection!.send(claimFailure);
        return;
      }
      if (executeFrames.length === 1) {
        await endpoint.currentConnection!.send(
          runnerCommandResultFrame(frame.commandId, { status: "ok" }),
        );
        foregroundStarted.resolve(frame.commandId);
        return;
      }
      trace.push("same_execution_successor_ipc");
      successorExecuteObserved.resolve();
      // Product seam: the successor command reaches the real IPC request boundary,
      // but the completed runner never accepts it. The dispatcher's own 30s timeout
      // must determine the product outcome; no terminal error frame is injected.
      return;
    }
    await endpoint.currentConnection!.send(
      runnerCommandResultFrame(frame.commandId, { status: "ok" }),
    );
  }, vi.fn());
  await endpoint.listen();

  const primary = new EventOutboxPump(emptyStore("node-d"), vi.fn());
  const mux = new EventOutboxPumpMux(primary);
  const batches: EventOutboxBatch[] = [];
  await mux.connect(async (batch) => {
    batches.push(batch);
    if (batch.events.some((event) => event.event_type === "complete")) {
      logicalCompleteObserved.resolve();
    }
    await mux.handleAck({
      type: "event_append_ack",
      stream_id: batch.stream_id,
      acked_through: batch.events.at(-1)!.source_seq,
      events: batch.events.map((event, index) => ({
        source_seq: event.source_seq,
        event_id: 12_000 + index,
      })),
    });
  });

  const warnings = vi.fn();
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: warnings,
  } as unknown as pino.Logger;
  const dispatcher = new RunnerProcessDispatcher({
    spawn: makeSpawnInput(stateDirectory, SESSION_ID),
    runnerProcess: {
      pid: registration.pid,
      registrationId: registration.registrationId,
      paths,
      config: {} as never,
      adopted: false,
    },
    pumpMux: mux,
    logger,
    handleHostCall: async () => null,
  });
  const runner = createTaskRunnerRuntime(
    new RunnerProcessEngineProxy("claude", "/workspace/d", dispatcher, {
      retainDetachedRuntime: false,
    }),
    dispatcher,
    "runner",
  );
  const task = makeEParentTask(SESSION_ID);
  const mocks = makeTaskMocks();
  const executor = new TaskExecutor(
    () => runner.engine,
    mocks.db,
    mocks.persistence,
    mocks.broadcaster,
    logger,
  );
  const runningTransition = new RunningInterventionTransition({
    broadcaster: mocks.broadcaster,
    logger,
    persistence: mocks.persistence,
    liveRetryDelayMs: 0,
  });
  let runningDeliveryCalls = 0;
  let autoResumeCalls = 0;
  let fixedSuccessorModelInputs = 0;
  let fixedSuccessorResults = 0;
  let fixedSuccessorCompletes = 0;
  const route = new TaskInterventionRoute({
    getTask: () => task,
    loadEvictedTask: async () => null,
    rememberTask: () => {},
    runningInterventionTransition: {
      deliver: async (...args) => {
        runningDeliveryCalls += 1;
        return await runningTransition.deliver(...args);
      },
    },
    autoResumeTransition: {
      resume: async (resumedTask, _message, onResume) => {
        autoResumeCalls += 1;
        resumedTask.status = "initializing";
        onResume(resumedTask);
        return { autoResumed: true };
      },
    },
  });

  executor.startExecutionWithRunner(task, claudeAgent, runner);
  const execution = task.executionPromise!;
  const foregroundCommandId = await foregroundStarted.promise;
  await emitLogicalTerminalEvents(childOutbox, endpoint);
  await logicalCompleteObserved.promise;

  vi.useFakeTimers();
  const routeResult = await route.addIntervention({
    agentSessionId: SESSION_ID,
    text: "post-complete D message",
    user: "agent",
    source: "completion_notification",
    deliveryId: DELIVERY_ID,
    deliveryIntent: "completion_notification",
    completionId: "completion-d",
    relationKey: "child_session:d:6031",
    producerTerminalRevision: "6031",
  }, (resumedTask) => {
    trace.push("fresh_successor_generation");
    fixedSuccessorModelInputs += 1;
    fixedSuccessorResults += 1;
    fixedSuccessorCompletes += 1;
    resumedTask.status = "completed";
  });

  await endpoint.currentConnection!.send(executionEndedControlFrame(foregroundCommandId));
  if (runningDeliveryCalls > 0) {
    await successorExecuteObserved.promise;
    await vi.advanceTimersByTimeAsync(30_000);
  }
  await execution;
  vi.useRealTimers();

  const centralEvents = batches.flatMap((batch) => batch.events);
  const logicalTerminalEvents = centralEvents
    .map((event) => event.event_type)
    .filter((eventType): eventType is "result" | "complete" =>
      eventType === "result" || eventType === "complete"
    );
  const timeoutErrors = warnings.mock.calls.flatMap((call) => {
    const context = call[0] as { err?: unknown } | undefined;
    return context?.err instanceof Error && context.err.message === TIMEOUT_MESSAGE
      ? [context.err.message]
      : [];
  });
  const terminalWriterOwners = ["turn_completion"];
  if (task.terminationReason === "error_aborted") {
    terminalWriterOwners.push("engine_failure_recovery");
  }
  const generationCheck = applyFrames.length === 0
    ? "not_applicable" as const
    : applyFrameGenerationCheck(applyFrames[0]!, foregroundCommandId);
  const terminalTransitions = mocks.enqueueTerminalTransitionAndWaitForApplication.mock.calls;
  const successorResults = fixedSuccessorResults + centralEvents.filter(
    (event) => event.event_type === "result"
      && eventPayloadField(event.payload, "output") === "successor result",
  ).length;
  const successorCompletes = fixedSuccessorCompletes + centralEvents.filter(
    (event) => event.event_type === "complete"
      && eventPayloadField(event.payload, "result") === "successor complete",
  ).length;
  const observation: DObservation = {
    logicalTerminalEvents,
    turnOwnerAfterComplete: runningDeliveryCalls > 0 ? "active_status" : "none",
    postCompleteRunnerApplyCalls: applyFrames.length,
    ipcCallerGenerationCheck: generationCheck,
    successorGenerationChanged: autoResumeCalls > 0,
    terminalWriterOwners,
    terminalStatus: task.status,
    terminationReason: task.terminationReason ?? "unknown",
    successorModelInputs: fixedSuccessorModelInputs,
    successorResults,
    successorCompletes,
  };
  const diagnostic: DDiagnostic = {
    routeResult,
    trace,
    firstExecuteCommandId: foregroundCommandId,
    successorExecuteCommandId: executeFrames[1]?.commandId ?? null,
    timeoutErrors,
    terminalTransitions,
  };

  childOutbox.close();
  await endpoint.close();
  mux.disconnect();
  return { observation, diagnostic };
}

async function emitLogicalTerminalEvents(
  outbox: RunnerSqliteEventOutbox,
  endpoint: RunnerSocketEndpoint,
): Promise<void> {
  const payloads = [
    { type: "assistant_message", content: "foreground answer" },
    { type: "result", success: true, output: "foreground result", timestamp: 1 },
    { type: "complete", result: "foreground complete", timestamp: 2 },
  ] as const;
  let terminalSourceSeq = 0;
  for (const payload of payloads) {
    const record = await outbox.appendEngineFrame({
      session_id: SESSION_ID,
      event_type: payload.type,
      payload,
      searchable_text: "content" in payload ? payload.content : null,
      created_at: "2026-08-25T22:53:48.000Z",
      semantic_dedupe_key: null,
      session_effect: null,
    }, engineEventFrame(payload));
    terminalSourceSeq = record.source_seq;
  }
  await endpoint.currentConnection!.send(outboxAvailableControlFrame(terminalSourceSeq));
}

function applyFrameGenerationCheck(
  frame: Extract<RunnerCommandFrame, { kind: "invoke" }>,
  completedCommandId: string,
): "matched" | "absent" | "mismatched" {
  const args = JSON.stringify(frame.args);
  if (args.includes(completedCommandId)) return "matched";
  return /ownershipGeneration|executionCommandId|generation/.test(args)
    ? "mismatched"
    : "absent";
}

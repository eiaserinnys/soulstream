import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
} from
  "../../src/runner/runner_intervention_command.js";
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
import { TaskCompletionNotifier } from "../../src/task/completion_notifier.js";
import {
  buildDeliveryInputUuid,
  buildDeterministicDeliveryIdentity,
} from "../../src/task/delivery_identity.js";
import type { AddInterventionParams, TaskManager } from "../../src/task/task_manager.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import { RunningInterventionTransition } from
  "../../src/task/task_running_intervention_transition.js";
import type { EventOutboxBatch } from "../../src/upstream/event_outbox.js";
import { EventOutboxPump } from "../../src/upstream/event_outbox_pump.js";
import { EventOutboxPumpMux } from "../../src/upstream/event_outbox_pump_mux.js";
import {
  claudeAgent,
  emptyStore,
  makeAgentRegistry,
  makeCapturingLogger,
  makeCompletionRepository,
  makeSpawnInput,
  makeTaskMocks,
} from "./e_report_intervention_control_timeout_harness.js";
import {
  applyOracleMutation,
  contractViolations,
  idealObservation,
  type EObservation,
  type ProducerObservation,
  readOracleMutation,
} from "./e_report_intervention_control_timeout_oracle.js";
const SESSION_ID = "parent-e-running";
const CHILD_SESSION_ID = "child-e-fresh";
const TERMINAL_REVISION = "4242";
const REPORT_IDENTITY = `child_session:${CHILD_SESSION_ID}:${TERMINAL_REVISION}`;
const REPORT_TEXT =
  `✅ 에이전트 세션 완료 (ID: \`${CHILD_SESSION_ID}\`)\n\nfresh E report`;
const DELIVERY_IDENTITY = buildDeterministicDeliveryIdentity({
  targetSessionId: SESSION_ID,
  relationKey: REPORT_IDENTITY,
  intent: "completion_notification",
});
const ORACLE_MUTATION_ENV = "SOULSTREAM_E_ORACLE_MUTATION";
const REQUESTED_ORACLE_MUTATION = readOracleMutation(process.env[ORACLE_MUTATION_ENV]);
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  delete process.env[ORACLE_MUTATION_ENV];
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("E report intervention control-timeout contract", () => {
  it("is satisfiable when every E boundary has ideal evidence", () => {
    expect(contractViolations(idealObservation({
      reportIdentity: REPORT_IDENTITY,
      deliveryId: DELIVERY_IDENTITY.deliveryId,
    }))).toEqual([]);
  });

  it("keeps the running parent alive through the queued next turn", async () => {
    const mutation = REQUESTED_ORACLE_MUTATION;
    const stateDirectory = await temporaryDirectory();
    const paths = runnerProcessPaths(stateDirectory, SESSION_ID);
    await mkdir(paths.sessionDirectory, { recursive: true });
    const childOutbox = await RunnerSqliteEventOutbox.create(paths.databasePath);
    await childOutbox.initializeBootstrap({
      session_id: SESSION_ID,
      created_at: "2026-08-25T00:00:00.000Z",
      resume: {
        schema_version: 1,
        backend_session_id: "claude-parent-e",
        cwd: "/workspace/e",
        codex_home: "/home/test/.codex",
        rollout_root: "/home/test/.codex/sessions",
        code_sha: "7f9b9e8d",
        snapshot_path: "/release/7f9b9e8d/soul-server-ts",
      },
    });
    const registration = {
      ...pendingRunnerRegistrationIdentity(SESSION_ID, "7f9b9e8d"),
      pid: 4242,
      startIdentity: "start-e-4242",
    };
    await writeRunnerRegistrationIdentity(paths.sessionDirectory, registration);

    const foregroundRunning = deferred<string>();
    const runnerInterruptObserved = deferred<void>();
    const releaseControlReply = deferred<void>();
    const lateControlReplySent = deferred<void>();
    const trace: string[] = [];
    const stageAttempts: RunnerCommandFrame[] = [];
    const centralEventTypes: string[] = [];
    const executeFrames: Array<Extract<RunnerCommandFrame, { kind: "execute" }>> = [];
    const lateControlVerdicts: unknown[] = [];
    let applyRequests = 0;
    let endpoint!: RunnerSocketEndpoint;
    endpoint = new RunnerSocketEndpoint(paths.socketPath, async (frame) => {
      if (frame.channel !== "command") return;
      const intervention = await handleRunnerInterventionCommand(
        frame,
        childOutbox,
        SESSION_ID,
        async () => {
          applyRequests += 1;
          trace.push("runner.apply_intervention");
          runnerInterruptObserved.resolve();
          await releaseControlReply.promise;
          const verdict = {
            status: "not_delivered",
            mechanism: "interrupt_then_next_turn",
            reason: "next_turn_required",
          } as const;
          lateControlVerdicts.push(verdict);
          return verdict;
        },
      );
      if (frame.kind === "stage_intervention") stageAttempts.push(frame);
      if (intervention) {
        await endpoint.currentConnection!.send(intervention.result);
        if (intervention.eventSourceSeq !== null) {
          await endpoint.currentConnection!.send(
            outboxAvailableControlFrame(intervention.eventSourceSeq),
          );
        }
        if (
          frame.kind === "invoke"
          && frame.capability === "runner.apply_intervention"
        ) {
          trace.push("late_control_reply");
          lateControlReplySent.resolve();
        }
        return;
      }
      const interventionClaimFailure = frame.kind === "execute"
        ? await claimRunnerInterventionExecution(frame, childOutbox)
        : null;
      if (interventionClaimFailure) {
        await endpoint.currentConnection!.send(interventionClaimFailure);
        return;
      }
      if (frame.kind === "execute") executeFrames.push(frame);
      if (
        frame.kind === "execute"
        && executeFrames.length > 1
        && !provesExpectedNextTurn(frame, DELIVERY_IDENTITY.deliveryId)
      ) {
        await endpoint.currentConnection!.send(runnerCommandResultFrame(
          frame.commandId,
          {
            status: "error",
            error: {
              code: "unexpected_next_turn_identity",
              message: "second execute did not carry the fresh E report identity",
            },
          },
        ));
        return;
      }
      await endpoint.currentConnection!.send(
        runnerCommandResultFrame(frame.commandId, { status: "ok" }),
      );
      if (frame.kind === "execute") {
        if (executeFrames.length === 1) {
          trace.push("foreground_running");
          foregroundRunning.resolve(frame.commandId);
          return;
        }
        trace.push("next_turn_execute");
        await emitSuccessfulNextTurn(childOutbox, endpoint, frame.commandId);
      }
    }, vi.fn());
    await endpoint.listen();

    const primary = new EventOutboxPump(emptyStore("node-e"), vi.fn());
    const mux = new EventOutboxPumpMux(primary);
    const batches: EventOutboxBatch[] = [];
    await mux.connect(async (batch) => {
      batches.push(batch);
      centralEventTypes.push(...batch.events.map((event) => event.event_type));
      if (batch.events.some((event) => event.event_type === "intervention_sent")) {
        trace.push("intervention_sent");
      }
      await mux.handleAck({
        type: "event_append_ack",
        stream_id: batch.stream_id,
        acked_through: batch.events.at(-1)!.source_seq,
        events: batch.events.map((event, index) => ({
          source_seq: event.source_seq,
          event_id: 8_000 + index,
        })),
      });
    });

    const logger = makeCapturingLogger();
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
      logger: logger.value,
      handleHostCall: async () => null,
    });
    const runner = createTaskRunnerRuntime(
      new RunnerProcessEngineProxy("claude", "/workspace/e", dispatcher, {
        retainDetachedRuntime: false,
      }),
      dispatcher,
      "runner",
    );
    const parent = makeParentTask();
    const mocks = makeTaskMocks();
    const repository = makeCompletionRepository();
    const executor = new TaskExecutor(
      () => runner.engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      logger.value,
      undefined,
      undefined,
      undefined,
      undefined,
      repository.consumptionRecorder as never,
    );
    const transition = new RunningInterventionTransition({
      broadcaster: mocks.broadcaster,
      logger: logger.value,
      persistence: mocks.persistence,
      liveRetryDelayMs: 0,
    });

    executor.startExecutionWithRunner(parent, claudeAgent, runner);
    const execution = parent.executionPromise!;
    const foregroundCommandId = await foregroundRunning.promise;
    const statusAtForegroundBarrier = parent.status;
    const resultOrCompleteBeforeCut = batches.flatMap((batch) => batch.events).filter(
      (event) => event.event_type === "result" || event.event_type === "complete",
    ).length;

    vi.useFakeTimers();
    const identity = DELIVERY_IDENTITY;
    const producers: ProducerObservation[] = [{
      kind: "explicit_report",
      reportIdentity: REPORT_IDENTITY,
      deliveryId: identity.deliveryId,
    }];
    const explicitReport: InterventionMessage = {
      text: REPORT_TEXT,
      user: "agent",
      source: "explicit_report",
      deliveryId: identity.deliveryId,
      deliveryIntent: "human_live_steer",
      completionId: identity.completionId,
      relationKey: REPORT_IDENTITY,
      producerTerminalRevision: TERMINAL_REVISION,
      runnerInterventionId: identity.deliveryId,
    };
    const explicitDelivery = transition.deliver(parent, explicitReport);
    await runnerInterruptObserved.promise;

    const taskManager = {
      addIntervention: vi.fn(async (params: AddInterventionParams) => {
        producers.push({
          kind: "automatic_completion",
          reportIdentity: params.relationKey!,
          deliveryId: params.deliveryId!,
        });
        const { agentSessionId: _target, ...message } = params;
        return await transition.queueOnly(parent, message, { publishEvent: false });
      }),
    } as unknown as TaskManager;
    const notifier = new TaskCompletionNotifier(
      "eiaserinnys",
      taskManager,
      makeAgentRegistry(),
      vi.fn(),
      logger.value,
      undefined,
      undefined,
      { getSession: vi.fn().mockResolvedValue({ node_id: "eiaserinnys" }) } as never,
      true,
      repository.value as never,
    );
    await notifier.notify(makeCompletedChild());

    await vi.advanceTimersByTimeAsync(30_000);
    const apiResult = await explicitDelivery;
    trace.push("control_timeout");
    const reservedDeliveryIds = parent.interventionQueue
      .map((message) => message.deliveryId)
      .filter((deliveryId): deliveryId is string => deliveryId !== undefined);
    releaseControlReply.resolve();
    await lateControlReplySent.promise;

    // Causal-seam fixture: the IPC timeout cannot itself terminate the foreground.
    // This separately injects the child terminal error observed in the live failure.
    // Therefore this RED assumes their co-occurrence; it does not prove timeout -> cut.
    await endpoint.currentConnection!.send(executionEndedControlFrame(
      foregroundCommandId,
      {
        code: "execution_failed",
        message: "aborted_streaming: read ECONNRESET",
      },
    ));
    trace.push("foreground_execution_ended_error");
    await execution;

    const timeoutErrors = logger.errors().filter(
      (message) => message === "Runner IPC request timed out after 30000ms",
    );
    const nextTurnFrames = executeFrames.slice(1);
    const provenNextTurnFrames = nextTurnFrames.filter(
      (frame) => provesExpectedNextTurn(frame, identity.deliveryId),
    );
    const observation: EObservation = {
      controlTimeoutErrors: timeoutErrors,
      terminalStatus: parent.status,
      terminalError: parent.error ?? null,
      nextTurnReservations: reservedDeliveryIds.filter(
        (deliveryId) => deliveryId === identity.deliveryId,
      ).length,
      nextTurnProofs: provenNextTurnFrames.length,
      nextTurnActivations: repository.turnStartedDeliveryIds().filter(
        (deliveryId) => deliveryId === identity.deliveryId,
      ).length,
      nextTurnModelInputs: nextTurnFrames.length,
      nextTurnCompletes: centralEventTypes.filter(
        (eventType) => eventType === "complete",
      ).length,
      reportProducers: producers,
      durableDeliveryIds: repository.durableDeliveryIds(),
      consumedDeliveryIds: repository.consumedDeliveryIds(),
    };

    // Harness gate: these are evidence prerequisites, not the desired GREEN oracle.
    expect(statusAtForegroundBarrier).toBe("running");
    expect(resultOrCompleteBeforeCut).toBe(0);
    expect(centralEventTypes).toContain("intervention_sent");
    expect(centralEventTypes).not.toContain("user_message");
    expect(applyRequests).toBe(1);
    expect(trace.indexOf("intervention_sent")).toBeLessThan(
      trace.indexOf("runner.apply_intervention"),
    );
    expect(producers).toHaveLength(2);
    expect(new Set(producers.map((producer) => producer.reportIdentity))).toEqual(
      new Set([REPORT_IDENTITY]),
    );
    expect(new Set(producers.map((producer) => producer.deliveryId))).toEqual(
      new Set([identity.deliveryId]),
    );
    expect(apiResult).toEqual({
      delivered: false,
      queued: true,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "verdict_unknown",
    });
    expect(lateControlVerdicts).toEqual([{
      status: "not_delivered",
      mechanism: "interrupt_then_next_turn",
      reason: "next_turn_required",
    }]);
    expect(stageAttempts.length).toBeGreaterThan(0);
    expect(stageAttempts.every((frame) =>
      frame.kind === "stage_intervention"
      && frame.interventionId === identity.deliveryId
    )).toBe(true);

    const observedByOracle = applyOracleMutation(observation, mutation);
    const violations = contractViolations(observedByOracle);
    childOutbox.close();
    await endpoint.close();
    mux.disconnect();
    vi.useRealTimers();
    expect(
      violations,
      `E RED violations (${mutation ?? "baseline"}): ${JSON.stringify(violations)}\n`
        + `${JSON.stringify(observedByOracle, null, 2)}`,
    ).toEqual([]);
  });
});

function provesExpectedNextTurn(
  frame: Extract<RunnerCommandFrame, { kind: "execute" }>,
  deliveryId: string,
): boolean {
  return frame.params.runnerInterventionId === deliveryId
    && frame.params.inputUuid === buildDeliveryInputUuid(deliveryId)
    && frame.params.turnOrigin?.kind === "completion_notification"
    && frame.params.turnOrigin.id === deliveryId
    && frame.params.prompt.includes("fresh E report");
}

async function emitSuccessfulNextTurn(
  outbox: RunnerSqliteEventOutbox,
  endpoint: RunnerSocketEndpoint,
  commandId: string,
): Promise<void> {
  const assistant = { type: "assistant_message", content: "next turn consumed E report" };
  const complete = { type: "complete", result: "next turn completed", timestamp: 2 };
  await outbox.appendEngineFrame({
    session_id: SESSION_ID,
    event_type: assistant.type,
    payload: assistant,
    searchable_text: assistant.content,
    created_at: "2026-08-25T00:00:02.000Z",
    semantic_dedupe_key: null,
    session_effect: null,
  }, engineEventFrame(assistant));
  const terminal = await outbox.appendEngineFrame({
    session_id: SESSION_ID,
    event_type: complete.type,
    payload: complete,
    searchable_text: complete.result,
    created_at: "2026-08-25T00:00:03.000Z",
    semantic_dedupe_key: null,
    session_effect: null,
  }, engineEventFrame(complete));
  await endpoint.currentConnection!.send(outboxAvailableControlFrame(terminal.source_seq));
  await endpoint.currentConnection!.send(executionEndedControlFrame(commandId));
}

function makeParentTask(): Task {
  return {
    agentSessionId: SESSION_ID,
    prompt: "parent foreground turn",
    status: "running",
    profileId: claudeAgent.id,
    modelPresetBackend: "claude",
    createdAt: new Date("2026-08-25T00:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

function makeCompletedChild(): Task {
  return {
    agentSessionId: CHILD_SESSION_ID,
    prompt: "child work",
    status: "completed",
    profileId: claudeAgent.id,
    callerSessionId: SESSION_ID,
    createdAt: new Date("2026-08-25T00:00:00.000Z"),
    completedAt: new Date("2026-08-25T00:00:01.000Z"),
    lastEventId: Number(TERMINAL_REVISION),
    terminalEventId: Number(TERMINAL_REVISION),
    lastReadEventId: 0,
    lastAssistantText: "fresh E report",
    interventionQueue: [],
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "soulstream-e-report-red-"));
  directories.push(directory);
  return directory;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// Claude-only: Codex turn/steer same-turn delivery belongs to a separate contract.
import { mkdir, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
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
import { TaskCompletionNotifier } from "../../src/task/completion_notifier.js";
import { buildDeterministicDeliveryIdentity } from "../../src/task/delivery_identity.js";
import type { AddInterventionParams, TaskManager } from "../../src/task/task_manager.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { InterventionMessage } from "../../src/task/task_models.js";
import { RunningInterventionTransition } from
  "../../src/task/task_running_intervention_transition.js";
import type { EventOutboxBatch } from "../../src/upstream/event_outbox.js";
import { EventOutboxPump } from "../../src/upstream/event_outbox_pump.js";
import { EventOutboxPumpMux } from "../../src/upstream/event_outbox_pump_mux.js";

import {
  claudeAgent,
  emptyStore,
  emitSuccessfulNextTurn,
  emitSuccessfulTurn,
  eventPayloadField,
  makeAgentRegistry,
  makeCapturingLogger,
  makeCompletionRepository,
  makeDeferred,
  makeECompletedChild,
  makeEParentTask,
  makeSpawnInput,
  makeTaskMocks,
  makeTemporaryDirectory,
  provesExpectedNextTurn,
} from "./e_report_intervention_control_timeout_harness.js";
import {
  applyClaudeInterruptionMutation,
  claudeInterruptionViolations,
  type ClaudeInterruptionObservation,
  idealClaudeInterruptionObservation,
  readOracleMutation,
} from "./e_report_intervention_control_timeout_oracle.js";

const SESSION_ID = "parent-e-running";
const CHILD_SESSION_ID = "child-e-order-fresh";
const TERMINAL_REVISION = "4343";
const REPORT_IDENTITY = `child_session:${CHILD_SESSION_ID}:${TERMINAL_REVISION}`;
const REPORT_TEXT =
  `✅ 에이전트 세션 완료 (ID: \`${CHILD_SESSION_ID}\`)\n\nfresh E report`;
const DELIVERY_IDENTITY = buildDeterministicDeliveryIdentity({
  targetSessionId: SESSION_ID,
  relationKey: REPORT_IDENTITY,
  intent: "completion_notification",
});
const MUTATION = readOracleMutation(process.env.SOULSTREAM_E_ORACLE_MUTATION);
// Central DB evidence: session 62118213-1d08-4bde-b93f-84281913b55b; #1 is event 284.
const LIVE_PASSIVE_WAIT_EVENTS = [
  { id: 282, type: "assistant_message", tUtc: "2026-08-25T05:59:32.044Z" },
  {
    id: 283,
    type: "claude_runtime_transcript_mirror_error",
    tUtc: "2026-08-25T06:00:20.582Z",
    error: "Runner host request timed out after 30000ms",
  },
  {
    id: 284,
    type: "intervention_sent",
    tUtc: "2026-08-25T06:01:05.307Z",
    evidenceRole: "primary",
    identity: "live-event-284-primary",
  },
  {
    id: 285,
    type: "intervention_sent",
    tUtc: "2026-08-25T06:01:30.229Z",
    evidenceRole: "queue_order_only",
    identity: "live-event-285-secondary",
  },
  {
    id: 286,
    type: "claude_runtime_transcript_mirror_error",
    tUtc: "2026-08-25T06:01:54.540Z",
    error: "Runner host request timed out after 30000ms",
  },
  { id: 287, type: "result", tUtc: "2026-08-25T06:01:56.501Z" },
  { id: 289, type: "complete", tUtc: "2026-08-25T06:01:57.011Z" },
  {
    id: 291,
    type: "claude_runtime_hook_event:UserPromptSubmit",
    tUtc: "2026-08-25T06:01:59.958Z",
  },
  { id: 294, type: "assistant_message", tUtc: "2026-08-25T06:02:27.317Z" },
] as const;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("E Claude intervention event-order contract", () => {
  it("anchors passive-wait mutation to live events 282 through 294", () => {
    const byId = new Map(LIVE_PASSIVE_WAIT_EVENTS.map((event) => [event.id, event]));
    const admitted = Date.parse(byId.get(284)!.tUtc);
    const secondaryAdmission = Date.parse(byId.get(285)!.tUtc);
    const oldComplete = Date.parse(byId.get(289)!.tUtc);
    const modelInput = Date.parse(byId.get(291)!.tUtc);

    expect(oldComplete - admitted).toBe(51_704);
    expect(modelInput - oldComplete).toBe(2_947);
    expect(oldComplete - secondaryAdmission).toBe(26_782);
    expect(byId.get(284)!.identity).not.toBe(byId.get(285)!.identity);
    expect(byId.get(285)!.evidenceRole).toBe("queue_order_only");
    expect([byId.get(283)!.error, byId.get(286)!.error]).toEqual([
      "Runner host request timed out after 30000ms",
      "Runner host request timed out after 30000ms",
    ]);

    const mutated = applyClaudeInterruptionMutation(
      idealClaudeInterruptionObservation("live-event-284-primary"),
      "passive_wait_until_natural_complete",
    );
    const admissionIndex = mutated.eventOrder.indexOf("interrupt_admission");
    const naturalCompleteIndex = mutated.eventOrder.indexOf("natural_foreground_release");
    const modelInputIndex = mutated.eventOrder.indexOf("next_turn_model_input");
    expect(admissionIndex).toBeLessThan(naturalCompleteIndex);
    expect(naturalCompleteIndex).toBeLessThan(modelInputIndex);
    expect(claudeInterruptionViolations(mutated)).toEqual([
      "passive_wait_until_natural_complete",
    ]);
  });

  it("tripwires Claude next-turn order before the foreground natural-release latch", async () => {
    const stateDirectory = await makeTemporaryDirectory(directories);
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

    const foregroundRunning = makeDeferred<string>();
    const interruptAdmissionObserved = makeDeferred<void>();
    const releaseControlResult = makeDeferred<void>();
    const naturalForegroundRelease = makeDeferred<void>();
    const trace: string[] = [];
    const interruptRequestDeliveryIds: string[] = [];
    const interruptAdmissionDeliveryIds: string[] = [];
    const reservedDeliveryIds: string[] = [];
    const provenDeliveryIds: string[] = [];
    const activatedDeliveryIds: string[] = [];
    const modelInputDeliveryIds: string[] = [];
    const acceptedNextTurnFrames: Array<Extract<RunnerCommandFrame, { kind: "execute" }>> = [];
    let foregroundCommandId: string | undefined;
    let naturalForegroundReleases = 0;
    let executeRequests = 0;
    let endpoint!: RunnerSocketEndpoint;

    endpoint = new RunnerSocketEndpoint(paths.socketPath, async (frame) => {
      if (frame.channel !== "command") return;
      const isApply = frame.kind === "invoke"
        && frame.capability === "runner.apply_intervention";
      if (isApply) {
        const interventionId = frame.args[0];
        if (typeof interventionId === "string") {
          interruptRequestDeliveryIds.push(interventionId);
          trace.push("interrupt_request");
        }
      }
      const intervention = await handleRunnerInterventionCommand(
        frame,
        childOutbox,
        SESSION_ID,
        async () => {
          interruptAdmissionDeliveryIds.push(DELIVERY_IDENTITY.deliveryId);
          trace.push("interrupt_admission");
          interruptAdmissionObserved.resolve();
          await releaseControlResult.promise;
          return {
            status: "not_delivered",
            mechanism: "interrupt_then_next_turn",
            reason: "next_turn_required",
          };
        },
      );
      if (intervention) {
        await endpoint.currentConnection!.send(intervention.result);
        if (intervention.eventSourceSeq !== null) {
          await endpoint.currentConnection!.send(
            outboxAvailableControlFrame(intervention.eventSourceSeq),
          );
        }
        if (isApply) {
          await childOutbox.resolveAmbiguousIntervention(
            DELIVERY_IDENTITY.deliveryId,
            "replayable",
          );
        }
        return;
      }
      if (frame.kind !== "execute") {
        await endpoint.currentConnection!.send(
          runnerCommandResultFrame(frame.commandId, { status: "ok" }),
        );
        return;
      }
      executeRequests += 1;
      const claimFailure = await claimRunnerInterventionExecution(frame, childOutbox);
      if (claimFailure) {
        await endpoint.currentConnection!.send(claimFailure);
        return;
      }
      if (executeRequests === 1) {
        foregroundCommandId = frame.commandId;
        await endpoint.currentConnection!.send(
          runnerCommandResultFrame(frame.commandId, { status: "ok" }),
        );
        trace.push("foreground_running");
        foregroundRunning.resolve(frame.commandId);
        void naturalForegroundRelease.promise.then(async () => {
          naturalForegroundReleases += 1;
          trace.push("natural_foreground_release");
          await emitSuccessfulTurn(
            childOutbox,
            endpoint,
            frame.commandId,
            SESSION_ID,
            "foreground",
          );
        });
        return;
      }
      if (!foregroundCommandId) throw new Error("foreground ownership was never established");
      if (frame.params.runnerInterventionId) {
        reservedDeliveryIds.push(frame.params.runnerInterventionId);
        trace.push("next_turn_reserved");
      }
      if (!provesExpectedNextTurn(frame, DELIVERY_IDENTITY.deliveryId)) {
        await endpoint.currentConnection!.send(runnerCommandResultFrame(
          frame.commandId,
          {
            status: "error",
            error: {
              code: "unexpected_next_turn_identity",
              message: "next execute did not carry the E report identity",
            },
          },
        ));
        return;
      }
      provenDeliveryIds.push(DELIVERY_IDENTITY.deliveryId);
      trace.push("next_turn_proven");
      await endpoint.currentConnection!.send(
        runnerCommandResultFrame(frame.commandId, { status: "ok" }),
      );
      activatedDeliveryIds.push(DELIVERY_IDENTITY.deliveryId);
      trace.push("next_turn_activated");
      acceptedNextTurnFrames.push(frame);
      modelInputDeliveryIds.push(DELIVERY_IDENTITY.deliveryId);
      trace.push("next_turn_model_input");
      await emitSuccessfulNextTurn(
        childOutbox,
        endpoint,
        frame,
        SESSION_ID,
        DELIVERY_IDENTITY.deliveryId,
      );
    }, vi.fn());
    await endpoint.listen();

    const primary = new EventOutboxPump(emptyStore("node-e"), vi.fn());
    const mux = new EventOutboxPumpMux(primary);
    const batches: EventOutboxBatch[] = [];
    await mux.connect(async (batch) => {
      batches.push(batch);
      for (const event of batch.events) {
        if (
          event.event_type === "result"
          && eventPayloadField(event.payload, "output") === "next turn result"
        ) trace.push("next_turn_result");
        if (
          event.event_type === "complete"
          && eventPayloadField(event.payload, "result") === "next turn completed"
        ) trace.push("next_turn_complete");
      }
      await mux.handleAck({
        type: "event_append_ack",
        stream_id: batch.stream_id,
        acked_through: batch.events.at(-1)!.source_seq,
        events: batch.events.map((event, index) => ({
          source_seq: event.source_seq,
          event_id: 9_000 + index,
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
    const parent = makeEParentTask(SESSION_ID);
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
    await foregroundRunning.promise;
    expect(parent.modelPresetBackend).toBe("claude");
    expect(parent.status).toBe("running");

    const taskManager = {
      addIntervention: vi.fn(async (params: AddInterventionParams) => {
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
    const explicitReport: InterventionMessage = {
      text: REPORT_TEXT,
      user: "agent",
      source: "explicit_report",
      deliveryId: DELIVERY_IDENTITY.deliveryId,
      deliveryIntent: "human_live_steer",
      completionId: DELIVERY_IDENTITY.completionId,
      relationKey: REPORT_IDENTITY,
      producerTerminalRevision: TERMINAL_REVISION,
      runnerInterventionId: DELIVERY_IDENTITY.deliveryId,
    };
    const explicitDelivery = transition.deliver(parent, explicitReport);
    const injectedOldExecutionEnd = explicitDelivery.then(async () => {
      if (!foregroundCommandId) throw new Error("foreground command id missing");
      // Test-only child seam: the fixture cannot observe ClaudeAdapter ending the old
      // execution. Inject it after the real host transition applies the control verdict,
      // and exclude it from product evidence in claudeInterruptionViolations().
      trace.push("injected_old_execution_ended");
      await endpoint.currentConnection!.send(
        executionEndedControlFrame(foregroundCommandId),
      );
    });
    await interruptAdmissionObserved.promise;
    await notifier.notify(makeECompletedChild({
      childSessionId: CHILD_SESSION_ID,
      parentSessionId: SESSION_ID,
      terminalRevision: TERMINAL_REVISION,
    }));
    const queuedDeliveryIds = parent.interventionQueue
      .map((message) => message.deliveryId)
      .filter((deliveryId): deliveryId is string => deliveryId !== undefined);
    releaseControlResult.resolve();
    const apiResult = await explicitDelivery;
    await injectedOldExecutionEnd;
    await execution;

    const centralEvents = batches.flatMap((batch) => batch.events);
    const nextTurnResults = centralEvents.filter(
      (event) => event.event_type === "result"
        && eventPayloadField(event.payload, "output") === "next turn result",
    );
    const nextTurnCompletes = centralEvents.filter(
      (event) => event.event_type === "complete"
        && eventPayloadField(event.payload, "result") === "next turn completed",
    );
    const observation: ClaudeInterruptionObservation = {
      backend: "claude",
      deliveryId: DELIVERY_IDENTITY.deliveryId,
      terminalStatus: parent.status,
      terminalError: parent.error ?? null,
      interruptRequestDeliveryIds,
      interruptAdmissionDeliveryIds,
      reservedDeliveryIds,
      provenDeliveryIds,
      activatedDeliveryIds,
      modelInputDeliveryIds,
      resultDeliveryIds: nextTurnResults.map(() => DELIVERY_IDENTITY.deliveryId),
      completeDeliveryIds: nextTurnCompletes.map(() => DELIVERY_IDENTITY.deliveryId),
      durableDeliveryIds: repository.durableDeliveryIds(),
      consumedDeliveryIds: repository.consumedDeliveryIds(),
      naturalForegroundReleases,
      eventOrder: trace,
    };
    const mutated = applyClaudeInterruptionMutation(observation, MUTATION);
    const violations = claudeInterruptionViolations(mutated);
    process.stdout.write(
      `E_ORDER_ORACLE C Claude interruption order (${MUTATION ?? "baseline"}) `
        + `${JSON.stringify(violations)}\n`,
    );

    expect(apiResult).toEqual({
      delivered: false,
      queued: true,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "next_turn_required",
    });
    expect(acceptedNextTurnFrames).toHaveLength(1);
    expect(queuedDeliveryIds).toEqual([DELIVERY_IDENTITY.deliveryId]);
    expect(naturalForegroundReleases).toBe(0);
    childOutbox.close();
    await endpoint.close();
    mux.disconnect();
    expect(
      violations,
      `Claude order violations (${MUTATION ?? "baseline"}): `
        + `${JSON.stringify(violations)}\n${JSON.stringify(mutated, null, 2)}`,
    ).toEqual([]);
  });
});

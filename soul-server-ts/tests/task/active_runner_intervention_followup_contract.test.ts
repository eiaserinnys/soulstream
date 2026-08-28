import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type {
  EngineExecuteParams,
  EnginePort,
  EngineUserInput,
  SSEEventPayload,
} from "../../src/engine/protocol.js";
import { createInProcessTaskRunnerRuntime } from
  "../../src/runner/task_runner_runtime.js";
import { RunningInterventionTransition } from
  "../../src/task/task_running_intervention_transition.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import {
  activeRunnerViolations,
  type ActiveRunnerObservation,
} from "./active_runner_intervention_followup_oracle.js";
import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const HUMAN_DELIVERY_ID = "delivery-human-live-steer";
const RUNTIME_FOLLOWUP_ID = "runtime-followup-1";
const HUMAN_MARKER = "apply the foreground correction";

const agent: AgentProfile = {
  id: "claude-active-runner",
  name: "Claude Active Runner",
  backend: "claude",
  workspace_dir: "/tmp/claude-active-runner",
};

describe("active runner intervention with one runtime follow-up", () => {
  it("keeps the accepted successor active after the prior engine turn ends", async () => {
    const activeOwner = deferred<void>();
    const releasePriorTurn = deferred<void>();
    const priorTurnEnded = deferred<void>();
    const executeInputs: EngineExecuteParams[] = [];
    const interruptDeliveryIds: string[] = [];
    const runtimeFollowupIds: string[] = [];
    const nextTurnCompletedDeliveryIds: string[] = [];
    let task!: Task;
    let runtimeFollowup!: InterventionMessage;
    let executeCount = 0;

    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: agent.workspace_dir,
      async *execute(params): AsyncIterable<SSEEventPayload> {
        executeCount += 1;
        executeInputs.push(params);
        if (executeCount === 1) {
          yield {
            type: "session",
            session_id: "claude-active-owner",
          } as SSEEventPayload;
          yield {
            type: "complete",
            result: "assistant result arrived before the child command settled",
            timestamp: 1,
          } as SSEEventPayload;
          activeOwner.resolve();
          await releasePriorTurn.promise;
          priorTurnEnded.resolve();
          return;
        }

        if (params.prompt.includes(HUMAN_MARKER)) {
          yield {
            type: "assistant_message",
            content: "foreground correction applied",
            timestamp: 2,
          } as unknown as SSEEventPayload;
          yield {
            type: "complete",
            result: "successor turn completed",
            timestamp: 3,
          } as SSEEventPayload;
          nextTurnCompletedDeliveryIds.push(HUMAN_DELIVERY_ID);
        }
      },
      async intervene(input: EngineUserInput) {
        if (input.prompt.includes(HUMAN_MARKER)) {
          return {
            status: "not_delivered",
            mechanism: "interrupt_then_next_turn",
            reason: "no_active_turn",
          } as const;
        }
        throw new Error("unexpected intervention input");
      },
      async interrupt() {
        interruptDeliveryIds.push(HUMAN_DELIVERY_ID);
        releasePriorTurn.resolve();
        await priorTurnEnded.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));
        task.interventionQueue.push(runtimeFollowup);
        runtimeFollowupIds.push(RUNTIME_FOLLOWUP_ID);
        return true;
      },
      async close() {},
    };

    const persistenceDouble = makeEventPersistenceTestDouble();
    const db = {
      updateSession: vi.fn().mockResolvedValue(undefined),
      setClaudeSessionId: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionDB;
    const broadcaster = {
      emitEventEnvelope: vi.fn().mockResolvedValue(undefined),
      emitSessionUpdated: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionBroadcaster;
    const deliveryRecorder = {
      recordTurnStarted: vi.fn().mockResolvedValue(undefined),
      recordConsumed: vi.fn().mockResolvedValue(undefined),
    };
    const executor = new TaskExecutor(
      () => engine,
      db,
      persistenceDouble.persistence,
      broadcaster,
      pino({ level: "silent" }),
      undefined,
      undefined,
      undefined,
      undefined,
      deliveryRecorder,
    );
    const runner = createInProcessTaskRunnerRuntime(engine);
    task = makeTask();
    runtimeFollowup = {
      text: "runtime follow-up arrived",
      user: "runtime",
      deliveryId: RUNTIME_FOLLOWUP_ID,
      deliveryIntent: "runtime_followup",
    };
    const humanLiveSteer: InterventionMessage = {
      text: HUMAN_MARKER,
      user: "human",
      deliveryId: HUMAN_DELIVERY_ID,
      deliveryIntent: "human_live_steer",
    };
    const transition = new RunningInterventionTransition({
      broadcaster,
      logger: pino({ level: "silent" }),
      persistence: persistenceDouble.persistence,
      liveRetryDelayMs: 0,
    });

    executor.startExecutionWithRunner(task, agent, runner);
    const execution = task.executionPromise!;
    await activeOwner.promise;
    const activeOwnerCount = task.status === "running"
        && task.executionPromise === execution
        && runner.dispatcher.hasActiveExecution()
      ? 1
      : 0;
    await transition.deliver(task, humanLiveSteer);
    releasePriorTurn.resolve();
    await execution;

    const humanLiveSteerDeliveryIds = persistenceDouble.enqueueEvent.mock.calls
      .filter((call) => {
        const event = call[1] as { type?: unknown; text?: unknown };
        return event.type === "intervention_sent" && event.text === HUMAN_MARKER;
      })
      .map(() => HUMAN_DELIVERY_ID);
    const humanModelInputDeliveryIds = executeInputs.slice(1)
      .filter((input) => input.prompt.includes(HUMAN_MARKER))
      .map(() => HUMAN_DELIVERY_ID);
    const humanConsumedDeliveryIds = deliveryRecorder.recordConsumed.mock.calls
      .map((call) => call[0] as InterventionMessage)
      .filter((message) => message.deliveryId === HUMAN_DELIVERY_ID)
      .map((message) => message.deliveryId!);
    const nextTurnActivatedDeliveryIds = deliveryRecorder.recordTurnStarted.mock.calls
      .map((call) => call[0] as InterventionMessage)
      .filter((message) => message.deliveryId === HUMAN_DELIVERY_ID)
      .map((message) => message.deliveryId!);
    const observation: ActiveRunnerObservation = {
      humanDeliveryId: HUMAN_DELIVERY_ID,
      runtimeFollowupId: RUNTIME_FOLLOWUP_ID,
      activeOwnerCount,
      humanLiveSteerDeliveryIds,
      runtimeFollowupIds,
      interruptDeliveryIds,
      humanModelInputDeliveryIds,
      humanConsumedDeliveryIds,
      nextTurnActivatedDeliveryIds,
      nextTurnCompletedDeliveryIds,
      parentStatus: task.status,
      parentTerminationHint: task.pendingTerminationHint ?? null,
    };
    const violations = activeRunnerViolations(observation);
    process.stdout.write(`ACTIVE_RUNNER_FOLLOWUP_RED ${JSON.stringify(violations)}\n`);

    expect(
      violations,
      JSON.stringify(observation, null, 2),
    ).toEqual([]);
    expect(interruptDeliveryIds).toEqual([HUMAN_DELIVERY_ID]);
  });
});

function makeTask(): Task {
  return {
    agentSessionId: "active-runner-session",
    prompt: "initial foreground turn",
    status: "running",
    profileId: agent.id,
    createdAt: new Date(),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import { TaskEngineFailureRecovery } from
  "../../src/task/task_engine_failure_recovery.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import { TaskInterventionRoute } from
  "../../src/task/task_intervention_route.js";
import { enqueueInterventionOnce } from
  "../../src/task/task_intervention_queue.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import { RunningInterventionTransition } from
  "../../src/task/task_running_intervention_transition.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from
  "./event_persistence_test_double.js";
import {
  applyRevivalLoopMutation,
  REVIVAL_LOOP_MUTATIONS,
  type RevivalLoopObservation,
  revivalLoopViolations,
} from "./z_revival_ghost_queue_terminal_oracle.js";

const DELIVERY_ID = "651df6d6-0000-4000-8000-000000000001";
const silentLogger = pino({ level: "silent" });
const agent: AgentProfile = {
  id: "revival-loop-agent",
  name: "revival loop agent",
  backend: "claude",
  workspace_dir: "/workspace/revival-loop",
};

type CounterfactualProjection = (routeTask: Task, failureTask: Task) => void;

describe("runnerless active task revival loop strict causal contract", () => {
  it("same-harness startable counterfactual reaches every axis", async () => {
    const observation = await observeRevivalLoop(projectStartableCounterfactual);
    process.stdout.write(
      `REVIVAL_COUNTERFACTUAL ${JSON.stringify(revivalLoopViolations(observation))}\n`,
    );
    expect(revivalLoopViolations(observation)).toEqual([]);
  });

  it.each(REVIVAL_LOOP_MUTATIONS)(
    "turns the same-harness counterfactual RED under %s",
    async (mutation) => {
      const observation = applyRevivalLoopMutation(
        await observeRevivalLoop(projectStartableCounterfactual),
        mutation,
      );
      const violations = revivalLoopViolations(observation);
      process.stdout.write(`REVIVAL_MUTATION ${mutation} ${JSON.stringify(violations)}\n`);
      expect(violations.length).toBeGreaterThan(0);
    },
  );

  it("reaches route, queue, executor, and failure-recovery product boundaries", async () => {
    const product = await observeRevivalLoop();
    const counterfactual = await observeRevivalLoop(projectStartableCounterfactual);
    expect({
      route: product.productBoundaryCalls.route + counterfactual.productBoundaryCalls.route,
      runningTransition: product.productBoundaryCalls.runningTransition,
      autoResume: counterfactual.productBoundaryCalls.autoResume,
      executor: counterfactual.productBoundaryCalls.executor,
      failureRecovery:
        product.productBoundaryCalls.failureRecovery
        + counterfactual.productBoundaryCalls.failureRecovery,
    }).toEqual({
      route: 2,
      runningTransition: 1,
      autoResume: 1,
      executor: 1,
      failureRecovery: 2,
    });
  });

  it("fresh main RED: runnerless active delivery is consumed and failure stays terminal", async () => {
    const observation = await observeRevivalLoop();
    const violations = revivalLoopViolations(observation);
    process.stdout.write(`REVIVAL_PRODUCT_DIAGNOSTIC ${JSON.stringify(observation)}\n`);
    process.stdout.write(`REVIVAL_STRICT_CAUSAL_RED ${JSON.stringify(violations)}\n`);
    expect(
      violations,
      `revival loop violations: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  });
});

async function observeRevivalLoop(
  project: CounterfactualProjection = () => {},
): Promise<RevivalLoopObservation> {
  const routeTask = makeTask("route");
  const ghostSuccessor = deliveryMessage("ghost-successor");
  const failureTask = makeTask("failure", [ghostSuccessor]);
  project(routeTask, failureTask);

  const runningAdmissions: string[] = [];
  const autoResumeStarts: string[] = [];
  const executionStarts: string[] = [];
  const durableConsumptions: string[] = [];
  const persistence = makeEventPersistenceTestDouble().persistence;
  const running = new RunningInterventionTransition({
    broadcaster: broadcaster(),
    logger: silentLogger,
    persistence,
    liveRetryDelayMs: 0,
  });
  const deliveryRecorder = {
    recordTurnStarted: vi.fn(async () => undefined),
    recordConsumed: vi.fn(async (message: InterventionMessage) => {
      if (message.deliveryId) durableConsumptions.push(message.deliveryId);
    }),
  };
  const executor = new TaskExecutor(
    () => engine(),
    sessionDb(),
    persistence,
    broadcaster(),
    silentLogger,
    undefined,
    undefined,
    undefined,
    undefined,
    deliveryRecorder,
  );
  const route = new TaskInterventionRoute({
    getTask: () => routeTask,
    loadEvictedTask: vi.fn().mockResolvedValue(null),
    rememberTask: vi.fn(),
    runningInterventionTransition: {
      deliver: vi.fn(async (...args: Parameters<typeof running.deliver>) => {
        const deliveryId = args[1].deliveryId;
        if (deliveryId) runningAdmissions.push(deliveryId);
        return await running.deliver(...args);
      }),
    },
    autoResumeTransition: {
      resume: vi.fn(async (task, message, onResume) => {
        if (message.deliveryId) autoResumeStarts.push(message.deliveryId);
        task.status = "running";
        enqueueInterventionOnce(task, message);
        await onResume(task);
        return { autoResumed: true as const };
      }),
    },
  });

  await route.addIntervention(deliveryRequest(routeTask.agentSessionId), async (task) => {
    executionStarts.push(DELIVERY_ID);
    executor.startExecution(task, agent);
    await task.executionPromise;
  });

  const failureRecovery = new TaskEngineFailureRecovery({ logger: silentLogger });
  const disposition = await failureRecovery.recoverFromExecuteFailure(
    failureTask,
    new Error("runner cannot execute the accepted successor"),
  );

  return {
    deliveryId: DELIVERY_ID,
    route: {
      runningAdmissions,
      autoResumeStarts,
      executionStarts,
      durableConsumptions,
      queuedAfter: routeTask.interventionQueue
        .map((message) => message.deliveryId)
        .filter((deliveryId): deliveryId is string => deliveryId !== undefined),
    },
    failure: {
      disposition,
      status: failureTask.status,
      terminationReason: failureTask.pendingTerminationHint,
      terminationDetail: failureTask.pendingTerminationDetail,
    },
    productBoundaryCalls: {
      route: 1,
      runningTransition: runningAdmissions.length,
      autoResume: autoResumeStarts.length,
      executor: executionStarts.length,
      failureRecovery: 1,
    },
  };
}

function projectStartableCounterfactual(routeTask: Task, failureTask: Task): void {
  routeTask.status = "completed";
  failureTask.interventionQueue.length = 0;
}

function makeTask(label: string, interventionQueue: InterventionMessage[] = []): Task {
  return {
    agentSessionId: `revival-loop-${label}`,
    prompt: "existing turn",
    status: "running",
    profileId: agent.id,
    createdAt: new Date("2026-08-26T09:00:00.000Z"),
    lastEventId: 8000,
    lastReadEventId: 7999,
    interventionQueue,
  };
}

function deliveryRequest(agentSessionId: string) {
  return {
    agentSessionId,
    text: "resume and consume this durable delivery",
    user: "delivery-retry",
    source: "user_message",
    deliveryId: DELIVERY_ID,
    deliveryIntent: "human_live_steer" as const,
    completionId: `message:${DELIVERY_ID}`,
    relationKey: `user_message:${agentSessionId}:${DELIVERY_ID}`,
  };
}

function deliveryMessage(deliveryId: string): InterventionMessage {
  return {
    text: "accepted but unstartable successor",
    user: "delivery-retry",
    source: "user_message",
    deliveryId,
    deliveryIntent: "human_live_steer",
    completionId: `message:${deliveryId}`,
    relationKey: `user_message:revival-loop-failure:${deliveryId}`,
  };
}

function engine(): EnginePort {
  return {
    backendId: "claude",
    workspaceDir: agent.workspace_dir,
    async *execute(): AsyncIterable<SSEEventPayload> {
      yield {
        type: "assistant_message",
        content: "durable delivery consumed",
        timestamp: 1,
      };
    },
    async interrupt() {
      return true;
    },
    async close() {},
  };
}

function sessionDb(): SessionDB {
  return {
    updateSession: vi.fn().mockResolvedValue(undefined),
    setClaudeSessionId: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionDB;
}

function broadcaster(): SessionBroadcaster {
  return {
    emitEventEnvelope: vi.fn().mockResolvedValue(undefined),
    emitSessionUpdated: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionBroadcaster;
}

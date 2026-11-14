import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import {
  CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
  type ClaudeRuntimeTaskFollowupPort,
} from "../../src/task/claude_runtime_task_followup.js";
import { INSTRUCTION_UNCERTAIN_REASON } from "../../src/task/state/node_instruction_decision.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import { requeueAfterHandoffAttempt } from "../../src/task/task_intervention_queue.js";
import { TaskManager } from "../../src/task/task_manager.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import type { TaskTurnInputBuilder } from "../../src/task/task_turn_input_builder.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

/**
 * 카드 #1266 U5a 차 (운영 길): 지시를 러너에 넘기려다 큐로 되돌아온 뒤 task가 잊히면 그 지시는
 * 장부에서 모름(uncertain)으로 정리된다. 서버에 「넘기려 한 적 없음」으로 돌려주면 서버가 다시 띄워
 * 두 번 들어갈 수 있다.
 *
 * 되돌아오는 자리는 task_executor의 턴 끝(runtime follow-up의 소비 영수증이 없어 같은 턴에 넘긴
 * 다른 지시를 큐로 되돌리는 곳)이다. 지금 큐 꺼내기 규칙(dequeueNextTurnInterventions)은 runtime
 * follow-up을 다른 지시와 한 턴에 묶지 않으므로, 이 시험은 첫 턴 입력 준비만 감싸 두 지시를 한 턴에
 * 넘긴다. 그 뒤는 실행기의 턴 끝, 큐, TaskManager의 잊기, 장부 정산이 모두 운영 코드 그대로다.
 *
 * 같은 deliveryId나 지시 번호의 항목이 이미 큐에 있으면 되돌아온 항목은 합쳐지고 큐에 있던 항목이
 * 남는다. 시도 표시는 남는 항목에도 살아남아야 한다.
 */
const silentLogger = pino({ level: "silent" });

const claudeAgent: AgentProfile = {
  id: "claude-roselin",
  name: "로젤린",
  backend: "claude",
  workspace_dir: "/tmp/claude-roselin",
};

const FOLLOWUP_DELIVERY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HANDED_DELIVERY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeTask(): Task {
  return {
    agentSessionId: "sess-u5a-handoff",
    prompt: "hi",
    status: "running",
    profileId: claudeAgent.id,
    createdAt: new Date("2026-11-14T01:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

function ledgerRow(deliveryId: string) {
  return {
    delivery_id: deliveryId,
    state: "queued",
    aggregate_state: "pending",
    attempt_token: "token-1",
    // 서버가 노드에 넘기기 시작한 표시다. 메모리 큐에 있는 지시에는 거의 늘 값이 있어 기준이 아니다.
    dispatching_at: new Date(),
  };
}

function makeManager() {
  const repository = {
    get: vi.fn(async (deliveryId: string) => ledgerRow(deliveryId)),
    retryDeliveryAttempt: vi.fn(async () => ({})),
    markUncertain: vi.fn(async () => ({})),
  };
  const persistence = makeEventPersistenceTestDouble(undefined, [], {
    capabilityProfile: "legacy_transition_only",
  });
  const db = {
    getSession: vi.fn(async () => null),
    sessionDeliveries: () => repository,
    claudeBackgroundTasks: () => ({}),
  };
  const manager = new TaskManager(
    "node-a",
    db as never,
    {} as never,
    silentLogger,
    persistence.persistence,
    undefined, undefined, undefined, undefined,
    true,
  );
  const tasks = (manager as unknown as { tasks: Map<string, Task> }).tasks;
  return { manager, tasks, repository };
}

function makeExecutor(engine: EnginePort) {
  const persistence = makeEventPersistenceTestDouble(
    async (_sessionId: string, event: SSEEventPayload, task: Task) => {
      if (event.type === "text_delta" && typeof event.text === "string") {
        task.lastAssistantText = event.text;
      }
    },
  ).persistence;
  const db = {
    updateSession: vi.fn().mockResolvedValue(undefined),
    setClaudeSessionId: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionDB;
  const broadcaster = {
    emitEventEnvelope: vi.fn().mockResolvedValue(undefined),
    emitSessionUpdated: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionBroadcaster;
  const followup: ClaudeRuntimeTaskFollowupPort = {
    collect: vi.fn(),
    collectDetached: vi.fn(),
    flush: vi.fn(),
  };
  const deliveryRecorder = {
    recordTurnStarted: vi.fn(async () => undefined),
    recordConsumed: vi.fn(async () => undefined),
  };
  return new TaskExecutor(
    () => engine,
    db,
    persistence,
    broadcaster,
    silentLogger,
    undefined,
    undefined,
    undefined,
    followup,
    deliveryRecorder,
  );
}

/** 첫 턴에 runtime follow-up과 보통 지시를 함께 넘긴다(위 설명 참조). */
function handBothInFirstTurn(
  executor: TaskExecutor,
  task: Task,
  followupMessage: InterventionMessage,
  handed: InterventionMessage,
): void {
  const builder = (executor as unknown as { turnInputBuilder: TaskTurnInputBuilder }).turnInputBuilder;
  const original = builder.prepareFollowupTurnInput.bind(builder);
  let first = true;
  vi.spyOn(builder, "prepareFollowupTurnInput").mockImplementation(async (target, agent, interventions) => {
    if (!first) return await original(target, agent, interventions);
    first = false;
    task.interventionQueue = task.interventionQueue.filter(
      (queued) => queued !== followupMessage && queued !== handed,
    );
    return await original(target, agent, [followupMessage, handed]);
  });
}

function messages() {
  const followupMessage: InterventionMessage = {
    text: "runtime follow-up prompt",
    user: "system",
    source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
    deliveryId: FOLLOWUP_DELIVERY,
    deliveryIntent: "runtime_followup",
  };
  // 낮은 줄의 지시라 runtime follow-up의 정확한 다시 넘김 턴 동안 큐에 남는다.
  const handed: InterventionMessage = {
    text: "background task finished",
    user: "system",
    deliveryId: HANDED_DELIVERY,
    deliveryIntent: "completion_notification",
  };
  return { followupMessage, handed };
}

describe("card #1266 U5a 차: an instruction that came back to the queue after a hand-off attempt settles as uncertain when its task is forgotten", () => {
  it("marks it uncertain through the executor's turn end, the queue, and the manager's forget", async () => {
    const subject = makeManager();
    const task = makeTask();
    subject.tasks.set(task.agentSessionId, task);
    const { followupMessage, handed } = messages();
    task.interventionQueue.push(followupMessage, handed);

    let turn = 0;
    let queuedWhenForgotten: string[] = [];
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(): AsyncIterable<SSEEventPayload> {
        turn += 1;
        if (turn === 2) {
          // 첫 턴이 끝나 넘긴 지시가 큐로 되돌아온 뒤, 러너를 거두며 task가 잊힌다.
          queuedWhenForgotten = task.interventionQueue.map((message) => message.deliveryId ?? "");
          subject.manager.forgetRunnerRecoveryTask(task);
        }
        yield { type: "complete", result: "", timestamp: turn } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const executor = makeExecutor(engine);
    handBothInFirstTurn(executor, task, followupMessage, handed);

    executor.startNewExecution(task, claudeAgent);
    await task.executionPromise;

    expect(queuedWhenForgotten).toEqual([HANDED_DELIVERY]);
    await vi.waitFor(() => expect(subject.repository.markUncertain).toHaveBeenCalledOnce());
    expect(subject.repository.markUncertain).toHaveBeenCalledWith(
      HANDED_DELIVERY,
      "token-1",
      INSTRUCTION_UNCERTAIN_REASON,
    );
    expect(subject.repository.retryDeliveryAttempt).not.toHaveBeenCalled();
  });

  it("keeps the attempt mark when the instruction merges into a queued entry with the same delivery", async () => {
    const subject = makeManager();
    const task = makeTask();
    subject.tasks.set(task.agentSessionId, task);
    const { followupMessage, handed } = messages();
    task.interventionQueue.push(followupMessage, handed);

    let turn = 0;
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(): AsyncIterable<SSEEventPayload> {
        turn += 1;
        if (turn === 1) {
          // 턴이 도는 동안 같은 delivery가 다른 객체로 다시 들어온다.
          task.interventionQueue.push({ ...handed });
        }
        if (turn === 2) subject.manager.forgetRunnerRecoveryTask(task);
        yield { type: "complete", result: "", timestamp: turn } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const executor = makeExecutor(engine);
    handBothInFirstTurn(executor, task, followupMessage, handed);

    executor.startNewExecution(task, claudeAgent);
    await task.executionPromise;

    await vi.waitFor(() => expect(subject.repository.markUncertain).toHaveBeenCalledOnce());
    expect(subject.repository.markUncertain).toHaveBeenCalledWith(
      HANDED_DELIVERY,
      "token-1",
      INSTRUCTION_UNCERTAIN_REASON,
    );
    expect(subject.repository.retryDeliveryAttempt).not.toHaveBeenCalled();
  });

  it.each([
    // 지시 번호가 달라 deliveryId로 합쳐진다(task_intervention_queue의 deliveryId 비교).
    ["delivery id", (handed: InterventionMessage): InterventionMessage => ({
      ...handed, runnerInterventionId: "runner-intervention-other",
    })],
    // 같은 지시 번호로 먼저 합쳐진다(task_intervention_queue의 지시 번호 비교).
    ["instruction number", (handed: InterventionMessage): InterventionMessage => ({ ...handed })],
  ])("keeps the attempt mark on the surviving queued entry that shares the %s", async (_key, sameEntry) => {
    const subject = makeManager();
    const task = makeTask();
    subject.tasks.set(task.agentSessionId, task);
    const handed: InterventionMessage = {
      text: "next turn",
      user: "alice",
      deliveryId: HANDED_DELIVERY,
      deliveryIntent: "durable_next_turn",
      runnerInterventionId: "runner-intervention-1",
    };
    const queued = sameEntry(handed);
    task.interventionQueue.push(queued);

    expect(requeueAfterHandoffAttempt(task, handed)).toBe(1);
    expect(task.interventionQueue).toEqual([queued]);

    subject.manager.forgetRunnerRecoveryTask(task);
    await vi.waitFor(() => expect(subject.repository.markUncertain).toHaveBeenCalledOnce());
    expect(subject.repository.retryDeliveryAttempt).not.toHaveBeenCalled();
  });
});

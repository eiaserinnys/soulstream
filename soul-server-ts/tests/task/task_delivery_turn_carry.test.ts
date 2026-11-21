
const unsupportedEngineIntervention = async () => ({
  status: "not_delivered", mechanism: "unsupported", reason: "not_supported",
} as const);
/**
 * Reproduction evidence from the unfixed code (main, bc9958d25e), run on
 * 2026-11-18 with:
 *
 *   vitest run tests/task/task_delivery_turn_carry.test.ts \
 *     -t "re-sends D before E"
 *
 *   × carrying unconfirmed deliveries into the next turn > re-sends D before E
 *     when the interrupt_then_next_turn delivery cut the turn
 *     → expected "spy" to not be called at all, but actually been called 1 times
 *
 *   AssertionError: expected "spy" to not be called at all, but actually been
 *   called 1 times
 *   Received:
 *     1st spy call:
 *       Array [
 *         Object {
 *           "deliveryId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
 *           "deliveryIntent": "human_live_steer",
 *           "text": "body D",
 *           "user": "alice",
 *         },
 *         "delivery turn ended without a consumption receipt",
 *       ]
 *
 * main builds the second turn from E alone and the finalizer settles D as an
 * admission failure even though E's turn completes: the false dead_letter this
 * test reproduces.
 */
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "@soulstream/agent-profile-contract";
import type { SessionDB } from "../../src/db/session_db.js";
import type { EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const silentLogger = pino({ level: "silent" });

const agent: AgentProfile = {
  id: "codex-default",
  name: "Codex Default",
  backend: "codex",
  workspace_dir: "/tmp/codex-default",
};

function makeTask(queue: InterventionMessage[] = []): Task {
  return {
    agentSessionId: "session-carry",
    prompt: "original prompt",
    status: "running",
    profileId: agent.id,
    createdAt: new Date("2026-11-18T00:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: queue,
  };
}

function makeMocks() {
  const persistence = makeEventPersistenceTestDouble().persistence;
  const db = {
    updateSession: vi.fn().mockResolvedValue(undefined),
    setClaudeSessionId: vi.fn().mockResolvedValue(undefined),
    getSession: vi.fn().mockResolvedValue(null),
  } as unknown as SessionDB;
  const broadcaster = {
    emitEventEnvelope: vi.fn().mockResolvedValue(undefined),
    emitSessionUpdated: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionBroadcaster;
  return { persistence, db, broadcaster };
}

function makeRecorder() {
  return {
    recordConsumed: vi.fn().mockResolvedValue(undefined),
    recordTurnStarted: vi.fn().mockResolvedValue(undefined),
    discardIfConsumed: vi.fn().mockResolvedValue(false),
    recordConsumptionFailure: vi.fn().mockResolvedValue(undefined),
    recordAdmissionFailure: vi.fn().mockResolvedValue(undefined),
    recordRuntimeFollowupRelationConsumed: vi.fn().mockResolvedValue(true),
  };
}

function makeExecutor(
  engineFactory: () => EnginePort,
  recorder: ReturnType<typeof makeRecorder>,
) {
  const mocks = makeMocks();
  const executor = new TaskExecutor(
    engineFactory,
    mocks.db,
    mocks.persistence,
    mocks.broadcaster,
    silentLogger,
    undefined,
    undefined,
    undefined,
    undefined,
    recorder,
  );
  return executor;
}

function steer(deliveryId: string, text: string): InterventionMessage {
  return {
    text,
    user: "alice",
    deliveryId,
    deliveryIntent: "human_live_steer",
  };
}

function sessionOnly(timestamp: number): SSEEventPayload {
  return { type: "session", session_id: "native-1", timestamp } as SSEEventPayload;
}

function toolEvent(timestamp: number): SSEEventPayload {
  return {
    type: "tool_start",
    tool_name: "Read",
    tool_use_id: "toolu-carry",
    tool_input: { path: "README.md" },
    timestamp,
  } as SSEEventPayload;
}

function toolResult(timestamp: number): SSEEventPayload {
  return {
    type: "tool_result",
    tool_name: "Read",
    tool_use_id: "toolu-carry",
    result: "contents",
    is_error: false,
    timestamp,
  } as SSEEventPayload;
}

function assistantMessage(timestamp: number): SSEEventPayload {
  return {
    type: "assistant_message",
    content: "done",
    timestamp,
  } as SSEEventPayload;
}

function complete(timestamp: number): SSEEventPayload {
  return { type: "complete", result: "", timestamp } as SSEEventPayload;
}

/** Records the prompt of every turn and lets each turn act on the task. */
function makeTurnEngine(
  task: Task,
  turns: Array<(task: Task) => AsyncIterable<SSEEventPayload>>,
  prompts: string[],
): () => EnginePort {
  let turn = 0;
  const engine: EnginePort = {
    backendId: "codex",
    intervene: unsupportedEngineIntervention,
    workspaceDir: "/tmp/codex-default",
    async *execute(params): AsyncIterable<SSEEventPayload> {
      const build = turns[Math.min(turn, turns.length - 1)];
      turn += 1;
      prompts.push(params.prompt);
      yield* build!(task);
    },
    async interrupt() { return true; },
    async close() {},
  };
  return () => engine;
}

describe("carrying unconfirmed deliveries into the next turn", () => {
  it("re-sends D before E when the interrupt_then_next_turn delivery cut the turn", async () => {
    const deliveryD = steer("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "body D");
    const deliveryE = steer("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "body E");
    const task = makeTask([deliveryD]);
    const recorder = makeRecorder();
    const prompts: string[] = [];
    const turns: Array<(task: Task) => AsyncIterable<SSEEventPayload>> = [
      async function* (current) {
        // The antigravity adapter interrupts the turn and queues the
        // intervention for the next turn.
        current.interventionQueue.push(deliveryE);
        yield sessionOnly(1);
      },
      async function* () {
        yield toolEvent(2);
        yield toolResult(3);
        yield assistantMessage(4);
        yield complete(5);
      },
    ];
    const executor = makeExecutor(makeTurnEngine(task, turns, prompts), recorder);

    executor.startNewExecution(task, agent);
    await task.executionPromise;

    // The regression this test guards: D was re-sent nowhere and settled as an
    // admission failure even though the next turn consumed E.
    expect(recorder.recordAdmissionFailure).not.toHaveBeenCalled();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("body D");
    expect(prompts[1]).toContain("body E");
    expect(prompts[1]?.indexOf("body D")).toBeLessThan(
      prompts[1]?.indexOf("body E") ?? Number.POSITIVE_INFINITY,
    );
    expect(recorder.recordConsumed).toHaveBeenCalledTimes(2);
    expect(recorder.recordConsumed).toHaveBeenCalledWith(
      deliveryD,
      task,
      expect.any(String),
    );
    expect(recorder.recordConsumed).toHaveBeenCalledWith(
      deliveryE,
      task,
      expect.any(String),
    );
    expect(task.status).toBe("completed");
  });

  it("carries again when the second turn is interrupted the same way", async () => {
    const deliveryD = steer("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "body D");
    const deliveryE = steer("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "body E");
    const deliveryF = steer("ffffffff-ffff-4fff-8fff-ffffffffffff", "body F");
    const task = makeTask([deliveryD]);
    const recorder = makeRecorder();
    const prompts: string[] = [];
    const turns: Array<(task: Task) => AsyncIterable<SSEEventPayload>> = [
      async function* (current) {
        current.interventionQueue.push(deliveryE);
        yield sessionOnly(1);
      },
      async function* (current) {
        current.interventionQueue.push(deliveryF);
        yield sessionOnly(2);
      },
      async function* () {
        yield toolEvent(3);
        yield toolResult(4);
        yield assistantMessage(5);
        yield complete(6);
      },
    ];
    const executor = makeExecutor(makeTurnEngine(task, turns, prompts), recorder);

    executor.startNewExecution(task, agent);
    await task.executionPromise;

    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain("body D");
    expect(prompts[2]).toContain("body E");
    expect(prompts[2]).toContain("body F");
    expect(prompts[2]?.indexOf("body D")).toBeLessThan(
      prompts[2]?.indexOf("body E") ?? Number.POSITIVE_INFINITY,
    );
    expect(prompts[2]?.indexOf("body E")).toBeLessThan(
      prompts[2]?.indexOf("body F") ?? Number.POSITIVE_INFINITY,
    );
    expect(recorder.recordConsumed).toHaveBeenCalledTimes(3);
    expect(recorder.recordAdmissionFailure).not.toHaveBeenCalled();
  });

  it("does not re-send a delivery the interrupted turn already recorded", async () => {
    const deliveryD = steer("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "body D");
    const deliveryE = steer("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "body E");
    const task = makeTask([deliveryD]);
    const recorder = makeRecorder();
    const prompts: string[] = [];
    const turns: Array<(task: Task) => AsyncIterable<SSEEventPayload>> = [
      async function* (current) {
        current.interventionQueue.push(deliveryE);
        yield sessionOnly(1);
        // A qualifying event records D before the turn is cut.
        yield assistantMessage(2);
      },
      async function* () {
        yield toolEvent(3);
        yield assistantMessage(4);
        yield complete(5);
      },
    ];
    const executor = makeExecutor(makeTurnEngine(task, turns, prompts), recorder);

    executor.startNewExecution(task, agent);
    await task.executionPromise;

    expect(prompts[1]).not.toContain("body D");
    expect(prompts[1]).toContain("body E");
    expect(recorder.recordConsumed).toHaveBeenCalledWith(
      deliveryD,
      task,
      expect.any(String),
    );
    expect(recorder.recordConsumed.mock.calls.filter(
      ([message]) => (message as InterventionMessage).deliveryId === deliveryD.deliveryId,
    )).toHaveLength(1);
    expect(recorder.recordAdmissionFailure).not.toHaveBeenCalled();
  });

  it("does not carry runtime follow-ups", async () => {
    const deliveryD: InterventionMessage = {
      text: "runtime body D",
      user: "system",
      source: "claude_runtime_task_followup",
      deliveryIntent: "runtime_followup",
      deliveryId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    };
    const deliveryE = steer("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "body E");
    const task = makeTask([deliveryD]);
    const recorder = makeRecorder();
    const prompts: string[] = [];
    const turns: Array<(task: Task) => AsyncIterable<SSEEventPayload>> = [
      async function* (current) {
        current.interventionQueue.push(deliveryE);
        yield sessionOnly(1);
      },
      async function* () {
        yield toolEvent(2);
        yield assistantMessage(3);
        yield complete(4);
      },
    ];
    const executor = makeExecutor(makeTurnEngine(task, turns, prompts), recorder);

    executor.startNewExecution(task, agent);
    await task.executionPromise;

    expect(prompts[1]).not.toContain("runtime body D");
    expect(prompts[1]).toContain("body E");
    expect(recorder.recordAdmissionFailure).toHaveBeenCalledWith(
      deliveryD,
      "delivery turn ended without a consumption receipt",
    );
  });

  it("does not carry a delivery whose turn-start receipt was attempted", async () => {
    const deliveryD = steer("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "body D");
    const deliveryE = steer("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "body E");
    const task = makeTask([deliveryD]);
    const recorder = makeRecorder();
    recorder.recordTurnStarted.mockRejectedValueOnce(new Error("transient database error"));
    const prompts: string[] = [];
    const turns: Array<(task: Task) => AsyncIterable<SSEEventPayload>> = [
      async function* (current) {
        current.interventionQueue.push(deliveryE);
        yield sessionOnly(1);
        // The only qualifying event attempts the turn-start receipt and fails.
        yield assistantMessage(2);
      },
      async function* () {
        yield toolEvent(3);
        yield assistantMessage(4);
        yield complete(5);
      },
    ];
    const executor = makeExecutor(makeTurnEngine(task, turns, prompts), recorder);

    executor.startNewExecution(task, agent);
    await task.executionPromise;

    expect(prompts[1]).not.toContain("body D");
    expect(recorder.recordAdmissionFailure).toHaveBeenCalledWith(
      deliveryD,
      "delivery turn ended without a consumption receipt",
    );
  });

  it("closes a delivery never observed until the last turn as an admission failure", async () => {
    const deliveryD = steer("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "body D");
    const deliveryE = steer("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "body E");
    const task = makeTask([deliveryD]);
    const recorder = makeRecorder();
    const prompts: string[] = [];
    const turns: Array<(task: Task) => AsyncIterable<SSEEventPayload>> = [
      async function* (current) {
        current.interventionQueue.push(deliveryE);
        yield sessionOnly(1);
      },
      async function* () {
        // The final turn emits only filtered events.
        yield sessionOnly(2);
      },
    ];
    const executor = makeExecutor(makeTurnEngine(task, turns, prompts), recorder);

    executor.startNewExecution(task, agent);
    await task.executionPromise;

    expect(recorder.recordAdmissionFailure).toHaveBeenCalledWith(
      deliveryD,
      "delivery turn ended without a consumption receipt",
    );
    expect(recorder.recordAdmissionFailure.mock.calls.filter(
      ([message]) => (message as InterventionMessage).deliveryId === deliveryD.deliveryId,
    )).toHaveLength(1);
  });
});

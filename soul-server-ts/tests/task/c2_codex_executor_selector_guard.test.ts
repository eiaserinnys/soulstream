import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import { buildCanonicalDeliveryPayload } from "../../src/task/delivery_payload.js";
import { effectiveTaskBackend } from "../../src/task/task_model_preset.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

/**
 * C2 review gate — production TaskExecutor selector, not a direct receipt.
 *
 * The shared TaskDeliveryTurnReceipt is constructed inside TaskExecutor, which
 * hands it the Claude transcript reader. A direct receipt test cannot see that
 * wiring, so this guard drives the real TaskExecutor and pins:
 *
 *   - backend comes from effectiveTaskBackend(task, agent), so a codex model
 *     preset on a claude agent profile is a Codex turn;
 *   - a Codex turn never consults the Claude transcript reader;
 *   - legacy Codex consumption stays exactly once, with exact identity args;
 *   - a session/error-only Codex turn leaves the delivery replayable, and the
 *     same delivery is then consumed exactly once by a later normal turn.
 */

const silentLogger = pino({ level: "silent" });

/** Claude agent profile. The codex model preset must override it. */
const CLAUDE_PROFILE: AgentProfile = {
  id: "seosoyoung",
  name: "서소영",
  backend: "claude",
  workspace_dir: "/tmp/seosoyoung",
};

const PRECEDING_EVENT_ID = 4242;

interface TurnRun {
  readonly recordTurnStarted: ReturnType<typeof vi.fn>;
  readonly recordConsumed: ReturnType<typeof vi.fn>;
  readonly discardIfConsumed: ReturnType<typeof vi.fn>;
  readonly inspect: ReturnType<typeof vi.fn>;
  readonly intervention: InterventionMessage;
  readonly task: Task;
}

function makeEngine(events: SSEEventPayload[], failure?: Error): EnginePort {
  return {
    backendId: "codex",
    workspaceDir: CLAUDE_PROFILE.workspace_dir,
    async *execute(): AsyncIterable<SSEEventPayload> {
      for (const event of events) yield event;
      if (failure) throw failure;
    },
    async interrupt() {
      return true;
    },
    async close() {},
  } as unknown as EnginePort;
}

async function runCodexTurn(
  deliveryId: string,
  events: SSEEventPayload[],
  failure?: Error,
): Promise<TurnRun> {
  const text = `codex-live-steer:${deliveryId}`;
  const completionId = `message:${deliveryId}`;
  const relationKey = `user_message:c2-codex:${deliveryId}`;
  const canonical = buildCanonicalDeliveryPayload({
    text,
    user: "agent",
    source: "user_message",
    completionId,
    relationKey,
  });

  const recordTurnStarted = vi.fn(async () => undefined);
  const recordConsumed = vi.fn(async () => undefined);
  const discardIfConsumed = vi.fn(async () => false);
  const inspect = vi.fn(async () => ({
    kind: "absent",
    inputUuid: "claude-only-uuid",
  }));

  const persistenceDouble = makeEventPersistenceTestDouble(undefined, [
    {
      eventId: PRECEDING_EVENT_ID,
      event: { type: "metadata", metadata_type: "seed" } as unknown as SSEEventPayload,
    },
  ]);
  const db = {
    updateSession: vi.fn().mockResolvedValue(undefined),
    setClaudeSessionId: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionDB;
  const broadcaster = {
    emitEventEnvelope: vi.fn().mockResolvedValue(undefined),
    emitSessionUpdated: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionBroadcaster;

  const executor = new TaskExecutor(
    () => makeEngine(events, failure),
    db,
    persistenceDouble.persistence,
    broadcaster,
    silentLogger,
    undefined,
    undefined,
    undefined,
    undefined,
    { recordTurnStarted, recordConsumed, discardIfConsumed } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { inspect } as never,
  );

  const intervention: InterventionMessage = {
    text,
    user: "agent",
    source: "user_message",
    deliveryId,
    deliveryIntent: "human_live_steer",
    completionId,
    relationKey,
    storedDeliveryPayload: canonical.payload,
    storedDeliveryPayloadHash: canonical.payloadHash,
  };
  const task = {
    agentSessionId: `c2-codex-${deliveryId}`,
    prompt: "existing foreground turn",
    status: "running",
    profileId: CLAUDE_PROFILE.id,
    createdAt: new Date("2026-08-25T00:00:00.000Z"),
    lastEventId: PRECEDING_EVENT_ID,
    lastReadEventId: PRECEDING_EVENT_ID - 1,
    modelPresetBackend: "codex",
    interventionQueue: [intervention],
  } as Task;

  // The conflicting authority is the point: profile says claude, preset says codex.
  expect(CLAUDE_PROFILE.backend).toBe("claude");
  expect(effectiveTaskBackend(task, CLAUDE_PROFILE)).toBe("codex");

  executor.startExecution(task, CLAUDE_PROFILE);
  await task.executionPromise;

  return { recordTurnStarted, recordConsumed, discardIfConsumed, inspect, intervention, task };
}

const metadataEvent = {
  type: "metadata",
  metadata_type: "execution_ownership_transition",
  value: { phase: "execution_activate" },
} as unknown as SSEEventPayload;
const assistantEvent = {
  type: "assistant_message",
  content: "codex reply",
  timestamp: 1,
} as unknown as SSEEventPayload;
const resultEvent = { type: "result", status: "completed" } as unknown as SSEEventPayload;
const completeEvent = { type: "complete", status: "completed" } as unknown as SSEEventPayload;
const sessionEvent = { type: "session", sessionId: "codex-thread" } as unknown as SSEEventPayload;
const errorEvent = { type: "error", message: "codex boom" } as unknown as SSEEventPayload;

describe("C2 review gate: TaskExecutor keeps Codex off the Claude proof path", () => {
  it("never consults the Claude transcript reader for a Codex turn", async () => {
    const run = await runCodexTurn("codex-exec-no-inspect", [
      metadataEvent,
      assistantEvent,
      resultEvent,
      completeEvent,
    ]);
    expect(run.inspect).toHaveBeenCalledTimes(0);
  });

  it("consumes a legacy Codex turn exactly once with exact identity args", async () => {
    const run = await runCodexTurn("codex-exec-exact-args", [
      metadataEvent,
      assistantEvent,
      resultEvent,
      completeEvent,
    ]);

    expect(run.recordTurnStarted).toHaveBeenCalledTimes(1);
    expect(run.recordConsumed).toHaveBeenCalledTimes(1);

    const startedArgs = run.recordTurnStarted.mock.calls[0] as unknown[];
    expect(startedArgs[0]).toBe(run.intervention);
    expect((startedArgs[1] as Task).agentSessionId).toBe(run.task.agentSessionId);

    const consumedArgs = run.recordConsumed.mock.calls[0] as unknown[];
    expect(consumedArgs[0]).toBe(run.intervention);
    expect((consumedArgs[1] as Task).agentSessionId).toBe(run.task.agentSessionId);
    expect(consumedArgs[2]).toBe(`event:${PRECEDING_EVENT_ID}`);
  });

  it("leaves a session/error-only Codex turn replayable and consumes the retry exactly once", async () => {
    const deliveryId = "codex-exec-replayable";
    const firstAttempt = await runCodexTurn(
      deliveryId,
      [sessionEvent, errorEvent],
      new Error("codex stream closed before any turn output"),
    );
    expect(firstAttempt.inspect).toHaveBeenCalledTimes(0);
    expect(firstAttempt.recordConsumed).toHaveBeenCalledTimes(0);

    const retry = await runCodexTurn(deliveryId, [
      metadataEvent,
      assistantEvent,
      resultEvent,
      completeEvent,
    ]);
    expect(retry.inspect).toHaveBeenCalledTimes(0);
    expect(retry.recordConsumed).toHaveBeenCalledTimes(1);

    const totalConsumed =
      firstAttempt.recordConsumed.mock.calls.length + retry.recordConsumed.mock.calls.length;
    expect(totalConsumed).toBe(1);
  });
});

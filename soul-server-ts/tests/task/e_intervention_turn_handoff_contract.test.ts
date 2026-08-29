import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import {
  ClaudeEngineAdapter,
  ClaudeSdkClient,
} from "../../src/engine/claude_adapter.js";
import { ClaudeSessionClientRegistry } from
  "../../src/engine/claude_session_client_registry.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";
import { RunningInterventionTransition } from
  "../../src/task/task_running_intervention_transition.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import {
  makeHarness,
  sdkInit,
  sdkInterruptedResult,
  sdkResult,
  sdkTaskNotificationResult,
} from "../engine/claude_sdk_persistent_test_harness.js";
import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const silentLogger = pino({ level: "silent" });

const agent: AgentProfile = {
  id: "claude-lane-e",
  name: "Claude Lane E",
  backend: "claude",
  workspace_dir: "/tmp/claude-lane-e",
};

function makeTask(sessionId: string): Task {
  return {
    agentSessionId: sessionId,
    prompt: "foreground work",
    status: "running",
    profileId: agent.id,
    createdAt: new Date("2026-08-29T00:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

function assistantMessage(sessionId: string, text: string): SDKMessage {
  return {
    type: "assistant",
    uuid: `assistant-${sessionId}`,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: `message-${sessionId}`,
      model: "claude",
      role: "assistant",
      content: [{ type: "text", text }],
    },
  } as unknown as SDKMessage;
}

function makeFullSlice(sessionId: string) {
  const sdk = makeHarness({ receipt: { still_queued: [] } });
  const client = new ClaudeSdkClient(
    {
      query: sdk.queryFn,
      detachedEventSink: sdk.detached,
      postResultDrainMs: 10,
    },
    silentLogger,
  );
  const registry = new ClaudeSessionClientRegistry(
    () => client,
    { idleTtlMs: 300_000, maxEntries: 4 },
  );
  const engine = new ClaudeEngineAdapter(
    {
      workspaceDir: agent.workspace_dir,
      client,
      persistentSessionRegistry: registry,
      processEnv: {},
    },
    silentLogger,
  );
  const persistence = makeEventPersistenceTestDouble();
  const db = {
    updateSession: vi.fn().mockResolvedValue(undefined),
    setClaudeSessionId: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionDB;
  const broadcaster = {
    emitEventEnvelope: vi.fn().mockResolvedValue(undefined),
    emitSessionUpdated: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionBroadcaster;
  const delivery = {
    discardIfConsumed: vi.fn().mockResolvedValue(false),
    recordTurnStarted: vi.fn().mockResolvedValue(undefined),
    recordConsumed: vi.fn().mockResolvedValue(undefined),
  };
  const executor = new TaskExecutor(
    () => engine,
    db,
    persistence.persistence,
    broadcaster,
    silentLogger,
    undefined,
    undefined,
    undefined,
    undefined,
    delivery,
  );
  const transition = new RunningInterventionTransition({
    broadcaster,
    logger: silentLogger,
    persistence: persistence.persistence,
  });
  const task = makeTask(sessionId);
  return {
    broadcaster,
    client,
    delivery,
    engine,
    executor,
    persistence,
    registry,
    sdk,
    task,
    transition,
  };
}

function persistedEvents(
  slice: ReturnType<typeof makeFullSlice>,
): SSEEventPayload[] {
  return slice.persistence.enqueueEvent.mock.calls.map(
    (call) => call[1] as SSEEventPayload,
  );
}

describe("Lane E running intervention turn handoff", () => {
  it("interrupts one owner, consumes one successor, and never projects the EDE as session error", async () => {
    const slice = makeFullSlice("lane-e-intervention");
    const execution = slice.executor.startExecution(slice.task, agent);
    const foregroundInput = await slice.sdk.nextInput();
    slice.sdk.push(sdkInit("claude-lane-e"));

    const intervention: InterventionMessage = {
      text: "apply the intervention now",
      user: "operator",
      deliveryId: "delivery-lane-e",
      deliveryIntent: "human_live_steer",
    };
    await expect(slice.transition.deliver(slice.task, intervention)).resolves.toMatchObject({
      delivered: false,
      queued: true,
      consumeWhen: "next_turn",
    });
    expect(slice.sdk.interrupt).toHaveBeenCalledTimes(1);

    slice.sdk.push(sdkInterruptedResult("claude-lane-e", undefined));
    const successorInput = await slice.sdk.nextInput();
    expect(successorInput.message.content).toContain(intervention.text);
    expect(slice.task.status).toBe("running");
    expect(persistedEvents(slice).filter((event) => event.type === "session_ended")).toEqual([]);

    // A delayed SDK-owned background completion has no foreground ownership.
    slice.sdk.push(sdkTaskNotificationResult("claude-lane-e"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(slice.task.status).toBe("running");
    expect(persistedEvents(slice).filter((event) => event.type === "session_ended")).toEqual([]);

    slice.sdk.push(assistantMessage("claude-lane-e", "successor answer"));
    slice.sdk.push(sdkResult("claude-lane-e", successorInput.uuid, "successor terminal"));
    await execution;

    const events = persistedEvents(slice);
    expect(foregroundInput.uuid).not.toBe(successorInput.uuid);
    expect(events.filter((event) => event.type === "intervention_sent")).toHaveLength(1);
    expect(events.filter((event) => event.type === "assistant_message")).toHaveLength(1);
    expect(events.filter((event) => event.type === "complete")).toHaveLength(1);
    expect(events.filter((event) => event.type === "session_ended")).toHaveLength(1);
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(slice.delivery.recordTurnStarted).toHaveBeenCalledTimes(1);
    expect(slice.delivery.recordConsumed).toHaveBeenCalledTimes(1);
    expect(slice.task.status).toBe("completed");
    expect(slice.task.error).toBeUndefined();
    expect(slice.task.pendingTerminationHint).toBeUndefined();
    expect(slice.persistence.acquireExecutionOwnershipAndWaitForApplication)
      .toHaveBeenCalledTimes(1);
    expect(slice.persistence.releaseExecutionOwnershipAndWaitForApplication)
      .toHaveBeenCalledTimes(1);

    await slice.registry.shutdown();
  });

  it("keeps ordinary completion unchanged when no intervention arrives", async () => {
    const slice = makeFullSlice("lane-e-control");
    const execution = slice.executor.startExecution(slice.task, agent);
    const input = await slice.sdk.nextInput();
    slice.sdk.push(sdkInit("claude-lane-e-control"));
    slice.sdk.push(assistantMessage("claude-lane-e-control", "ordinary answer"));
    slice.sdk.push(sdkResult("claude-lane-e-control", input.uuid, "ordinary terminal"));
    await execution;

    const events = persistedEvents(slice);
    expect(slice.sdk.interrupt).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "assistant_message")).toHaveLength(1);
    expect(events.filter((event) => event.type === "complete")).toHaveLength(1);
    expect(events.filter((event) => event.type === "session_ended")).toHaveLength(1);
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(slice.delivery.recordTurnStarted).not.toHaveBeenCalled();
    expect(slice.delivery.recordConsumed).not.toHaveBeenCalled();
    expect(slice.task.status).toBe("completed");

    await slice.registry.shutdown();
  });
});

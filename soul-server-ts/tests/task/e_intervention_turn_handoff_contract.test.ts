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
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import {
  makeHarness,
  sdkInit,
  sdkResult,
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
  };
}

function persistedEvents(
  slice: ReturnType<typeof makeFullSlice>,
): SSEEventPayload[] {
  return slice.persistence.enqueueEvent.mock.calls.map(
    (call) => call[1] as SSEEventPayload,
  );
}

describe("Lane E ordinary completion", () => {
  it("keeps ordinary completion unchanged when no intervention arrives", async () => {
    const slice = makeFullSlice("lane-e-control");
    const execution = slice.executor.startNewExecution(slice.task, agent);
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

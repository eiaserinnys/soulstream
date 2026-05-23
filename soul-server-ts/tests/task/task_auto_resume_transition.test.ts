import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentRegistry } from "../../src/agent_registry.js";
import type { ExecutionContextBuilder } from "../../src/context/context_builder.js";
import type { EventPersistence } from "../../src/db/event_persistence.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { Task } from "../../src/task/task_models.js";
import { AutoResumeTransition } from "../../src/task/task_auto_resume_transition.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

const silentLogger = pino({ level: "silent" });

function makeTerminalTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "s1",
    prompt: "original prompt",
    status: "completed",
    profileId: "codex-default",
    createdAt: new Date("2026-05-23T01:00:00.000Z"),
    completedAt: new Date("2026-05-23T01:05:00.000Z"),
    lastEventId: 7,
    lastReadEventId: 3,
    result: "old result",
    error: "old error",
    interventionQueue: [],
    metadata: [],
    ...overrides,
  };
}

describe("AutoResumeTransition", () => {
  it("persists user_message, queues the running task, updates DB, broadcasts session_updated, and resumes", async () => {
    const order: string[] = [];
    const task = makeTerminalTask();
    const callerInfo = { source: "slack", display_name: "Alice" };

    const appendMetadata = vi.fn(async () => {
      order.push("appendMetadata");
      return 1;
    });
    const updateSession = vi.fn(async (_sessionId, fields) => {
      order.push("updateSession");
      expect(task.status).toBe("running");
      expect(task.interventionQueue).toHaveLength(1);
      expect(fields).toEqual({ status: "running", last_event_id: 101 });
    });
    const db = { appendMetadata, updateSession } as unknown as SessionDB;

    const persistEvent = vi.fn(async (_sessionId, event) => {
      order.push("persistEvent");
      expect(event).toMatchObject({
        type: "user_message",
        user: "alice",
        text: "resume text",
        caller_info: callerInfo,
        attachments: ["/tmp/a.png"],
      });
      expect((event as Record<string, unknown>)._event_id).toBeUndefined();
      return 101;
    });
    const handleSideEffects = vi.fn(async (_sessionId, event, handledTask) => {
      order.push("handleSideEffects");
      expect(handledTask).toBe(task);
      expect(task.lastEventId).toBe(101);
      expect((event as Record<string, unknown>)._event_id).toBe(101);
    });
    const persistence = { persistEvent, handleSideEffects } as unknown as EventPersistence;

    const emitEventEnvelope = vi.fn(async (_sessionId, event) => {
      order.push("emitEventEnvelope");
      expect(event).toMatchObject({
        type: "user_message",
        text: "resume text",
        _event_id: 101,
      });
    });
    const emitSessionUpdated = vi.fn(async (updatedTask) => {
      order.push("emitSessionUpdated");
      expect(updatedTask).toBe(task);
      expect(task.status).toBe("running");
      expect(task.completedAt).toBeUndefined();
      expect(task.result).toBeUndefined();
      expect(task.error).toBeUndefined();
      expect(task.interventionQueue).toHaveLength(1);
    });
    const broadcaster = { emitEventEnvelope, emitSessionUpdated } as unknown as SessionBroadcaster;

    const transition = new AutoResumeTransition({
      db,
      broadcaster,
      logger: silentLogger,
      persistence,
    });
    const onResume = vi.fn((resumedTask: Task) => {
      order.push("onResume");
      expect(resumedTask).toBe(task);
      expect(resumedTask.status).toBe("running");
      expect(resumedTask.interventionQueue).toHaveLength(1);
    });

    await expect(
      transition.resume(task, {
        text: "resume text",
        user: "alice",
        callerInfo,
        attachmentPaths: ["/tmp/a.png"],
      }, onResume),
    ).resolves.toEqual({ autoResumed: true });

    expect(order).toEqual([
      "appendMetadata",
      "persistEvent",
      "handleSideEffects",
      "emitEventEnvelope",
      "updateSession",
      "emitSessionUpdated",
      "onResume",
    ]);
    expect(task.metadata).toContainEqual({ type: "caller_info", value: callerInfo });
    expect(appendMetadata).toHaveBeenCalledWith("s1", {
      type: "caller_info",
      value: callerInfo,
    });
  });

  it("includes resume context in the user_message event when context dependencies are available", async () => {
    const task = makeTerminalTask();
    const contextItem = {
      key: "soulstream_session",
      label: "Soulstream session",
      content: { agent_session_id: "s1" },
    };
    const buildResumeContextItems = vi.fn().mockResolvedValue([contextItem]);
    const contextBuilder = {
      buildResumeContextItems,
    } as unknown as ExecutionContextBuilder;
    const agent = {
      id: "codex-default",
      name: "Codex Default",
      backend: "codex",
      workspace_dir: "/tmp/codex",
    };
    const agentRegistry = { get: vi.fn().mockReturnValue(agent) } as unknown as AgentRegistry;
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const transition = new AutoResumeTransition({
      db: { updateSession: vi.fn(), appendMetadata: vi.fn() } as unknown as SessionDB,
      broadcaster: {
        emitEventEnvelope,
        emitSessionUpdated: vi.fn(),
      } as unknown as SessionBroadcaster,
      logger: silentLogger,
      contextBuilder,
      agentRegistry,
    });

    await transition.resume(task, { text: "resume", user: "u" }, vi.fn());

    expect(buildResumeContextItems).toHaveBeenCalledWith(task, agent);
    expect(emitEventEnvelope.mock.calls[0][1]).toMatchObject({
      type: "user_message",
      context: [contextItem],
    });
  });
});

import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskInitialMessagePublisher } from "../../src/task/task_initial_message_publisher.js";
import type { Task } from "../../src/task/task_models.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-initial",
    prompt: "사용자 요청",
    status: "running",
    createdAt: new Date("2026-05-23T01:00:00.000Z"),
    lastEventId: 3,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}

function makeSubject(options: {
  enqueueEvent?: ReturnType<typeof vi.fn>;
  enqueueRunningTransition?: ReturnType<typeof vi.fn>;
  handleSideEffects?: ReturnType<typeof vi.fn>;
  emitEventEnvelope?: ReturnType<typeof vi.fn>;
} = {}) {
  const enqueueEvent = options.enqueueEvent ?? vi.fn().mockResolvedValue({ source_seq: 77 });
  const enqueueRunningTransition = options.enqueueRunningTransition
    ?? vi.fn().mockResolvedValue({ source_seq: 78 });
  const handleSideEffects = options.handleSideEffects ?? vi.fn().mockResolvedValue(undefined);
  const emitEventEnvelope = options.emitEventEnvelope ?? vi.fn().mockResolvedValue(undefined);
  const logger = { warn: vi.fn() } as unknown as Logger;
  const publisher = new TaskInitialMessagePublisher({
    broadcaster: { emitEventEnvelope } as never,
    logger,
    persistence: { enqueueEvent, enqueueRunningTransition, handleSideEffects } as never,
  });

  return {
    publisher,
    enqueueEvent,
    enqueueRunningTransition,
    handleSideEffects,
    emitEventEnvelope,
    logger,
  };
}

describe("TaskInitialMessagePublisher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-23T03:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("durably enqueues system_message before user_message without worker broadcast", async () => {
    const task = makeTask({
      callerInfo: {
        source: "agent",
        user_id: "roselin",
        display_name: "로젤린",
      },
      attachmentPaths: ["/tmp/incoming/sess/a.png"],
    });
    const {
      publisher,
      enqueueEvent,
      enqueueRunningTransition,
      handleSideEffects,
      emitEventEnvelope,
    } = makeSubject({
      enqueueEvent: vi.fn(async () => ({ source_seq: 11 })),
    });

    await publisher.publishInitialMessages(task, {
      effectiveSystemPrompt: "system prompt",
      combinedContextItems: [{ key: "atom_context", label: "atom", content: "# tree" }],
      assembledPrompt: "사용자 요청",
    });

    expect(enqueueEvent.mock.calls.map((c) => (c[1] as { type: string }).type)).toEqual([
      "system_message",
      "user_message",
    ]);
    expect(enqueueEvent.mock.calls[0][1]).toEqual({
      type: "system_message",
      text: "system prompt",
    });
    expect(enqueueEvent.mock.calls[1][1]).toEqual({
      type: "user_message",
      user: "로젤린",
      text: "사용자 요청",
      timestamp: 1779505200,
      caller_info: task.callerInfo,
      attachments: ["/tmp/incoming/sess/a.png"],
      context: [{ key: "atom_context", label: "atom", content: "# tree" }],
    });
    expect(enqueueEvent.mock.calls[1][2]).toBeUndefined();
    expect(enqueueRunningTransition).toHaveBeenCalledWith("sess-initial", {
      reviewState: "not_required",
      transitionId: "initial",
    });
    expect(enqueueEvent.mock.invocationCallOrder[1]).toBeLessThan(
      enqueueRunningTransition.mock.invocationCallOrder[0]!,
    );
    expect(task.lastEventId).toBe(3);
    expect(emitEventEnvelope).not.toHaveBeenCalled();
    expect(handleSideEffects).toHaveBeenCalledTimes(1);
    expect(handleSideEffects).toHaveBeenCalledWith(
      "sess-initial",
      expect.objectContaining({ type: "user_message" }),
      task,
    );
  });

  it("durably records one context_manifest before the initial timeline messages", async () => {
    const task = makeTask();
    const { publisher, enqueueEvent, emitEventEnvelope } = makeSubject();
    const contextManifest = {
      compiler_version: "phase-a.v1",
      spec_hash: "a".repeat(64),
      source_count: 1,
      total_chars: 120,
      total_token_estimate: 30,
      sources: [{
        id: "node-a",
        label: "atom node: node-a",
        instance: "atom" as const,
        node_id: "node-a",
        mode: "full" as const,
        depth: 5,
        titles_only: false,
        chars: 100,
        token_estimate: 25,
        status: "ok" as const,
        truncated: false,
        anchor_count: 0,
      }],
    };

    await publisher.publishInitialMessages(task, {
      effectiveSystemPrompt: "system prompt",
      combinedContextItems: [],
      assembledPrompt: "사용자 요청",
      contextManifest,
    });

    expect(enqueueEvent.mock.calls.map((call) => (call[1] as { type: string }).type)).toEqual([
      "context_manifest",
      "system_message",
      "user_message",
    ]);
    expect(enqueueEvent.mock.calls[0]?.[1]).toEqual({
      type: "context_manifest",
      ...contextManifest,
    });
    expect(emitEventEnvelope).not.toHaveBeenCalled();
  });

  it("continues system and user message persistence when context_manifest enqueue fails", async () => {
    const task = makeTask();
    const enqueueEvent = vi
      .fn()
      .mockRejectedValueOnce(new Error("manifest outbox down"))
      .mockResolvedValue({ source_seq: 12 });
    const { publisher, handleSideEffects, logger } = makeSubject({ enqueueEvent });

    await publisher.publishInitialMessages(task, {
      effectiveSystemPrompt: "system prompt",
      combinedContextItems: [],
      assembledPrompt: "사용자 요청",
      contextManifest: {
        compiler_version: "phase-a.v1",
        spec_hash: "b".repeat(64),
        source_count: 0,
        total_chars: 0,
        total_token_estimate: 0,
        sources: [],
      },
    });

    expect(enqueueEvent.mock.calls.map((call) => (call[1] as { type: string }).type)).toEqual([
      "context_manifest",
      "system_message",
      "user_message",
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-initial", err: expect.any(Error) }),
      "context_manifest persistence failed — continuing session start",
    );
    expect(handleSideEffects).toHaveBeenCalledOnce();
  });

  it("skips system_message and omits optional user_message keys when inputs are absent", async () => {
    const task = makeTask();
    const { publisher, enqueueEvent, emitEventEnvelope } = makeSubject();

    await publisher.publishInitialMessages(task, {
      combinedContextItems: [],
      assembledPrompt: "사용자 요청",
    });

    expect(enqueueEvent).toHaveBeenCalledTimes(1);
    expect(enqueueEvent.mock.calls[0][1]).toEqual({
      type: "user_message",
      user: "unknown",
      text: "사용자 요청",
      timestamp: 1779505200,
    });
    expect(emitEventEnvelope).not.toHaveBeenCalled();
    const userEvent = enqueueEvent.mock.calls[0][1] as Record<string, unknown>;
    expect(userEvent.caller_info).toBeUndefined();
    expect(userEvent.attachments).toBeUndefined();
    expect(userEvent.context).toBeUndefined();
  });

  it("persists the server-assembled initial instruction verbatim as the first user_message", async () => {
    const assembledPrompt =
      "업무 현황을 파악한 후, 사용자의 다음 지시를 이행해주세요.\n결과를 표로 정리해줘.";
    const task = makeTask({ prompt: assembledPrompt });
    const { publisher, enqueueEvent, enqueueRunningTransition } = makeSubject();

    await publisher.publishInitialMessages(task);

    expect(enqueueEvent).toHaveBeenCalledWith(
      "sess-initial",
      expect.objectContaining({
        type: "user_message",
        text: assembledPrompt,
      }),
    );
    expect(enqueueRunningTransition).toHaveBeenCalledTimes(1);
  });

  it("uses user contextItems but hides resolver markers when prepared context is absent", async () => {
    const task = makeTask({
      contextItems: [
        { key: "page_context_sources", content: { pages: [] } },
        { key: "atom_context_sources", content: { nodes: [] } },
        { key: "handover", label: "Handover", content: "done" },
      ],
    });
    const { publisher, enqueueEvent, enqueueRunningTransition, emitEventEnvelope } = makeSubject();

    await publisher.publishInitialMessages(task);

    expect(enqueueEvent).toHaveBeenCalledWith(
      "sess-initial",
      expect.objectContaining({
        type: "user_message",
        context: [{ key: "handover", label: "Handover", content: "done" }],
      }),
    );
    expect(enqueueRunningTransition).toHaveBeenCalledTimes(1);
    expect(emitEventEnvelope).not.toHaveBeenCalled();
  });

  it("stops the initial turn when system_message durable enqueue fails", async () => {
    const task = makeTask();
    const {
      publisher,
      enqueueEvent,
      handleSideEffects,
      emitEventEnvelope,
      logger,
    } = makeSubject({
      enqueueEvent: vi
        .fn()
        .mockRejectedValueOnce(new Error("outbox down")),
    });

    await expect(publisher.publishInitialMessages(task, {
      effectiveSystemPrompt: "system prompt",
      combinedContextItems: [],
      assembledPrompt: "사용자 요청",
    })).rejects.toThrow("outbox down");

    expect(enqueueEvent).toHaveBeenCalledTimes(1);
    expect(task.lastEventId).toBe(3);
    expect(emitEventEnvelope).not.toHaveBeenCalled();
    expect(handleSideEffects).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("stops the initial turn when user_message durable enqueue fails", async () => {
    const task = makeTask();
    const {
      publisher,
      enqueueEvent,
      handleSideEffects,
      emitEventEnvelope,
      logger,
    } = makeSubject({
      enqueueEvent: vi.fn().mockRejectedValue(new Error("outbox down")),
      emitEventEnvelope: vi.fn().mockRejectedValue(new Error("wire down")),
      handleSideEffects: vi.fn().mockRejectedValue(new Error("side effect down")),
    });

    await expect(publisher.publishInitialMessages(task)).rejects.toThrow("outbox down");

    expect(task.lastEventId).toBe(3);
    expect(enqueueEvent).toHaveBeenCalledWith(
      "sess-initial",
      expect.not.objectContaining({ _event_id: expect.anything() }),
    );
    expect(emitEventEnvelope).not.toHaveBeenCalled();
    expect(handleSideEffects).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

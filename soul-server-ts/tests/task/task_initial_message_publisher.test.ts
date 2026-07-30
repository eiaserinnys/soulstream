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
  persistEvent?: ReturnType<typeof vi.fn>;
  handleSideEffects?: ReturnType<typeof vi.fn>;
  emitEventEnvelope?: ReturnType<typeof vi.fn>;
} = {}) {
  const persistEvent = options.persistEvent ?? vi.fn().mockResolvedValue(77);
  const handleSideEffects = options.handleSideEffects ?? vi.fn().mockResolvedValue(undefined);
  const emitEventEnvelope = options.emitEventEnvelope ?? vi.fn().mockResolvedValue(undefined);
  const logger = { warn: vi.fn() } as unknown as Logger;
  const publisher = new TaskInitialMessagePublisher({
    broadcaster: { emitEventEnvelope } as never,
    logger,
    persistence: { persistEvent, handleSideEffects } as never,
  });

  return {
    publisher,
    persistEvent,
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

  it("publishes system_message before user_message with Python parity payload keys", async () => {
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
      persistEvent,
      handleSideEffects,
      emitEventEnvelope,
    } = makeSubject({
      persistEvent: vi.fn(async (_sessionId, event) => {
        expect((event as Record<string, unknown>)._event_id).toBeUndefined();
        return ((event as { type: string }).type === "system_message") ? 10 : 11;
      }),
    });

    await publisher.publishInitialMessages(task, {
      effectiveSystemPrompt: "system prompt",
      combinedContextItems: [{ key: "atom_context", label: "atom", content: "# tree" }],
      assembledPrompt: "사용자 요청",
    });

    expect(persistEvent.mock.calls.map((c) => (c[1] as { type: string }).type)).toEqual([
      "system_message",
      "user_message",
    ]);
    expect(persistEvent.mock.calls[0][1]).toEqual({
      type: "system_message",
      text: "system prompt",
      _event_id: 10,
    });
    expect(persistEvent.mock.calls[1][1]).toEqual({
      type: "user_message",
      user: "로젤린",
      text: "사용자 요청",
      timestamp: 1779505200,
      caller_info: task.callerInfo,
      attachments: ["/tmp/incoming/sess/a.png"],
      context: [{ key: "atom_context", label: "atom", content: "# tree" }],
      _event_id: 11,
    });
    expect(task.lastEventId).toBe(11);
    expect(emitEventEnvelope.mock.calls.map((c) => (c[1] as { type: string }).type)).toEqual([
      "system_message",
      "user_message",
    ]);
    expect(handleSideEffects).toHaveBeenCalledTimes(1);
    expect(handleSideEffects).toHaveBeenCalledWith(
      "sess-initial",
      expect.objectContaining({ type: "user_message", _event_id: 11 }),
      task,
    );
  });

  it("skips system_message and omits optional user_message keys when inputs are absent", async () => {
    const task = makeTask();
    const { publisher, persistEvent, emitEventEnvelope } = makeSubject();

    await publisher.publishInitialMessages(task, {
      combinedContextItems: [],
      assembledPrompt: "사용자 요청",
    });

    expect(persistEvent).toHaveBeenCalledTimes(1);
    expect(persistEvent.mock.calls[0][1]).toEqual({
      type: "user_message",
      user: "unknown",
      text: "사용자 요청",
      timestamp: 1779505200,
      _event_id: 77,
    });
    const userEvent = emitEventEnvelope.mock.calls[0][1] as Record<string, unknown>;
    expect(userEvent.caller_info).toBeUndefined();
    expect(userEvent.attachments).toBeUndefined();
    expect(userEvent.context).toBeUndefined();
  });

  it("persists the server-assembled initial instruction verbatim as the first user_message", async () => {
    const assembledPrompt =
      "업무 현황을 파악한 후, 사용자의 다음 지시를 이행해주세요.\n결과를 표로 정리해줘.";
    const task = makeTask({ prompt: assembledPrompt });
    const { publisher, persistEvent } = makeSubject();

    await publisher.publishInitialMessages(task);

    expect(persistEvent).toHaveBeenCalledWith(
      "sess-initial",
      expect.objectContaining({
        type: "user_message",
        text: assembledPrompt,
      }),
    );
  });

  it("uses user contextItems but hides resolver markers when prepared context is absent", async () => {
    const task = makeTask({
      contextItems: [
        { key: "page_context_sources", content: { pages: [] } },
        { key: "atom_context_sources", content: { nodes: [] } },
        { key: "handover", label: "Handover", content: "done" },
      ],
    });
    const { publisher, persistEvent, emitEventEnvelope } = makeSubject();

    await publisher.publishInitialMessages(task);

    expect(persistEvent).toHaveBeenCalledWith(
      "sess-initial",
      expect.objectContaining({
        type: "user_message",
        context: [{ key: "handover", label: "Handover", content: "done" }],
      }),
    );
    expect(emitEventEnvelope).toHaveBeenCalledWith(
      "sess-initial",
      expect.objectContaining({
        type: "user_message",
        context: [{ key: "handover", label: "Handover", content: "done" }],
      }),
    );
  });

  it("isolates system_message persistence failure and still publishes user_message", async () => {
    const task = makeTask();
    const {
      publisher,
      persistEvent,
      handleSideEffects,
      emitEventEnvelope,
      logger,
    } = makeSubject({
      persistEvent: vi
        .fn()
        .mockRejectedValueOnce(new Error("system db down"))
        .mockResolvedValueOnce(42),
    });

    await publisher.publishInitialMessages(task, {
      effectiveSystemPrompt: "system prompt",
      combinedContextItems: [],
      assembledPrompt: "사용자 요청",
    });

    expect(persistEvent).toHaveBeenCalledTimes(2);
    expect(task.lastEventId).toBe(42);
    expect(emitEventEnvelope).toHaveBeenCalledWith(
      "sess-initial",
      { type: "system_message", text: "system prompt" },
    );
    expect(emitEventEnvelope).toHaveBeenCalledWith(
      "sess-initial",
      expect.objectContaining({ type: "user_message", _event_id: 42 }),
    );
    expect(handleSideEffects).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-initial" }),
      "system_message persistEvent failed",
    );
  });

  it("isolates user_message persistence, broadcast, and side-effect failures independently", async () => {
    const task = makeTask();
    const {
      publisher,
      persistEvent,
      handleSideEffects,
      emitEventEnvelope,
      logger,
    } = makeSubject({
      persistEvent: vi.fn().mockRejectedValue(new Error("user db down")),
      emitEventEnvelope: vi.fn().mockRejectedValue(new Error("wire down")),
      handleSideEffects: vi.fn().mockRejectedValue(new Error("side effect down")),
    });

    await publisher.publishInitialMessages(task);

    expect(task.lastEventId).toBe(3);
    expect(persistEvent).toHaveBeenCalledWith(
      "sess-initial",
      expect.not.objectContaining({ _event_id: expect.anything() }),
    );
    expect(emitEventEnvelope).toHaveBeenCalledWith(
      "sess-initial",
      expect.not.objectContaining({ _event_id: expect.anything() }),
    );
    expect(handleSideEffects).toHaveBeenCalledWith(
      "sess-initial",
      expect.not.objectContaining({ _event_id: expect.anything() }),
      task,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-initial" }),
      "user_message persistEvent failed",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-initial" }),
      "user_message broadcast failed",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-initial" }),
      "user_message handleSideEffects failed",
    );
  });
});

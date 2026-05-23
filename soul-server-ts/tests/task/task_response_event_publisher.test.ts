import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ResponseEventPublisher } from "../../src/task/task_response_event_publisher.js";
import type { Task } from "../../src/task/task_models.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-response",
    prompt: "waiting for response",
    status: "running",
    createdAt: new Date("2026-05-23T01:00:00.000Z"),
    lastEventId: 7,
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
  const publisher = new ResponseEventPublisher({
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

describe("ResponseEventPublisher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-23T03:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes input_request_responded with explicit payload keys and _event_id ride-along", async () => {
    const task = makeTask();
    let eventAtPersist: Record<string, unknown> | undefined;
    const {
      publisher,
      persistEvent,
      handleSideEffects,
      emitEventEnvelope,
    } = makeSubject({
      persistEvent: vi.fn(async (_sessionId, event) => {
        eventAtPersist = { ...(event as Record<string, unknown>) };
        expect((event as Record<string, unknown>)._event_id).toBeUndefined();
        return 77;
      }),
    });

    await expect(
      publisher.publishInputRequestResponded(task, "ask-1"),
    ).resolves.toBe(77);

    expect(persistEvent).toHaveBeenCalledWith("sess-response", expect.any(Object));
    expect(eventAtPersist).toEqual({
      type: "input_request_responded",
      request_id: "ask-1",
      timestamp: 1779505200,
    });
    expect(task.lastEventId).toBe(77);
    expect(handleSideEffects).toHaveBeenCalledWith(
      "sess-response",
      {
        type: "input_request_responded",
        request_id: "ask-1",
        timestamp: 1779505200,
        _event_id: 77,
      },
      task,
    );
    expect(emitEventEnvelope).toHaveBeenCalledWith(
      "sess-response",
      {
        type: "input_request_responded",
        request_id: "ask-1",
        timestamp: 1779505200,
        _event_id: 77,
      },
    );
  });

  it("publishes tool_approval_resolved with approval payload keys and public eventId result", async () => {
    const task = makeTask();
    let eventAtPersist: Record<string, unknown> | undefined;
    const {
      publisher,
      persistEvent,
      handleSideEffects,
      emitEventEnvelope,
    } = makeSubject({
      persistEvent: vi.fn(async (_sessionId, event) => {
        eventAtPersist = { ...(event as Record<string, unknown>) };
        expect((event as Record<string, unknown>)._event_id).toBeUndefined();
        return 77;
      }),
    });

    await expect(publisher.publishToolApprovalResolved(task, {
      approvalId: "approval-1",
      decision: "rejected",
      message: "no prod write",
    })).resolves.toBe(77);

    const expectedEvent = {
      type: "tool_approval_resolved",
      approval_id: "approval-1",
      decision: "rejected",
      approved: false,
      rejected: true,
      timestamp: 1779505200,
      message: "no prod write",
    };
    expect(persistEvent).toHaveBeenCalledWith("sess-response", expect.any(Object));
    expect(eventAtPersist).toEqual(expectedEvent);
    expect(task.lastEventId).toBe(77);
    expect(handleSideEffects).toHaveBeenCalledWith(
      "sess-response",
      { ...expectedEvent, _event_id: 77 },
      task,
    );
    expect(emitEventEnvelope).toHaveBeenCalledWith(
      "sess-response",
      { ...expectedEvent, _event_id: 77 },
    );
  });

  it("keeps eventId undefined and still broadcasts when persistence is unavailable", async () => {
    const task = makeTask();
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const logger = { warn: vi.fn() } as unknown as Logger;
    const publisher = new ResponseEventPublisher({
      broadcaster: { emitEventEnvelope } as never,
      logger,
    });

    await expect(
      publisher.publishInputRequestResponded(task, "ask-1"),
    ).resolves.toBeUndefined();

    expect(task.lastEventId).toBe(7);
    expect(emitEventEnvelope).toHaveBeenCalledWith(
      "sess-response",
      expect.not.objectContaining({ _event_id: expect.anything() }),
    );
  });

  it("isolates persistence failure and broadcasts without _event_id", async () => {
    const task = makeTask();
    const {
      publisher,
      persistEvent,
      handleSideEffects,
      emitEventEnvelope,
      logger,
    } = makeSubject({
      persistEvent: vi.fn().mockRejectedValue(new Error("db down")),
    });
    const warn = logger.warn as ReturnType<typeof vi.fn>;

    await expect(
      publisher.publishInputRequestResponded(task, "ask-1"),
    ).resolves.toBeUndefined();

    expect(persistEvent).toHaveBeenCalled();
    expect(handleSideEffects).not.toHaveBeenCalled();
    expect(task.lastEventId).toBe(7);
    expect(emitEventEnvelope).toHaveBeenCalledWith(
      "sess-response",
      expect.not.objectContaining({ _event_id: expect.anything() }),
    );
    expect(warn).toHaveBeenCalledWith(
      { err: expect.any(Error), sessionId: "sess-response", requestId: "ask-1" },
      "input_request_responded persistence failed",
    );
  });

  it("isolates broadcast failure without changing the persisted eventId result", async () => {
    const task = makeTask();
    const {
      publisher,
      emitEventEnvelope,
      logger,
    } = makeSubject({
      emitEventEnvelope: vi.fn().mockRejectedValue(new Error("subscriber gone")),
    });
    const warn = logger.warn as ReturnType<typeof vi.fn>;

    await expect(publisher.publishToolApprovalResolved(task, {
      approvalId: "approval-1",
      decision: "approved",
    })).resolves.toBe(77);

    expect(task.lastEventId).toBe(77);
    expect(emitEventEnvelope).toHaveBeenCalledWith(
      "sess-response",
      expect.objectContaining({
        type: "tool_approval_resolved",
        approval_id: "approval-1",
        decision: "approved",
        approved: true,
        rejected: false,
        _event_id: 77,
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      { err: expect.any(Error), sessionId: "sess-response", approvalId: "approval-1" },
      "tool_approval_resolved broadcast failed",
    );
  });
});

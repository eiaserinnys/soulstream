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
  enqueueEventAndWaitForSessionAck?: ReturnType<typeof vi.fn>;
  handleSideEffects?: ReturnType<typeof vi.fn>;
  emitEventEnvelope?: ReturnType<typeof vi.fn>;
} = {}) {
  const enqueueEventAndWaitForSessionAck = options.enqueueEventAndWaitForSessionAck
    ?? vi.fn().mockResolvedValue({ record: { source_seq: 1 }, eventId: 77 });
  const handleSideEffects = options.handleSideEffects ?? vi.fn().mockResolvedValue(undefined);
  const emitEventEnvelope = options.emitEventEnvelope ?? vi.fn().mockResolvedValue(undefined);
  const logger = { warn: vi.fn() } as unknown as Logger;
  const publisher = new ResponseEventPublisher({
    broadcaster: { emitEventEnvelope } as never,
    logger,
    persistence: { enqueueEventAndWaitForSessionAck, handleSideEffects } as never,
  });

  return {
    publisher,
    enqueueEventAndWaitForSessionAck,
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

  it("waits for ACK before returning the input_request_responded DB event id", async () => {
    const task = makeTask();
    let eventAtPersist: Record<string, unknown> | undefined;
    const {
      publisher,
      enqueueEventAndWaitForSessionAck,
      handleSideEffects,
      emitEventEnvelope,
    } = makeSubject({
      enqueueEventAndWaitForSessionAck: vi.fn(async (_sessionId, event) => {
        eventAtPersist = { ...(event as Record<string, unknown>) };
        expect((event as Record<string, unknown>)._event_id).toBeUndefined();
        return { record: { source_seq: 1 }, eventId: 77 };
      }),
    });

    await expect(
      publisher.publishInputRequestResponded(task, "ask-1"),
    ).resolves.toBe(77);

    expect(enqueueEventAndWaitForSessionAck).toHaveBeenCalledWith(
      "sess-response",
      expect.any(Object),
    );
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
      },
      task,
    );
    expect(emitEventEnvelope).not.toHaveBeenCalled();
  });

  it("publishes tool_approval_resolved with approval payload keys and public eventId result", async () => {
    const task = makeTask();
    let eventAtPersist: Record<string, unknown> | undefined;
    const {
      publisher,
      enqueueEventAndWaitForSessionAck,
      handleSideEffects,
      emitEventEnvelope,
    } = makeSubject({
      enqueueEventAndWaitForSessionAck: vi.fn(async (_sessionId, event) => {
        eventAtPersist = { ...(event as Record<string, unknown>) };
        expect((event as Record<string, unknown>)._event_id).toBeUndefined();
        return { record: { source_seq: 1 }, eventId: 77 };
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
    expect(enqueueEventAndWaitForSessionAck).toHaveBeenCalledWith(
      "sess-response",
      expect.any(Object),
    );
    expect(eventAtPersist).toEqual(expectedEvent);
    expect(task.lastEventId).toBe(77);
    expect(handleSideEffects).toHaveBeenCalledWith(
      "sess-response",
      expectedEvent,
      task,
    );
    expect(emitEventEnvelope).not.toHaveBeenCalled();
  });

  it("fails explicitly when durable persistence is unavailable", async () => {
    const task = makeTask();
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const logger = { warn: vi.fn() } as unknown as Logger;
    const publisher = new ResponseEventPublisher({
      broadcaster: { emitEventEnvelope } as never,
      logger,
    });

    await expect(
      publisher.publishInputRequestResponded(task, "ask-1"),
    ).rejects.toThrow("response durable event persistence is required");

    expect(task.lastEventId).toBe(7);
    expect(emitEventEnvelope).not.toHaveBeenCalled();
  });

  it("propagates durable ingress failure without worker broadcast", async () => {
    const task = makeTask();
    const {
      publisher,
      enqueueEventAndWaitForSessionAck,
      handleSideEffects,
      emitEventEnvelope,
      logger,
    } = makeSubject({
      enqueueEventAndWaitForSessionAck: vi.fn().mockRejectedValue(new Error("outbox down")),
    });
    const warn = logger.warn as ReturnType<typeof vi.fn>;

    await expect(
      publisher.publishInputRequestResponded(task, "ask-1"),
    ).rejects.toThrow("outbox down");

    expect(enqueueEventAndWaitForSessionAck).toHaveBeenCalled();
    expect(handleSideEffects).not.toHaveBeenCalled();
    expect(task.lastEventId).toBe(7);
    expect(emitEventEnvelope).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      { err: expect.any(Error), sessionId: "sess-response", requestId: "ask-1" },
      "input_request_responded persistence failed",
    );
  });

});

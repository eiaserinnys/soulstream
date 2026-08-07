import { describe, expect, it, vi } from "vitest";

import { NodeEventIngressController } from "../src/node/event_ingress_controller.js";
import { EventIngressProtocolConflict } from "../src/node/event_ingress_repository.js";
import type { EventAppendBatch } from "../src/node/event_ingress_types.js";

const STREAM_ID = "018f47b7-c6de-7d64-9c8d-0b62cbbb2e10";

describe("NodeEventIngressController", () => {
  it("serializes batches per connection and ACKs only after committed broadcast attempts", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const commitBatch = vi.fn(async (_nodeId: string, value: EventAppendBatch) => {
      order.push(`commit-${value.first_seq}`);
      if (value.first_seq === 1) await firstGate;
      return value.events.map((envelope) => ({
        envelope,
        eventId: envelope.source_seq + 100,
        duplicateReceipt: false,
      }));
    });
    const sent: Array<Record<string, unknown>> = [];
    const controller = createController({
      committer: { commitBatch },
      publish: () => order.push("broadcast"),
      send: (frame: Record<string, unknown>) => {
        order.push("ack");
        sent.push(frame);
      },
    });

    controller.enqueue(batch(1));
    controller.enqueue(batch(2));
    await vi.waitFor(() => expect(commitBatch).toHaveBeenCalledTimes(1));
    releaseFirst();
    await controller.drain();

    expect(order).toEqual([
      "commit-1", "broadcast", "ack",
      "commit-2", "broadcast", "ack",
    ]);
    expect(sent).toEqual([
      { type: "event_append_ack", stream_id: STREAM_ID, acked_through: 1,
        events: [{ source_seq: 1, event_id: 101 }] },
      { type: "event_append_ack", stream_id: STREAM_ID, acked_through: 2,
        events: [{ source_seq: 2, event_id: 102 }] },
    ]);
  });

  it("sends status 409 and closes without ACK on receipt conflict", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const close = vi.fn();
    const controller = createController({
      committer: {
        commitBatch: vi.fn(async () => {
          throw new EventIngressProtocolConflict("hash differs");
        }),
      },
      send: (frame: Record<string, unknown>) => sent.push(frame),
      close,
    });

    controller.enqueue(batch(1));
    await controller.drain();

    expect(sent).toEqual([expect.objectContaining({
      type: "error",
      status: 409,
      code: "EVENT_INGRESS_PROTOCOL_CONFLICT",
    })]);
    expect(close).toHaveBeenCalledWith(1008, "event ingress protocol conflict");
  });

  it("publishes the committed session effect before sending the ACK", async () => {
    const order: string[] = [];
    const value = batch(1);
    value.events[0]!.session_effect = {
      kind: "terminal_transition",
      status: "completed",
      termination_reason: "completed",
      termination_detail: null,
      review_state: "not_required",
      last_assistant_text: "fresh final answer",
      updated_at: "2026-08-06T00:00:00.000Z",
    };
    const received: Array<Record<string, unknown>> = [];
    const controller = createController({
      committer: {
        commitBatch: vi.fn(async () => [{
          envelope: value.events[0]!,
          eventId: 101,
          duplicateReceipt: false,
        }]),
      },
      receiveCommittedEvent: (message: Record<string, unknown>) => {
        received.push(message);
        return [];
      },
      publish: () => order.push("publish"),
      send: () => order.push("ack"),
    });

    controller.enqueue(value as unknown as Record<string, unknown>);
    await controller.drain();

    expect(received).toEqual([
      expect.objectContaining({ type: "event", agentSessionId: "session-a" }),
      {
        type: "session_updated",
        agentSessionId: "session-a",
        status: "completed",
        termination_reason: "completed",
        termination_detail: null,
        review_state: "not_required",
        last_assistant_text: "fresh final answer",
        updated_at: "2026-08-06T00:00:00.000Z",
        last_event_id: 101,
      },
    ]);
    expect(order.at(-1)).toBe("ack");
  });

  it("projects a terminal effect into session cache before publishing session_ended", async () => {
    const value = batch(1);
    value.events[0]!.event_type = "session_ended";
    value.events[0]!.payload = {
      type: "session_ended",
      status: "completed",
      termination_reason: "completed_ok",
    };
    value.events[0]!.session_effect = {
      kind: "terminal_transition",
      status: "completed",
      termination_reason: "completed_ok",
      termination_detail: null,
      review_state: "not_required",
      last_assistant_text: "fresh final answer",
      updated_at: "2026-08-06T00:00:00.000Z",
    };
    const session = { last_assistant_text: "previous turn" };
    const completionBodies: string[] = [];
    const controller = createController({
      committer: {
        commitBatch: vi.fn(async () => [{
          envelope: value.events[0]!,
          eventId: 101,
          duplicateReceipt: false,
        }]),
      },
      receiveCommittedEvent: (message: Record<string, unknown>) => {
        if (message.type === "session_updated") {
          session.last_assistant_text = String(message.last_assistant_text ?? "");
          return [{ type: "node_session_session_updated", nodeId: "node-a", data: message }];
        }
        return [{ type: "node_session_event", nodeId: "node-a", data: message }];
      },
      publish: (events: Array<{ type: string }>) => {
        if (events.some((event) => event.type === "node_session_event")) {
          completionBodies.push(session.last_assistant_text);
        }
      },
    });

    controller.enqueue(value as unknown as Record<string, unknown>);
    await controller.drain();

    expect(completionBodies).toEqual(["fresh final answer"]);
  });

  it("rejects malformed typed effects before the repository", async () => {
    const commitBatch = vi.fn();
    const close = vi.fn();
    const controller = createController({ committer: { commitBatch }, close });
    const invalid = batch(1) as unknown as Record<string, unknown>;
    const events = invalid.events as Array<Record<string, unknown>>;
    events[0]!.session_effect = { kind: "set_backend_session_id" };

    controller.enqueue(invalid);
    await controller.drain();

    expect(commitBatch).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(1008, "invalid event ingress batch");
  });

  it("rejects non-contiguous batches before calling the repository", async () => {
    const commitBatch = vi.fn();
    const sent: Array<Record<string, unknown>> = [];
    const close = vi.fn();
    const controller = createController({
      committer: { commitBatch },
      send: (frame: Record<string, unknown>) => sent.push(frame),
      close,
    });
    const invalid = batch(1);
    invalid.events[0]!.source_seq = 2;

    controller.enqueue(invalid as unknown as Record<string, unknown>);
    await controller.drain();

    expect(commitBatch).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ status: 400, code: "EVENT_INGRESS_INVALID" });
    expect(close).toHaveBeenCalledWith(1008, "invalid event ingress batch");
  });

  it("rejects a multi-event batch larger than 256 KiB", async () => {
    const commitBatch = vi.fn();
    const sent: Array<Record<string, unknown>> = [];
    const close = vi.fn();
    const controller = createController({
      committer: { commitBatch },
      send: (frame: Record<string, unknown>) => sent.push(frame),
      close,
    });
    const oversized = batch(1);
    oversized.events[0]!.payload = { content: "x".repeat(130 * 1024) };
    oversized.events.push({
      ...oversized.events[0]!,
      source_seq: 2,
      payload: { content: "x".repeat(130 * 1024) },
    });

    controller.enqueue(oversized as unknown as Record<string, unknown>);
    await controller.drain();

    expect(commitBatch).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ status: 400, code: "EVENT_INGRESS_INVALID" });
    expect(close).toHaveBeenCalledWith(1008, "invalid event ingress batch");
  });

  it("rejects a single event larger than 2 MiB", async () => {
    const commitBatch = vi.fn();
    const sent: Array<Record<string, unknown>> = [];
    const close = vi.fn();
    const controller = createController({
      committer: { commitBatch },
      send: (frame: Record<string, unknown>) => sent.push(frame),
      close,
    });
    const oversized = batch(1);
    oversized.events[0]!.payload = { content: "x".repeat(2 * 1024 * 1024) };

    controller.enqueue(oversized as unknown as Record<string, unknown>);
    await controller.drain();

    expect(commitBatch).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ status: 400, code: "EVENT_INGRESS_INVALID" });
    expect(close).toHaveBeenCalledWith(1008, "invalid event ingress batch");
  });
});

function createController(overrides: Record<string, unknown>) {
  return new NodeEventIngressController({
    nodeId: "node-a",
    connectionId: "connection-a",
    isCurrentConnection: () => true,
    committer: { commitBatch: vi.fn(async () => []) },
    receiveCommittedEvent: (message) => [{
      type: "node_session_event",
      nodeId: "node-a",
      data: message,
    }],
    publish: () => undefined,
    send: () => undefined,
    close: () => undefined,
    logError: () => undefined,
    ...overrides,
  } as ConstructorParameters<typeof NodeEventIngressController>[0]);
}

function batch(sourceSeq: number): EventAppendBatch {
  return {
    type: "event_append_batch",
    protocol_version: 1,
    stream_id: STREAM_ID,
    first_seq: sourceSeq,
    events: [{
      stream_id: STREAM_ID,
      source_seq: sourceSeq,
      session_id: "session-a",
      event_type: "assistant_message",
      payload: { type: "assistant_message", content: "done" },
      searchable_text: "done",
      created_at: "2026-08-06T00:00:00.000Z",
      semantic_dedupe_key: null,
      session_effect: null,
      payload_hash: "a".repeat(64),
    }],
  };
}

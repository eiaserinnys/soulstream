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

  it("rejects a serialized batch larger than 256 KiB", async () => {
    const commitBatch = vi.fn();
    const sent: Array<Record<string, unknown>> = [];
    const close = vi.fn();
    const controller = createController({
      committer: { commitBatch },
      send: (frame: Record<string, unknown>) => sent.push(frame),
      close,
    });
    const oversized = batch(1);
    oversized.events[0]!.payload = { content: "x".repeat(256 * 1024) };

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

import { describe, expect, it, vi } from "vitest";

import type { EventOutboxBatch } from "../src/upstream/event_outbox.js";
import { EventOutboxPump } from "../src/upstream/event_outbox_pump.js";
import { EventOutboxPumpMux } from "../src/upstream/event_outbox_pump_mux.js";

describe("EventOutboxPumpMux", () => {
  it("routes batches and ACKs by stream_id without repackaging", async () => {
    const primaryStore = makeStore("node-stream");
    const runnerStore = makeStore("runner-stream");
    const primary = new EventOutboxPump(primaryStore, vi.fn());
    const runner = new EventOutboxPump(runnerStore, vi.fn());
    const mux = new EventOutboxPumpMux(primary);
    const sent: EventOutboxBatch[] = [];
    mux.register(runner);

    mux.connect(async (batch) => { sent.push(batch); });
    primary.notifyAvailable();
    runner.notifyAvailable();
    await vi.waitFor(() => expect(sent).toHaveLength(2));

    await mux.handleAck(ack("runner-stream", 1, 91));
    expect(runnerStore.acknowledge).toHaveBeenCalledWith("runner-stream", 1);
    expect(primaryStore.acknowledge).not.toHaveBeenCalled();
    expect(sent.map((batch) => batch.stream_id).sort()).toEqual([
      "node-stream",
      "runner-stream",
    ]);
  });

  it("connects a runner registered after the upstream socket is already live", async () => {
    const primary = new EventOutboxPump(makeStore("node-stream"), vi.fn());
    const runnerStore = makeStore("runner-stream");
    const runner = new EventOutboxPump(runnerStore, vi.fn());
    const mux = new EventOutboxPumpMux(primary);
    const sent: EventOutboxBatch[] = [];
    mux.connect(async (batch) => { sent.push(batch); });

    const unregister = mux.register(runner);
    runner.notifyAvailable();
    await vi.waitFor(() => expect(sent.some((batch) => batch.stream_id === "runner-stream")).toBe(true));
    unregister();
  });
});

function makeStore(streamId: string) {
  let listener = () => {};
  let acknowledgedThrough = 0;
  const batch: EventOutboxBatch = {
    type: "event_append_batch",
    protocol_version: 1,
    stream_id: streamId,
    first_seq: 1,
    events: [{
      stream_id: streamId,
      source_seq: 1,
      session_id: `${streamId}-session`,
      event_type: "complete",
      payload: { type: "complete" },
      searchable_text: "",
      created_at: "2026-08-11T00:00:00.000Z",
      semantic_dedupe_key: null,
      session_effect: null,
      payload_hash: "a".repeat(64),
    }],
  };
  return {
    streamId,
    get ackedSeq() { return acknowledgedThrough; },
    onAppend(callback: () => void) {
      listener = callback;
      return () => { listener = () => {}; };
    },
    async readBatch() { return acknowledgedThrough >= 1 ? null : batch; },
    acknowledge: vi.fn(async (_streamId: string, sourceSeq: number) => {
      acknowledgedThrough = Math.max(acknowledgedThrough, sourceSeq);
    }),
    notify() { listener(); },
  };
}

function ack(streamId: string, sourceSeq: number, eventId: number) {
  return {
    type: "event_append_ack" as const,
    stream_id: streamId,
    acked_through: sourceSeq,
    events: [{ source_seq: sourceSeq, event_id: eventId }],
  };
}

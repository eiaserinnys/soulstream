import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EventOutbox, type EventOutboxBatch } from "../src/upstream/event_outbox.js";
import { EventOutboxPump } from "../src/upstream/event_outbox_pump.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("EventOutboxPump", () => {
  it("does not read and send the same batch concurrently", async () => {
    const outbox = await createOutbox();
    await outbox.append(eventInput("one"));
    const originalReadBatch = outbox.readBatch.bind(outbox);
    let releaseRead: (() => void) | undefined;
    const readBlocked = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readBatch = vi.spyOn(outbox, "readBatch").mockImplementation(async () => {
      await readBlocked;
      return await originalReadBatch();
    });
    const sent: EventOutboxBatch[] = [];
    const pump = new EventOutboxPump(outbox, vi.fn());

    pump.connect(async (batch) => sent.push(batch));
    await waitFor(() => readBatch.mock.calls.length === 1);
    await outbox.append(eventInput("two"));
    await new Promise((resolve) => setImmediate(resolve));
    releaseRead?.();
    await waitFor(() => sent.length > 0);
    await Promise.resolve();

    expect(readBatch).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });

  it("keeps one batch in flight and flushes the next only after ACK", async () => {
    const outbox = await createOutbox();
    await outbox.append(eventInput("one"));
    await outbox.append(eventInput("two"));
    const sent: EventOutboxBatch[] = [];
    const pump = new EventOutboxPump(outbox, vi.fn());
    pump.connect(async (batch) => {
      sent.push(batch);
    });
    await waitFor(() => sent.length === 1);

    await outbox.append(eventInput("three"));
    await Promise.resolve();
    expect(sent).toHaveLength(1);

    const first = sent[0]!;
    await pump.handleAck({
      type: "event_append_ack",
      stream_id: outbox.streamId,
      acked_through: first.events.at(-1)!.source_seq,
      events: first.events.map((item) => ({ source_seq: item.source_seq, event_id: item.source_seq })),
    });
    await waitFor(() => sent.length === 2);
    expect(sent[1]?.events.map((item) => item.source_seq)).toEqual([3]);
  });

  it("resends the same unacknowledged batch after reconnect", async () => {
    const outbox = await createOutbox();
    await outbox.append(eventInput("one"));
    const firstConnection: EventOutboxBatch[] = [];
    const secondConnection: EventOutboxBatch[] = [];
    const pump = new EventOutboxPump(outbox, vi.fn());
    pump.connect(async (batch) => firstConnection.push(batch));
    await waitFor(() => firstConnection.length === 1);

    pump.disconnect();
    pump.connect(async (batch) => secondConnection.push(batch));
    await waitFor(() => secondConnection.length === 1);

    expect(secondConnection[0]).toEqual(firstConnection[0]);
  });

  it("ignores an ACK older than the active batch without releasing that batch", async () => {
    const outbox = await createOutbox();
    const first = await outbox.append(eventInput("one"));
    const sent: EventOutboxBatch[] = [];
    const pump = new EventOutboxPump(outbox, vi.fn());
    pump.connect(async (batch) => sent.push(batch));
    await waitFor(() => sent.length === 1);
    await pump.handleAck({
      type: "event_append_ack",
      stream_id: outbox.streamId,
      acked_through: first.source_seq,
      events: [{ source_seq: first.source_seq, event_id: 9031 }],
    });

    const second = await outbox.append(eventInput("two"));
    await waitFor(() => sent.length === 2);
    await pump.handleAck({
      type: "event_append_ack",
      stream_id: outbox.streamId,
      acked_through: first.source_seq,
      events: [{ source_seq: first.source_seq, event_id: 9031 }],
    });
    await outbox.append(eventInput("three"));
    await Promise.resolve();
    expect(sent).toHaveLength(2);

    await pump.handleAck({
      type: "event_append_ack",
      stream_id: outbox.streamId,
      acked_through: second.source_seq,
      events: [{ source_seq: second.source_seq, event_id: 9032 }],
    });
    await waitFor(() => sent.length === 3);
    expect(sent[2]?.events.map((event) => event.source_seq)).toEqual([3]);
  });

  it("returns the orchestrator event id only after the durable ACK", async () => {
    const outbox = await createOutbox();
    const record = await outbox.append(eventInput("one"));
    const sent: EventOutboxBatch[] = [];
    const pump = new EventOutboxPump(outbox, vi.fn());
    pump.connect(async (batch) => sent.push(batch));
    await waitFor(() => sent.length === 1);

    const acknowledged = pump.waitForAcknowledgement(record);
    await expect(Promise.race([
      acknowledged.then(() => "acknowledged"),
      Promise.resolve("pending"),
    ])).resolves.toBe("pending");

    await pump.handleAck({
      type: "event_append_ack",
      stream_id: outbox.streamId,
      acked_through: record.source_seq,
      events: [{ source_seq: record.source_seq, event_id: 9031 }],
    });

    await expect(acknowledged).resolves.toBe(9031);
  });

  it("keeps an exact ACK result when the ACK arrives before the barrier is installed", async () => {
    const outbox = await createOutbox();
    const record = await outbox.append(eventInput("one"));
    const sent: EventOutboxBatch[] = [];
    const pump = new EventOutboxPump(outbox, vi.fn());
    pump.connect(async (batch) => sent.push(batch));
    await waitFor(() => sent.length === 1);

    await pump.handleAck({
      type: "event_append_ack",
      stream_id: outbox.streamId,
      acked_through: record.source_seq,
      events: [{ source_seq: record.source_seq, event_id: 9031 }],
    });

    await expect(pump.waitForAcknowledgement(record)).resolves.toBe(9031);
  });

  it("keeps the exact earlier ACK when one batch contains two events for the same session", async () => {
    const outbox = await createOutbox();
    const first = await outbox.append(eventInput("one"));
    const second = await outbox.append(eventInput("two"));
    const sent: EventOutboxBatch[] = [];
    const pump = new EventOutboxPump(outbox, vi.fn());
    pump.connect(async (batch) => sent.push(batch));
    await waitFor(() => sent.length === 1);

    await pump.handleAck({
      type: "event_append_ack",
      stream_id: outbox.streamId,
      acked_through: second.source_seq,
      events: [
        { source_seq: first.source_seq, event_id: 9031 },
        { source_seq: second.source_seq, event_id: 9032 },
      ],
    });

    await expect(Promise.race([
      pump.waitForAcknowledgement(first),
      Promise.resolve("pending"),
    ])).resolves.toBe(9031);
    await expect(pump.waitForAcknowledgement(second)).resolves.toBe(9032);
  });

  it("keeps the session barrier pending across disconnect and retry", async () => {
    const outbox = await createOutbox();
    const record = await outbox.append(eventInput("one"));
    const firstConnection: EventOutboxBatch[] = [];
    const secondConnection: EventOutboxBatch[] = [];
    const pump = new EventOutboxPump(outbox, vi.fn());
    pump.connect(async (batch) => firstConnection.push(batch));
    await waitFor(() => firstConnection.length === 1);

    const acknowledged = pump.waitForAcknowledgement(record);
    pump.disconnect();
    pump.connect(async (batch) => secondConnection.push(batch));
    await waitFor(() => secondConnection.length === 1);
    await pump.handleAck({
      type: "event_append_ack",
      stream_id: outbox.streamId,
      acked_through: record.source_seq,
      events: [{ source_seq: record.source_seq, event_id: 9031 }],
    });

    await expect(acknowledged).resolves.toBe(9031);
  });
});

async function createOutbox(): Promise<EventOutbox> {
  const directory = await mkdtemp(join(tmpdir(), "soulstream-event-outbox-pump-"));
  tempDirectories.push(directory);
  return await EventOutbox.open(directory);
}

function eventInput(content: string) {
  return {
    session_id: "session-a",
    event_type: "assistant_message",
    payload: { type: "assistant_message", content },
    searchable_text: content,
    created_at: "2026-08-06T00:00:00.000Z",
    semantic_dedupe_key: null,
    session_effect: null,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

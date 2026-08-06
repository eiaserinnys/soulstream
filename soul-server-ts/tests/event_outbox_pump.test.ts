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

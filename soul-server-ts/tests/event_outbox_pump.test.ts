import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EventOutbox, type EventOutboxBatch } from "../src/upstream/event_outbox.js";
import {
  EventOutboxDeadLetterError,
  EventOutboxPump,
} from "../src/upstream/event_outbox_pump.js";
import { isValidEventAppendAck } from
  "../src/upstream/event_outbox_pump_protocol.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("EventOutboxPump", () => {
  it("validates the complete canonical ownership token in transition ACKs", () => {
    const acknowledgement = {
      type: "event_append_ack" as const,
      stream_id: "stream-a",
      acked_through: 1,
      events: [{
        source_seq: 1,
        event_id: 41,
        effect_application: {
          applied: false,
          canonical_session: {
            status: "initializing",
            termination_reason: null,
            termination_detail: null,
            review_state: "not_required",
            last_assistant_text: null,
            termination_event_id: null,
            updated_at: "2026-08-18T00:00:00.000Z",
            last_event_id: 41,
          },
          canonical_execution_ownership: {
            ownership_generation: 17,
            owner_kind: "runner_process" as const,
            manifest_id: "release-a",
            registration_id: null,
            pid: null,
            start_identity: null,
            execution_command_id: null,
            phase: "reserved" as const,
            failure_reason: null,
          },
        },
      }],
    };

    expect(isValidEventAppendAck(acknowledgement)).toBe(true);
    acknowledgement.events[0]!.effect_application.canonical_execution_ownership.phase =
      "unfenced" as never;
    expect(isValidEventAppendAck(acknowledgement)).toBe(false);
  });

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

  it("advances the durable cursor for a dead-letter ACK and rejects the exact barrier", async () => {
    const outbox = await createOutbox();
    const record = await outbox.append(eventInput("deleted session"));
    const sent: EventOutboxBatch[] = [];
    const pump = new EventOutboxPump(outbox, vi.fn());
    pump.connect(async (batch) => sent.push(batch));
    await waitFor(() => sent.length === 1);

    const acknowledged = pump.waitForAcknowledgement(record);
    await pump.handleAck({
      type: "event_append_ack",
      stream_id: outbox.streamId,
      acked_through: record.source_seq,
      events: [{
        source_seq: record.source_seq,
        dead_letter: {
          code: "SESSION_NOT_FOUND",
          reason: "session session-a does not exist",
          rejected_at: "2026-08-13T00:00:00.000Z",
        },
      }],
    });

    expect(outbox.ackedSeq).toBe(record.source_seq);
    await expect(acknowledged).rejects.toMatchObject({
      constructor: EventOutboxDeadLetterError,
      code: "SESSION_NOT_FOUND",
      sourceSeq: record.source_seq,
    });
  });

  it("quarantines the same rejected head after three reconnects and advances only that cursor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "soulstream-event-outbox-pump-"));
    tempDirectories.push(directory);
    const outbox = await EventOutbox.open(directory);
    const first = await outbox.append({
      ...eventInput("poison"),
      session_id: "7eb9d6ef-dead-4bad-8bad-000000000001",
    });
    const second = await outbox.append({
      ...eventInput("survivor"),
      session_id: "7eb9d6ef-dead-4bad-8bad-000000000001",
    });
    const sent: EventOutboxBatch[] = [];
    const onQuarantine = vi.fn();
    const pump = new EventOutboxPump(outbox, vi.fn(), {
      rejectionThreshold: 3,
      now: () => new Date("2026-08-13T00:00:00.000Z"),
      onQuarantine,
    });
    const rejection = {
      type: "error" as const,
      command_type: "event_append_batch" as const,
      status: 409,
      code: "EVENT_INGRESS_PROTOCOL_CONFLICT" as const,
      retryable: false as const,
      message: "ingress receipt conflict",
      stream_id: outbox.streamId,
      source_seq: first.source_seq,
    };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      pump.connect(async (batch) => sent.push(batch));
      await waitFor(() => sent.length === attempt);
      await pump.handleRejection(rejection);
      if (attempt < 3) {
        expect(outbox.ackedSeq).toBe(0);
        pump.disconnect();
      }
    }

    expect(outbox.ackedSeq).toBe(first.source_seq);
    expect((await outbox.readBatch())?.events.map((event) => event.source_seq))
      .toEqual([second.source_seq]);
    const quarantinePath = join(directory, "quarantine-20260813-7eb9.jsonl");
    const quarantine = JSON.parse((await readFile(quarantinePath, "utf8")).trim()) as {
      event: EventOutboxBatch["events"][number];
      rejection: { code: string; attempts: number };
    };
    expect(quarantine).toMatchObject({
      quarantined_at: "2026-08-13T00:00:00.000Z",
      event: first,
      rejection: { code: "EVENT_INGRESS_PROTOCOL_CONFLICT", attempts: 3 },
    });
    expect(onQuarantine).toHaveBeenCalledWith(expect.objectContaining({
      path: quarantinePath,
      sourceSeq: first.source_seq,
      attempts: 3,
    }));
  });

  it("keeps retryable ingress failures in the outbox for the next connection", async () => {
    const outbox = await createOutbox();
    await outbox.append(eventInput("retry me"));
    const firstConnection: EventOutboxBatch[] = [];
    const secondConnection: EventOutboxBatch[] = [];
    const pump = new EventOutboxPump(outbox, vi.fn());
    pump.connect(async (batch) => firstConnection.push(batch));
    await waitFor(() => firstConnection.length === 1);

    const rejection = {
      type: "error",
      command_type: "event_append_batch",
      status: 503,
      code: "EVENT_INGRESS_TRANSIENT_FAILURE",
      retryable: true,
      stream_id: outbox.streamId,
      source_seq: 1,
    } as const;
    expect(pump.isRejection(rejection)).toBe(true);
    await expect(pump.handleRejection(rejection)).resolves.toBeNull();
    pump.disconnect();
    pump.connect(async (batch) => secondConnection.push(batch));
    await waitFor(() => secondConnection.length === 1);

    expect(secondConnection[0]).toEqual(firstConnection[0]);
    expect(outbox.ackedSeq).toBe(0);
  });

  it("resends a retryable rejection on the same connection instead of waiting for a reconnect", async () => {
    const outbox = await createOutbox();
    await outbox.append(eventInput("retry me"));
    const sent: EventOutboxBatch[] = [];
    const pump = new EventOutboxPump(outbox, vi.fn(), { retryFlushDelayMs: 1 });
    pump.connect(async (batch) => sent.push(batch));
    await waitFor(() => sent.length === 1);

    await expect(pump.handleRejection({
      type: "error",
      command_type: "event_append_batch",
      status: 503,
      code: "EVENT_INGRESS_TRANSIENT_FAILURE",
      retryable: true,
      stream_id: outbox.streamId,
      source_seq: 1,
    } as const)).resolves.toBeNull();

    // Nothing but an ACK or a reconnect clears the in-flight batch, so before
    // this the stream sat idle until the socket happened to drop. The node owns
    // the durable copy and must reclaim it — orch retrying its own copy instead
    // is what produced a second ACK with no batch left to match.
    await waitFor(() => sent.length === 2);
    expect(sent[1]).toEqual(sent[0]);
    expect(outbox.ackedSeq).toBe(0);
  });

  it("abandons a pending retry when the connection is replaced", async () => {
    const outbox = await createOutbox();
    await outbox.append(eventInput("retry me"));
    const first: EventOutboxBatch[] = [];
    const second: EventOutboxBatch[] = [];
    const pump = new EventOutboxPump(outbox, vi.fn(), { retryFlushDelayMs: 20 });
    pump.connect(async (batch) => first.push(batch));
    await waitFor(() => first.length === 1);

    await pump.handleRejection({
      type: "error",
      command_type: "event_append_batch",
      status: 503,
      code: "EVENT_INGRESS_TRANSIENT_FAILURE",
      retryable: true,
      stream_id: outbox.streamId,
      source_seq: 1,
    } as const);
    pump.disconnect();
    pump.connect(async (batch) => second.push(batch));
    await waitFor(() => second.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 40));

    // The reconnect already re-sent it; the stale timer must not send it twice.
    expect(second).toHaveLength(1);
    expect(first).toHaveLength(1);
  });

  it("probes one event after a later batch member is rejected without quarantining the prefix", async () => {
    const outbox = await createOutbox();
    const first = await outbox.append(eventInput("valid prefix"));
    const second = await outbox.append(eventInput("later poison"));
    const sent: EventOutboxBatch[] = [];
    const pump = new EventOutboxPump(outbox, vi.fn());
    pump.connect(async (batch) => sent.push(batch));
    await waitFor(() => sent.length === 1);
    expect(sent[0]?.events.map((event) => event.source_seq)).toEqual([
      first.source_seq,
      second.source_seq,
    ]);

    await pump.handleRejection({
      type: "error",
      command_type: "event_append_batch",
      status: 409,
      code: "EVENT_INGRESS_PROTOCOL_CONFLICT",
      retryable: false,
      message: "later event conflicts",
      stream_id: outbox.streamId,
      source_seq: second.source_seq,
    });
    pump.disconnect();
    pump.connect(async (batch) => sent.push(batch));
    await waitFor(() => sent.length === 2);
    expect(sent[1]?.events.map((event) => event.source_seq)).toEqual([first.source_seq]);

    await pump.handleAck({
      type: "event_append_ack",
      stream_id: outbox.streamId,
      acked_through: first.source_seq,
      events: [{ source_seq: first.source_seq, event_id: 101 }],
    });
    await waitFor(() => sent.length === 3);

    expect(outbox.ackedSeq).toBe(first.source_seq);
    expect(sent[2]?.events.map((event) => event.source_seq)).toEqual([second.source_seq]);
  });

  it("reports initial catch-up ready only after the durable backlog is acknowledged", async () => {
    const outbox = await createOutbox();
    const record = await outbox.append(eventInput("backlog"));
    const sent: EventOutboxBatch[] = [];
    const pump = new EventOutboxPump(outbox, vi.fn());

    const ready = pump.connect(async (batch) => sent.push(batch));
    await waitFor(() => sent.length === 1);
    await expect(Promise.race([ready, Promise.resolve("pending")])).resolves.toBe("pending");
    await pump.handleAck({
      type: "event_append_ack",
      stream_id: outbox.streamId,
      acked_through: record.source_seq,
      events: [{ source_seq: record.source_seq, event_id: 99 }],
    });

    await expect(ready).resolves.toBe(true);
  });
  it("gives a caller its own acknowledgement deadline", async () => {
    const outbox = await createOutbox();
    const record = await outbox.append(eventInput("one"));
    const pump = new EventOutboxPump(outbox, vi.fn(), {
      acknowledgementTimeoutMs: 60_000,
    });

    // State transitions wait far longer than the lane default; a caller that
    // cannot afford that supplies its own deadline instead.
    await expect(
      pump.waitForAcknowledgement(record, { timeoutMs: 10 }),
    ).rejects.toMatchObject({ name: "EventAcknowledgementTimeoutError" });
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

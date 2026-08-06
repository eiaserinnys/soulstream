import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EVENT_OUTBOX_COMPACT_BYTES,
  EVENT_OUTBOX_COMPACT_ROWS,
  EVENT_OUTBOX_MAX_SINGLE_EVENT_BYTES,
  computeEventOutboxPayloadHash,
  EventOutbox,
  type EventOutboxRecord,
} from "../src/upstream/event_outbox.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("EventOutbox", () => {
  it("durably appends JSONL before advancing atomic metadata", async () => {
    const directory = await temporaryDirectory();
    const outbox = await EventOutbox.open(directory);

    const record = await outbox.append(eventInput("one"));

    expect(record.source_seq).toBe(1);
    expect(record.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await readFile(join(directory, "events.jsonl"), "utf8")).split("\n"))
      .toEqual([JSON.stringify(record), ""]);
    expect(JSON.parse(await readFile(join(directory, "metadata.json"), "utf8")))
      .toEqual({ stream_id: outbox.streamId, next_seq: 2, acked_seq: 0 });
    expect(await readdir(directory)).not.toContain("metadata.json.tmp");

    const reopened = await EventOutbox.open(directory);
    expect(await reopened.readBatch()).toMatchObject({ first_seq: 1, events: [record] });
  });

  it("truncates only an incomplete final JSONL row during startup recovery", async () => {
    const directory = await temporaryDirectory();
    const outbox = await EventOutbox.open(directory);
    const record = await outbox.append(eventInput("complete"));
    await appendFile(join(directory, "events.jsonl"), '{"source_seq":2', "utf8");

    const recovered = await EventOutbox.open(directory);

    expect(await readFile(join(directory, "events.jsonl"), "utf8"))
      .toBe(`${JSON.stringify(record)}\n`);
    expect((await recovered.readBatch())?.events).toEqual([record]);
  });

  it("cuts batches at 64 events and advances only the acknowledged prefix", async () => {
    const directory = await temporaryDirectory();
    const streamId = "018f47b7-c6de-7d64-9c8d-0b62cbbb2e10";
    const records = Array.from({ length: 65 }, (_, index) => record(streamId, index + 1));
    await writeFixture(directory, streamId, records, 0);
    const outbox = await EventOutbox.open(directory);

    const first = await outbox.readBatch();
    expect(first?.events).toHaveLength(64);
    expect(first?.events.at(-1)?.source_seq).toBe(64);
    await outbox.acknowledge(streamId, 64);
    expect((await outbox.readBatch())?.events.map((item) => item.source_seq)).toEqual([65]);
    expect(JSON.parse(await readFile(join(directory, "metadata.json"), "utf8")))
      .toEqual({ stream_id: streamId, next_seq: 66, acked_seq: 64 });
    expect(await readdir(directory)).not.toContain("metadata.json.tmp");
  });

  it("cuts a batch before its serialized frame exceeds 256 KiB", async () => {
    const directory = await temporaryDirectory();
    const streamId = "018f47b7-c6de-7d64-9c8d-0b62cbbb2e10";
    const records = [largeRecord(streamId, 1), largeRecord(streamId, 2)];
    await writeFixture(directory, streamId, records, 0);
    const outbox = await EventOutbox.open(directory);

    const first = await outbox.readBatch();

    expect(first?.events.map((item) => item.source_seq)).toEqual([1]);
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(256 * 1024);
  });

  it("sends a measured oversized event alone and resumes normal batching after ACK", async () => {
    const directory = await temporaryDirectory();
    const streamId = "018f47b7-c6de-7d64-9c8d-0b62cbbb2e10";
    const records = [measuredPeakRecord(streamId, 1), record(streamId, 2)];
    await writeFixture(directory, streamId, records, 0);
    const outbox = await EventOutbox.open(directory);

    const first = await outbox.readBatch();
    expect(first?.events.map((item) => item.source_seq)).toEqual([1]);
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeGreaterThan(256 * 1024);
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(2 * 1024 * 1024);

    await outbox.acknowledge(streamId, 1);
    expect((await outbox.readBatch())?.events.map((item) => item.source_seq)).toEqual([2]);
  });

  it("rejects an event whose single-event frame exceeds 2 MiB before durable append", async () => {
    const directory = await temporaryDirectory();
    const outbox = await EventOutbox.open(directory);

    await expect(outbox.append(eventInput("x".repeat(EVENT_OUTBOX_MAX_SINGLE_EVENT_BYTES))))
      .rejects.toThrow("event payload exceeds 2 MiB ingress single-event contract");

    expect(await outbox.readBatch()).toBeNull();
    expect(JSON.parse(await readFile(join(directory, "metadata.json"), "utf8")))
      .toEqual({ stream_id: outbox.streamId, next_seq: 1, acked_seq: 0 });
  });

  it("compacts an acknowledged 1,000-row prefix with real files", async () => {
    const directory = await temporaryDirectory();
    const streamId = "018f47b7-c6de-7d64-9c8d-0b62cbbb2e10";
    const records = Array.from(
      { length: EVENT_OUTBOX_COMPACT_ROWS + 1 },
      (_, index) => record(streamId, index + 1),
    );
    await writeFixture(directory, streamId, records, 0);
    const outbox = await EventOutbox.open(directory);

    await outbox.acknowledge(streamId, EVENT_OUTBOX_COMPACT_ROWS);

    const remaining = (await readFile(join(directory, "events.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line) as EventOutboxRecord);
    expect(remaining.map((item) => item.source_seq)).toEqual([EVENT_OUTBOX_COMPACT_ROWS + 1]);
    expect(await readdir(directory)).not.toContain("events.jsonl.tmp");
  });

  it("compacts an acknowledged prefix after it reaches 8 MiB", async () => {
    const directory = await temporaryDirectory();
    const streamId = "018f47b7-c6de-7d64-9c8d-0b62cbbb2e10";
    const recordCount = Math.ceil(EVENT_OUTBOX_COMPACT_BYTES / (245 * 1024)) + 1;
    const records = Array.from(
      { length: recordCount + 1 },
      (_, index) => largeRecord(streamId, index + 1),
    );
    await writeFixture(directory, streamId, records, 0);
    const outbox = await EventOutbox.open(directory);

    await outbox.acknowledge(streamId, recordCount);

    const remaining = (await readFile(join(directory, "events.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line) as EventOutboxRecord);
    expect(remaining.map((item) => item.source_seq)).toEqual([recordCount + 1]);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "soulstream-event-outbox-"));
  tempDirectories.push(directory);
  return directory;
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

function record(streamId: string, sourceSeq: number): EventOutboxRecord {
  const unsigned = {
    stream_id: streamId,
    source_seq: sourceSeq,
    ...eventInput(String(sourceSeq)),
  };
  return { ...unsigned, payload_hash: computeEventOutboxPayloadHash(unsigned) };
}

function largeRecord(streamId: string, sourceSeq: number): EventOutboxRecord {
  const unsigned = {
    stream_id: streamId,
    source_seq: sourceSeq,
    session_id: "session-a",
    event_type: "assistant_message",
    payload: { type: "assistant_message", content: "x".repeat(245 * 1024) },
    searchable_text: null,
    created_at: "2026-08-06T00:00:00.000Z",
    semantic_dedupe_key: null,
    session_effect: null,
  };
  return { ...unsigned, payload_hash: computeEventOutboxPayloadHash(unsigned) };
}

function measuredPeakRecord(streamId: string, sourceSeq: number): EventOutboxRecord {
  const unsigned = {
    stream_id: streamId,
    source_seq: sourceSeq,
    session_id: "session-a",
    event_type: "assistant_message",
    payload: { type: "assistant_message", content: "x".repeat(1_387_278) },
    searchable_text: null,
    created_at: "2026-08-06T00:00:00.000Z",
    semantic_dedupe_key: null,
    session_effect: null,
  };
  return { ...unsigned, payload_hash: computeEventOutboxPayloadHash(unsigned) };
}

async function writeFixture(
  directory: string,
  streamId: string,
  records: EventOutboxRecord[],
  ackedSeq: number,
): Promise<void> {
  await writeFile(
    join(directory, "metadata.json"),
    `${JSON.stringify({ stream_id: streamId, next_seq: records.length + 1, acked_seq: ackedSeq })}\n`,
    "utf8",
  );
  await writeFile(
    join(directory, "events.jsonl"),
    records.map((item) => `${JSON.stringify(item)}\n`).join(""),
    "utf8",
  );
}

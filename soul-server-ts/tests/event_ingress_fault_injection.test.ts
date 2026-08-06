import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EVENT_INGRESS_MAX_BATCH_FRAME_BYTES,
  EVENT_INGRESS_MAX_SINGLE_EVENT_FRAME_BYTES,
} from "../../orch-server-ts/src/node/event_ingress_types.js";
import peakFixture from "./fixtures/event_ingress_peak_fixture.json";
import {
  EventIngressTestHarness,
  drainOutbox,
  percentile95,
  transmitOneBatch,
} from "./helpers/event_ingress_test_harness.js";
import {
  EVENT_OUTBOX_MAX_BATCH_BYTES,
  EVENT_OUTBOX_MAX_SINGLE_EVENT_BYTES,
  EventOutbox,
  type EventOutboxAppendInput,
  type EventOutboxRecord,
} from "../src/upstream/event_outbox.js";
import { EventOutboxPump } from "../src/upstream/event_outbox_pump.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("event ingress restart fault verification", () => {
  it("keeps worker and orchestrator frame limits symmetric", () => {
    expect(EVENT_OUTBOX_MAX_BATCH_BYTES).toBe(EVENT_INGRESS_MAX_BATCH_FRAME_BYTES);
    expect(EVENT_OUTBOX_MAX_SINGLE_EVENT_BYTES)
      .toBe(EVENT_INGRESS_MAX_SINGLE_EVENT_FRAME_BYTES);
  });

  it("recovers all three restart windows without loss, DB duplicates, reordering, or conflicts", async () => {
    const directory = await temporaryDirectory("faults");
    const outbox = await EventOutbox.open(directory);
    const records = await Promise.all([
      outbox.append(eventInput("one", "session-a")),
      outbox.append(eventInput("two", "session-a")),
      outbox.append({
        ...eventInput("three", "session-a"),
        event_type: "session_ended",
      }),
    ]);
    const harness = new EventIngressTestHarness();
    const pumpErrors: unknown[] = [];

    harness.provider.failBeforeNextCommit = true;
    const beforeCommitPump = new EventOutboxPump(outbox, (error) => pumpErrors.push(error));
    await transmitOneBatch(beforeCommitPump, harness);
    beforeCommitPump.disconnect();
    expect(harness.provider.events).toHaveLength(0);
    expect(outbox.ackedSeq).toBe(0);

    const beforeAckPump = new EventOutboxPump(outbox, (error) => pumpErrors.push(error));
    await transmitOneBatch(beforeAckPump, harness, { crashBeforeAck: true });
    beforeAckPump.disconnect();
    expect(harness.provider.events).toHaveLength(3);
    expect(outbox.ackedSeq).toBe(0);

    const beforeCursorPump = new EventOutboxPump(outbox, (error) => pumpErrors.push(error));
    await transmitOneBatch(beforeCursorPump, harness, { persistAck: false });
    beforeCursorPump.disconnect();
    const reopened = await EventOutbox.open(directory);
    expect(harness.ackFramesSent).toBe(1);
    expect(reopened.ackedSeq).toBe(0);

    const recoveredPump = new EventOutboxPump(reopened, (error) => pumpErrors.push(error));
    await transmitOneBatch(recoveredPump, harness);
    const terminalRevision = await recoveredPump.waitForAcknowledgement(records[2]!);

    expect(reopened.ackedSeq).toBe(3);
    expect(terminalRevision).toBe(harness.provider.events.at(-1)?.eventId);
    expect(harness.ackFramesSent).toBe(2);
    expect(await reopened.readBatch()).toBeNull();
    expect(pumpErrors).toEqual([]);
    expect(harness.provider.events.map((event) => event.eventId)).toEqual([1, 2, 3]);
    expect(harness.provider.receipts.map((receipt) => receipt.sourceSeq)).toEqual([1, 2, 3]);
    expect(harness.provider.receipts.map((receipt) => receipt.payloadHash))
      .toEqual(records.map((record) => record.payload_hash));
    expect(harness.displayedEventIds).toEqual(new Set([1, 2, 3]));
    expect(harness.rawBroadcastEventIds).toHaveLength(6);
    expect(harness.duplicateReceiptCount).toBe(6);
    expect(harness.closeReasons).not.toContain("event ingress protocol conflict");
  }, 30_000);
});

describe("measured production peak replay", () => {
  it.each([
    ["count peak", peakFixture.count_peak.payload_sizes],
    ["payload-byte peak", peakFixture.bytes_peak.payload_sizes],
  ])("drains the %s with matching count, order, hash, and ACK p95 <= 250 ms", async (
    _label,
    payloadSizes,
  ) => {
    const directory = await temporaryDirectory("peak");
    const outbox = await EventOutbox.open(directory);
    const records: EventOutboxRecord[] = [];
    for (const [index, payloadBytes] of payloadSizes.entries()) {
      records.push(await outbox.append({
        ...eventInput(String(index), "peak-session"),
        payload: payloadWithSerializedBytes(payloadBytes),
      }));
    }
    expect(records.reduce(
      (sum, record) => sum + Buffer.byteLength(JSON.stringify(record.payload), "utf8"),
      0,
    )).toBe(payloadSizes.reduce((sum, size) => sum + size, 0));

    const harness = new EventIngressTestHarness();
    const pumpErrors: unknown[] = [];
    const pump = new EventOutboxPump(outbox, (error) => pumpErrors.push(error));
    await drainOutbox(outbox, pump, harness, records.length);

    expect(pumpErrors).toEqual([]);
    expect(await outbox.readBatch()).toBeNull();
    expect(harness.provider.events).toHaveLength(records.length);
    expect(harness.provider.receipts.map((receipt) => receipt.sourceSeq))
      .toEqual(records.map((record) => record.source_seq));
    expect(harness.provider.receipts.map((receipt) => receipt.payloadHash))
      .toEqual(records.map((record) => record.payload_hash));
    expect(harness.duplicateReceiptCount).toBe(0);
    expect(percentile95(harness.ackLatenciesMs)).toBeLessThanOrEqual(250);
  }, 30_000);
});

function eventInput(content: string, sessionId: string): EventOutboxAppendInput {
  return {
    session_id: sessionId,
    event_type: "assistant_message",
    payload: { type: "assistant_message", content },
    searchable_text: content,
    created_at: "2026-08-06T00:00:00.000Z",
    semantic_dedupe_key: null,
    session_effect: null,
  };
}

function payloadWithSerializedBytes(targetBytes: number): Record<string, unknown> {
  const empty = { type: "assistant_message", content: "" };
  const overhead = Buffer.byteLength(JSON.stringify(empty), "utf8");
  if (targetBytes < overhead) throw new Error("peak fixture payload is smaller than its envelope");
  const payload = { ...empty, content: "x".repeat(targetBytes - overhead) };
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") !== targetBytes) {
    throw new Error("failed to reproduce measured payload byte size");
  }
  return payload;
}

async function temporaryDirectory(suffix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `soulstream-event-ingress-${suffix}-`));
  tempDirectories.push(directory);
  return directory;
}

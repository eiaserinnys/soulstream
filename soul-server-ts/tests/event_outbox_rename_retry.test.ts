import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const renameFault = vi.hoisted(() => ({
  code: "EPERM",
  failuresRemaining: 0,
  targetSuffix: "",
  calls: [] as Array<{ source: string; target: string }>,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(async (source: string, target: string) => {
      renameFault.calls.push({ source, target });
      if (
        renameFault.failuresRemaining > 0
        && target.endsWith(renameFault.targetSuffix)
      ) {
        renameFault.failuresRemaining -= 1;
        const error = new Error(`mock rename ${renameFault.code}`) as NodeJS.ErrnoException;
        error.code = renameFault.code;
        throw error;
      }
      await actual.rename(source, target);
    }),
  };
});

const {
  EVENT_OUTBOX_COMPACT_ROWS,
  EventOutbox,
  computeEventOutboxPayloadHash,
} = await import("../src/upstream/event_outbox.js");

const tempDirectories: string[] = [];

afterEach(async () => {
  renameFault.code = "EPERM";
  renameFault.failuresRemaining = 0;
  renameFault.targetSuffix = "";
  renameFault.calls = [];
  await Promise.all(tempDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("EventOutbox Windows atomic replacement retry", () => {
  it("retries transient EPERM while replacing ACK metadata", async () => {
    const directory = await temporaryDirectory();
    const outbox = await EventOutbox.open(directory);
    const appended = await outbox.append(eventInput("one"));
    renameFault.calls = [];
    renameFault.targetSuffix = "metadata.json";
    renameFault.failuresRemaining = 2;

    await outbox.acknowledge(outbox.streamId, appended.source_seq);

    expect(renameCallsFor("metadata.json")).toHaveLength(3);
    expect(JSON.parse(await readFile(join(directory, "metadata.json"), "utf8")))
      .toEqual({ stream_id: outbox.streamId, next_seq: 2, acked_seq: 1 });
    expect(await readdir(directory)).not.toContain("metadata.json.tmp");
  });

  it.each(["EACCES", "EBUSY"])(
    "retries transient %s while replacing a compacted event log",
    async (code) => {
      const directory = await temporaryDirectory();
      const streamId = "018f47b7-c6de-7d64-9c8d-0b62cbbb2e10";
      const records = Array.from(
        { length: EVENT_OUTBOX_COMPACT_ROWS + 1 },
        (_, index) => record(streamId, index + 1),
      );
      await writeFixture(directory, streamId, records);
      const outbox = await EventOutbox.open(directory);
      renameFault.calls = [];
      renameFault.code = code;
      renameFault.targetSuffix = "events.jsonl";
      renameFault.failuresRemaining = 1;

      await outbox.acknowledge(streamId, EVENT_OUTBOX_COMPACT_ROWS);

      expect(renameCallsFor("events.jsonl")).toHaveLength(2);
      expect(await readFile(join(directory, "events.jsonl"), "utf8"))
        .toBe(`${JSON.stringify(records.at(-1))}\n`);
      expect(await readdir(directory)).not.toContain("events.jsonl.tmp");
    },
  );

  it("propagates EPERM after the bounded retry budget is exhausted", async () => {
    const directory = await temporaryDirectory();
    const outbox = await EventOutbox.open(directory);
    const appended = await outbox.append(eventInput("one"));
    renameFault.calls = [];
    renameFault.targetSuffix = "metadata.json";
    renameFault.failuresRemaining = 100;

    await expect(outbox.acknowledge(outbox.streamId, appended.source_seq))
      .rejects.toMatchObject({ code: "EPERM" });

    expect(renameCallsFor("metadata.json")).toHaveLength(6);
  });

  it("does not retry a rename error outside the transient allowlist", async () => {
    const directory = await temporaryDirectory();
    const outbox = await EventOutbox.open(directory);
    const appended = await outbox.append(eventInput("one"));
    renameFault.calls = [];
    renameFault.code = "ENOENT";
    renameFault.targetSuffix = "metadata.json";
    renameFault.failuresRemaining = 100;

    await expect(outbox.acknowledge(outbox.streamId, appended.source_seq))
      .rejects.toMatchObject({ code: "ENOENT" });

    expect(renameCallsFor("metadata.json")).toHaveLength(1);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "soulstream-event-outbox-rename-"));
  tempDirectories.push(directory);
  return directory;
}

function renameCallsFor(targetSuffix: string) {
  return renameFault.calls.filter(({ target }) => target.endsWith(targetSuffix));
}

function eventInput(content: string) {
  return {
    session_id: "session-a",
    event_type: "assistant_message",
    payload: { type: "assistant_message", content },
    searchable_text: content,
    created_at: "2026-08-07T00:00:00.000Z",
    semantic_dedupe_key: null,
    session_effect: null,
  };
}

function record(streamId: string, sourceSeq: number) {
  const unsigned = {
    stream_id: streamId,
    source_seq: sourceSeq,
    ...eventInput(String(sourceSeq)),
  };
  return { ...unsigned, payload_hash: computeEventOutboxPayloadHash(unsigned) };
}

async function writeFixture(
  directory: string,
  streamId: string,
  records: ReturnType<typeof record>[],
): Promise<void> {
  await writeFile(
    join(directory, "metadata.json"),
    `${JSON.stringify({ stream_id: streamId, next_seq: records.length + 1, acked_seq: 0 })}\n`,
    "utf8",
  );
  await writeFile(
    join(directory, "events.jsonl"),
    records.map((item) => `${JSON.stringify(item)}\n`).join(""),
    "utf8",
  );
}

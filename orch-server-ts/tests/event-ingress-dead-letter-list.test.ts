import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileEventIngressDeadLetterStore } from "../src/node/event_ingress_dead_letter_store.js";

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    await rm(directories.pop()!, { recursive: true, force: true });
  }
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "event-ingress-dead-letter-list-"));
  directories.push(path);
  return path;
}

const STREAM_ID = "018f47b7-c6de-7d64-9c8d-0b62cbbb2e10";

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stream_id: STREAM_ID,
    source_seq: 1,
    session_id: "session-a",
    event_type: "assistant_message",
    payload: { secret_marker: "PAYLOAD_MARKER" },
    searchable_text: "SEARCHABLE_MARKER",
    created_at: "2026-11-17T02:00:00.000Z",
    semantic_dedupe_key: "DEDUPE_MARKER",
    session_effect: null,
    payload_hash: "a".repeat(64),
    ...overrides,
  };
}

function failure(failedAt: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { failed_at: failedAt, reason: "database is gone", error_name: "Error", ...overrides };
}

function deadLetteredRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    state: "dead_lettered",
    code: "REPEATED_FAILURE",
    reason: "database is gone",
    rejected_at: "2026-11-17T03:00:00.000Z",
    node_id: "node-a",
    envelope: envelope(),
    failure_count: 2,
    failures: [
      failure("2026-11-17T02:30:00.000Z"),
      failure("2026-11-17T03:00:00.000Z", { error_code: "57P01" }),
    ],
    ...overrides,
  };
}

function retryingRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...deadLetteredRecord(),
    state: "retrying",
    rejected_at: null,
    failure_count: 2,
    failures: [
      failure("2026-11-17T04:30:00.000Z"),
      failure("2026-11-17T05:00:00.000Z", { reason: "still down", error_code: "08006" }),
    ],
    ...overrides,
  };
}

function legacyRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: "SESSION_NOT_FOUND",
    reason: "session vanished",
    rejected_at: "2026-11-16T00:00:00.000Z",
    node_id: "node-a",
    envelope: envelope({
      session_id: "session-legacy",
      event_type: "user_message",
      created_at: "2026-11-15T23:59:00.000Z",
    }),
    ...overrides,
  };
}

async function seed(directory: string, name: string, body: unknown): Promise<void> {
  await writeFile(
    join(directory, name),
    typeof body === "string" ? body : `${JSON.stringify(body)}\n`,
    "utf8",
  );
}

async function seededDirectory(): Promise<string> {
  const directory = await temporaryDirectory();
  await seed(directory, "dead.json", deadLetteredRecord());
  await seed(directory, "retrying.json", retryingRecord());
  await seed(directory, "legacy.json", legacyRecord());
  await seed(directory, "broken.json", "{not json");
  await seed(directory, "shape.json", { node_id: "node-a", envelope: { stream_id: STREAM_ID } });
  return directory;
}

function store(directory: string): FileEventIngressDeadLetterStore {
  return new FileEventIngressDeadLetterStore(directory);
}

describe("list_event_ingress_dead_letters store read", () => {
  it("lists dead_lettered v1 and v2 records by recorded_at without raw fields", async () => {
    const result = await store(await seededDirectory()).list({});

    expect(result.directory_exists).toBe(true);
    expect(result.unreadable_count).toBe(2);
    expect(result.counts).toEqual({ dead_lettered: 2, retrying: 1 });
    expect(result.total_matched).toBe(2);
    expect(result.next_cursor).toBeNull();
    expect(result.items.map((item) => item.id)).toEqual(["dead", "legacy"]);
    expect(result.items[0]).toEqual({
      id: "dead",
      version: 2,
      state: "dead_lettered",
      code: "REPEATED_FAILURE",
      reason: "database is gone",
      node_id: "node-a",
      session_id: "session-a",
      stream_id: STREAM_ID,
      source_seq: 1,
      event_type: "assistant_message",
      created_at: "2026-11-17T02:00:00.000Z",
      first_failed_at: "2026-11-17T02:30:00.000Z",
      last_failed_at: "2026-11-17T03:00:00.000Z",
      rejected_at: "2026-11-17T03:00:00.000Z",
      failure_count: 2,
      last_error_name: "Error",
      last_error_code: "57P01",
      recorded_at: "2026-11-17T03:00:00.000Z",
      delay_ms: 3_600_000,
    });
    expect(result.items[1]).toMatchObject({
      id: "legacy",
      version: 1,
      state: "dead_lettered",
      code: "SESSION_NOT_FOUND",
      first_failed_at: null,
      last_failed_at: null,
      rejected_at: "2026-11-16T00:00:00.000Z",
      failure_count: null,
      last_error_name: null,
      last_error_code: null,
      recorded_at: "2026-11-16T00:00:00.000Z",
      delay_ms: 60_000,
    });
    expect(JSON.stringify(result)).not.toContain("PAYLOAD_MARKER");
    expect(JSON.stringify(result)).not.toContain("SEARCHABLE_MARKER");
    expect(JSON.stringify(result)).not.toContain("DEDUPE_MARKER");
  });

  it("reads retrying records from the last failure time", async () => {
    const result = await store(await seededDirectory()).list({ state: "retrying" });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: "retrying",
      state: "retrying",
      rejected_at: null,
      failure_count: 2,
      last_error_name: "Error",
      last_error_code: "08006",
      recorded_at: "2026-11-17T05:00:00.000Z",
      delay_ms: 10_800_000,
    });
    expect(result.items[0]?.reason).toBe("database is gone");
  });

  it("counts both states while filtering only items by state all", async () => {
    const result = await store(await seededDirectory()).list({ state: "all" });

    expect(result.items.map((item) => item.id)).toEqual(["retrying", "dead", "legacy"]);
    expect(result.counts).toEqual({ dead_lettered: 2, retrying: 1 });
    expect(result.total_matched).toBe(3);
  });

  it("filters by node and by recorded_at window", async () => {
    const directory = await seededDirectory();
    await seed(directory, "other-node.json", deadLetteredRecord({
      node_id: "node-b",
      rejected_at: "2026-11-17T06:00:00.000Z",
      envelope: envelope({ session_id: "session-b" }),
    }));

    const byNode = await store(directory).list({ state: "all", nodeId: "node-b" });
    expect(byNode.items.map((item) => item.id)).toEqual(["other-node"]);
    expect(byNode.counts).toEqual({ dead_lettered: 1, retrying: 0 });

    const windowed = await store(directory).list({
      state: "all",
      since: "2026-11-17T00:00:00.000Z",
      until: "2026-11-17T04:00:00.000Z",
    });
    expect(windowed.items.map((item) => item.id)).toEqual(["dead"]);
    expect(windowed.counts).toEqual({ dead_lettered: 1, retrying: 0 });
  });

  it("pages with the (recorded_at, id) cursor", async () => {
    const directory = await seededDirectory();

    const first = await store(directory).list({ state: "all", limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(["retrying", "dead"]);
    expect(first.total_matched).toBe(3);
    expect(first.next_cursor).toBe("2026-11-17T03:00:00.000Z|dead");

    const second = await store(directory).list({ state: "all", limit: 2, cursor: first.next_cursor! });
    expect(second.items.map((item) => item.id)).toEqual(["legacy"]);
    expect(second.next_cursor).toBeNull();
  });

  it("returns an empty list when the directory is missing", async () => {
    const result = await store(join(await temporaryDirectory(), "missing")).list({});

    expect(result).toEqual({
      items: [],
      next_cursor: null,
      total_matched: 0,
      counts: { dead_lettered: 0, retrying: 0 },
      unreadable_count: 0,
      directory_exists: false,
    });
  });

  it("reads while writes are paused for handover", async () => {
    const directory = await seededDirectory();
    const paused = store(directory);
    await paused.pauseWrites();

    const result = await paused.list({ state: "all" });

    expect(result.items).toHaveLength(3);
    expect(result.directory_exists).toBe(true);
  });

  it("rejects an unparseable since or cursor", async () => {
    const directory = await seededDirectory();

    await expect(store(directory).list({ since: "not-a-date" })).rejects.toThrow(/since/);
    await expect(store(directory).list({ cursor: "garbage" })).rejects.toThrow(/cursor/);
  });
});

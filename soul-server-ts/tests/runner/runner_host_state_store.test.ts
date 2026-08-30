import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RunnerHostStateStore,
  readRunnerHostAcknowledgedThrough,
  runnerHostStatePath,
} from "../../src/runner/runner_host_state_store.js";
import { RunnerParentOutbox } from "../../src/runner/runner_parent_outbox.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import { loadNodeSqlite } from "../../src/runner/node_sqlite.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

describe("RunnerHostStateStore", () => {
  it("persists one monotonic orch ACK checkpoint outside runner.sqlite", async () => {
    const directory = await tempDirectory();
    const runnerDatabasePath = join(directory, "runner.sqlite");
    const path = runnerHostStatePath(runnerDatabasePath);
    const first = RunnerHostStateStore.open(path);

    first.initializeEventCheckpoint({
      streamId: "stream-a",
      sessionId: "session-a",
      acknowledgedThrough: 1,
    });
    first.acknowledgeEvent({
      streamId: "stream-a",
      sessionId: "session-a",
      acknowledgedThrough: 4,
      latestDurableSourceSeq: 4,
    });
    first.close();

    const second = RunnerHostStateStore.open(path);
    expect(second.readAcknowledgedThrough("stream-a", "session-a")).toBe(4);
    expect(readRunnerHostAcknowledgedThrough(path, "stream-a", "session-a")).toBe(4);
    expect(() => second.acknowledgeEvent({
      streamId: "stream-a",
      sessionId: "session-a",
      acknowledgedThrough: 5,
      latestDurableSourceSeq: 4,
    })).toThrow("exceeds durable runner source_seq");
    expect(() => second.initializeEventCheckpoint({
      streamId: "stream-a",
      sessionId: "different-session",
      acknowledgedThrough: 1,
    })).toThrow("stream is already owned by another session");
    second.close();
  });

  it("keeps payload-free host-call receipts across parent restarts", async () => {
    const directory = await tempDirectory();
    const path = runnerHostStatePath(join(directory, "runner.sqlite"));
    const first = RunnerHostStateStore.open(path);

    first.recordHostCallApplied({
      sessionId: "session-a",
      correlationId: "host:1",
      service: "snapshot",
      operation: "persistRunState",
      createdAt: "2026-08-13T00:00:00.000Z",
    });
    first.close();

    const second = RunnerHostStateStore.open(path);
    expect(second.readHostCallApplied("session-a", "host:1")).toEqual({
      correlationId: "host:1",
      service: "snapshot",
      operation: "persistRunState",
    });
    second.acknowledgeHostCall("session-a", "host:1");
    expect(second.readHostCallApplied("session-a", "host:1")).toBeNull();
    second.close();
  });

  it("advances the parent checkpoint without writing the active child database", async () => {
    const directory = await tempDirectory();
    const runnerDatabasePath = join(directory, "runner.sqlite");
    const child = await RunnerSqliteEventOutbox.create(runnerDatabasePath);
    const bootstrap = await child.initializeBootstrap({
      session_id: "session-a",
      created_at: "2026-08-13T00:00:00.000Z",
      resume: {
        schema_version: 1,
        backend_session_id: "backend-a",
        cwd: "/workspace/a",
        codex_home: "/home/test/.codex",
        rollout_root: "/home/test/.codex/sessions",
        code_sha: "sha-a",
        snapshot_path: "/release/sha-a/soul-server-ts",
      },
    });
    const event = await child.append({
      session_id: "session-a",
      event_type: "assistant_message",
      payload: { type: "assistant_message", content: "durable" },
      searchable_text: "durable",
      created_at: "2026-08-13T00:00:01.000Z",
      semantic_dedupe_key: null,
      session_effect: null,
    });

    const parent = await RunnerParentOutbox.open(runnerDatabasePath, "session-a");
    expect((await parent.readBatch())?.events.map((record) => record.source_seq)).toEqual([
      event.source_seq,
    ]);
    await parent.acknowledge(bootstrap.stream_id, event.source_seq);

    expect(parent.ackedSeq).toBe(event.source_seq);
    expect(await parent.readBatch()).toBeNull();
    expect(child.ackedSeq).toBe(1);
    parent.close();
    child.close();
  });

  it("commits a parent ACK while the active child holds runner.sqlite write ownership", async () => {
    const directory = await tempDirectory();
    const runnerDatabasePath = join(directory, "runner.sqlite");
    const child = await RunnerSqliteEventOutbox.create(runnerDatabasePath);
    const bootstrap = await child.initializeBootstrap({
      session_id: "session-a",
      created_at: "2026-08-13T00:00:00.000Z",
      resume: {
        schema_version: 1,
        backend_session_id: "backend-a",
        cwd: "/workspace/a",
        codex_home: "/home/test/.codex",
        rollout_root: "/home/test/.codex/sessions",
        code_sha: "sha-a",
        snapshot_path: "/release/sha-a/soul-server-ts",
      },
    });
    const event = await child.append({
      session_id: "session-a",
      event_type: "assistant_message",
      payload: { type: "assistant_message", content: "durable" },
      searchable_text: "durable",
      created_at: "2026-08-13T00:00:01.000Z",
      semantic_dedupe_key: null,
      session_effect: null,
    });
    const parent = await RunnerParentOutbox.open(runnerDatabasePath, "session-a");
    const { DatabaseSync } = loadNodeSqlite();
    const childLock = new DatabaseSync(runnerDatabasePath);
    childLock.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE");
    try {
      await expect(parent.acknowledge(bootstrap.stream_id, event.source_seq))
        .resolves.toBeUndefined();
      expect(parent.ackedSeq).toBe(event.source_seq);
      expect(child.ackedSeq).toBe(1);
    } finally {
      childLock.exec("ROLLBACK");
      childLock.close();
      parent.close();
      child.close();
    }
  });
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runner-host-state-"));
  directories.push(directory);
  return directory;
}

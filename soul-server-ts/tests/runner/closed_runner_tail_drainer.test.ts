import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ClosedRunnerTailDrainer,
  type ClosedRunnerTailOutbox,
} from "../../src/runner/closed_runner_tail_drainer.js";
import type { RunnerRegistration } from "../../src/runner/runner_process_registry.js";
import { runnerHostStatePath } from "../../src/runner/runner_host_state_store.js";
import { RunnerParentOutbox } from "../../src/runner/runner_parent_outbox.js";
import type { EventOutboxBatch, EventOutboxRecord } from
  "../../src/upstream/event_outbox.js";
import type { EventOutboxPump } from "../../src/upstream/event_outbox_pump.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import { RunnerSqliteLifecycle } from "../../src/runner/sqlite_runner_lifecycle.js";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("ClosedRunnerTailDrainer", () => {
  it("is a no-op when the closed runner has no unacknowledged event tail", async () => {
    const outbox = fakeOutbox(null);
    const register = vi.fn();
    const info = vi.fn();
    const monotonicNow = vi.fn()
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(14.25);
    const drainer = new ClosedRunnerTailDrainer({
      pumpMux: { register },
      logger: { error: vi.fn(), info, warn: vi.fn() },
      openOutbox: vi.fn().mockResolvedValue(outbox),
      monotonicNow,
    });

    await drainer.drain(registration());

    expect(register).not.toHaveBeenCalled();
    expect(outbox.close).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-a",
        durationMs: 4.25,
        outcome: "fully_acknowledged",
      }),
      "closed runner tail drain completed",
    );
  });

  it("treats a terminal pre-bootstrap runner with zero outbox rows as an empty stream", async () => {
    const directory = await mkdtemp(join(tmpdir(), "closed-runner-prebootstrap-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "runner.sqlite");
    const writer = await RunnerSqliteEventOutbox.create(databasePath);
    writer.close();
    const lifecycle = RunnerSqliteLifecycle.open(databasePath, "session-a");
    lifecycle.begin({
      pid: 4123,
      commandId: "execute-a",
      progressedAt: "2026-08-12T00:00:00.000Z",
    });
    const terminal = lifecycle.finish(
      "execute-a",
      "closed",
      "2026-08-12T00:00:01.000Z",
    );
    lifecycle.close();

    const parent = await RunnerParentOutbox.open(databasePath, "session-a");
    expect(parent.ackedSeq).toBe(0);
    await expect(parent.readBatch()).resolves.toBeNull();
    await expect(parent.readLatestPendingRecord()).resolves.toBeNull();
    await expect(parent.hasPendingDurableWork()).resolves.toBe(false);
    parent.close();

    const register = vi.fn();
    const drainer = new ClosedRunnerTailDrainer({
      pumpMux: { register },
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });

    await expect(drainer.drain(registration(databasePath, terminal))).resolves.toBeUndefined();
    expect(register).not.toHaveBeenCalled();
  });

  it("does not swallow bootstrap corruption rejected while opening the drainer outbox", async () => {
    const directory = await mkdtemp(join(tmpdir(), "closed-runner-corrupt-bootstrap-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "runner.sqlite");
    const writer = await RunnerSqliteEventOutbox.create(databasePath);
    writer.close();
    const database = new DatabaseSync(databasePath);
    try {
      database.prepare(`
        INSERT INTO runner_event_outbox (
          source_seq, record_kind, stream_id, session_id, event_type,
          payload_json, searchable_text, created_at, semantic_dedupe_key,
          session_effect_json, payload_hash, acked_through
        ) VALUES (2, 'event', ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, NULL)
      `).run(
        "stream-corrupt",
        "session-a",
        "session_ended",
        JSON.stringify({ type: "session_ended", status: "failed" }),
        "2026-08-12T00:00:01.000Z",
        "0".repeat(64),
      );
    } finally {
      database.close();
    }
    const drainer = new ClosedRunnerTailDrainer({
      pumpMux: { register: vi.fn() },
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });

    // This fails in RunnerSqliteEventOutbox.openReadOnly before a parent read
    // method runs. The assertion protects propagation through the drainer.
    await expect(drainer.drain(registration(databasePath))).rejects.toThrow(
      "runner bootstrap record must be source_seq 1",
    );
  });

  it("rejects a parent read when a normal bootstrap loses its host ACK checkpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "closed-runner-missing-host-checkpoint-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "runner.sqlite");
    const writer = await RunnerSqliteEventOutbox.create(databasePath);
    await writer.initializeBootstrap({
      session_id: "session-a",
      created_at: "2026-08-12T00:00:00.000Z",
      resume: {
        schema_version: 1,
        backend_session_id: "backend-session-a",
        cwd: "/workspace/session-a",
        codex_home: "/workspace/session-a/.codex",
        rollout_root: "/workspace/session-a/.codex/sessions",
        code_sha: "sha-a",
        snapshot_path: "/release/a",
      },
    });
    await writer.append({
      session_id: "session-a",
      event_type: "assistant_message",
      payload: { type: "assistant_message", content: "must not be hidden" },
      searchable_text: "must not be hidden",
      created_at: "2026-08-12T00:00:01.000Z",
      semantic_dedupe_key: null,
      session_effect: null,
    });
    writer.close();

    const parent = await RunnerParentOutbox.open(databasePath, "session-a");
    // A host file missing before open is safely reinitialized from bootstrap.
    // Removing its checkpoint after open exercises the strict parent read guard.
    const hostDatabase = new DatabaseSync(runnerHostStatePath(databasePath));
    try {
      hostDatabase.exec("DELETE FROM runner_event_ack_checkpoint");
    } finally {
      hostDatabase.close();
    }
    try {
      await expect(parent.readLatestPendingRecord()).rejects.toThrow(
        "runner parent ACK checkpoint is unavailable before bootstrap",
      );
    } finally {
      parent.close();
    }
  });

  it("pumps only the unacknowledged tail through the shared upstream mux", async () => {
    const record = eventRecord(2);
    const outbox = fakeOutbox(record);
    const unregister = vi.fn();
    const sent: EventOutboxBatch[] = [];
    const register = vi.fn((pump: EventOutboxPump) => {
      pump.connect(async (batch) => {
        sent.push(batch);
        await pump.handleAck({
          type: "event_append_ack",
          stream_id: batch.stream_id,
          acked_through: batch.events.at(-1)!.source_seq,
          events: batch.events.map((event) => ({
            source_seq: event.source_seq,
            event_id: 100 + event.source_seq,
          })),
        });
      });
      return unregister;
    });
    const drainer = new ClosedRunnerTailDrainer({
      pumpMux: { register },
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      openOutbox: vi.fn().mockResolvedValue(outbox),
    });

    await drainer.drain(registration());

    expect(sent).toHaveLength(1);
    expect(sent[0]!.events.map((event) => event.source_seq)).toEqual([2]);
    expect(outbox.acknowledge).toHaveBeenCalledWith("stream-a", 2);
    expect(unregister).toHaveBeenCalledOnce();
    expect(outbox.close).toHaveBeenCalledOnce();
  });

  it("reopens the disk outbox across two host runs and drains the terminal tail once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "closed-runner-tail-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "runner.sqlite");
    const writer = await RunnerSqliteEventOutbox.create(databasePath);
    await writer.initializeBootstrap({
      session_id: "session-a",
      created_at: "2026-08-12T00:00:00.000Z",
      resume: {
        schema_version: 1,
        backend_session_id: "backend-session-a",
        cwd: "/workspace/session-a",
        codex_home: "/workspace/session-a/.codex",
        rollout_root: "/workspace/session-a/.codex/sessions",
        code_sha: "sha-a",
        snapshot_path: "/release/a",
      },
    });
    await writer.append({
      session_id: "session-a",
      event_type: "session_ended",
      payload: { type: "session_ended", status: "completed" },
      searchable_text: null,
      created_at: "2026-08-12T00:00:01.000Z",
      semantic_dedupe_key: "terminal:session-a",
      session_effect: null,
    });
    writer.close();

    const batches: EventOutboxBatch[] = [];
    const register = vi.fn((pump: EventOutboxPump) => {
      pump.connect(async (batch) => {
        batches.push(batch);
        await pump.handleAck({
          type: "event_append_ack",
          stream_id: batch.stream_id,
          acked_through: batch.events.at(-1)!.source_seq,
          events: batch.events.map((event) => ({
            source_seq: event.source_seq,
            event_id: 100 + event.source_seq,
          })),
        });
      });
      return vi.fn();
    });
    const options = {
      pumpMux: { register },
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    };

    await new ClosedRunnerTailDrainer(options).drain(registration(databasePath));
    await new ClosedRunnerTailDrainer(options).drain(registration(databasePath));

    expect(register).toHaveBeenCalledTimes(1);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.events.map((event) => event.event_type)).toEqual([
      "session_ended",
    ]);
    const reopened = await RunnerParentOutbox.open(databasePath, "session-a");
    await expect(reopened.readLatestPendingRecord()).resolves.toBeNull();
    reopened.close();
    const childLedger = await RunnerSqliteEventOutbox.open(databasePath);
    await expect(childLedger.readRecord(2)).resolves.toMatchObject({
      event_type: "session_ended",
    });
    childLedger.close();
  });
});

function fakeOutbox(tail: EventOutboxRecord | null): ClosedRunnerTailOutbox {
  let ackedSeq = 1;
  return {
    streamId: "stream-a",
    get ackedSeq() { return ackedSeq; },
    onAppend: vi.fn(() => () => {}),
    readLatestPendingRecord: vi.fn().mockResolvedValue(tail),
    readBatch: vi.fn(async () => tail && tail.source_seq > ackedSeq ? {
      type: "event_append_batch" as const,
      stream_id: "stream-a",
      events: [tail],
    } : null),
    acknowledge: vi.fn(async (_streamId: string, cursor: number) => {
      ackedSeq = cursor;
    }),
    close: vi.fn(),
  };
}

function eventRecord(sourceSeq: number): EventOutboxRecord {
  return {
    stream_id: "stream-a",
    source_seq: sourceSeq,
    session_id: "session-a",
    event_type: "session_ended",
    payload: { type: "session_ended", status: "completed" },
    searchable_text: null,
    created_at: "2026-08-12T00:00:00.000Z",
    semantic_dedupe_key: "terminal:session-a",
    session_effect: null,
    payload_hash: "a".repeat(64),
  };
}

function registration(
  databasePath = "/runner/session-a/runner.sqlite",
  lifecycle: RunnerRegistration["lifecycle"] = null,
): RunnerRegistration {
  return {
    config: {
      schemaVersion: 1,
      sessionId: "session-a",
      backend: "codex",
      agent: { id: "agent-a", name: "Agent A", backend: "codex", workspace_dir: "/work" },
      paths: {
        sessionDirectory: "/runner/session-a",
        databasePath,
        socketPath: "/runner/session-a/runner.sock",
        pidPath: "/runner/session-a/runner.pid",
        lockPath: "/runner/session-a/runner.lock",
        configPath: "/runner/session-a/runner-config.json",
      },
      codeSha: "sha-a",
      snapshotPath: "/release/a",
      codexAdapterMode: "sdk",
      claudeRuntimeV2Enabled: true,
      claudeRuntimeIdleTtlMs: 300_000,
      claudeRuntimeMaxEntries: 16,
      claudeRuntimeTurnTimeoutMs: 1_800_000,
      internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
      codexHome: "/home/test/.codex",
      rolloutRoot: "/home/test/.codex/sessions",
    },
    pid: null,
    pidAlive: false,
    registeredAtMs: 1,
    bootstrap: null,
    lifecycle,
  };
}

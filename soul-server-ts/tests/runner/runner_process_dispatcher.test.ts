import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  executionEndedControlFrame,
  outboxAvailableControlFrame,
  runnerCommandResultFrame,
  runnerRequestFrame,
} from "../../src/runner/frame_protocol.js";
import { RunnerProcessDispatcher } from
  "../../src/runner/runner_process_dispatcher.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import { RunnerSocketEndpoint } from "../../src/runner/runner_socket_endpoint.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import type { EventOutboxBatch } from "../../src/upstream/event_outbox.js";
import { EventOutboxPump } from "../../src/upstream/event_outbox_pump.js";
import { EventOutboxPumpMux } from "../../src/upstream/event_outbox_pump_mux.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("RunnerProcessDispatcher", () => {
  it("replays a durable child frame, preserves source lineage, and compacts after both ACKs", async () => {
    const stateDirectory = await temporaryDirectory();
    const paths = runnerProcessPaths(stateDirectory, "session-a");
    await mkdir(paths.sessionDirectory, { recursive: true });
    const writer = await RunnerSqliteEventOutbox.open(paths.databasePath);
    const bootstrap = await writer.initializeBootstrap({
      session_id: "session-a",
      created_at: "2026-08-11T00:00:00.000Z",
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
    let endpoint!: RunnerSocketEndpoint;
    endpoint = new RunnerSocketEndpoint(paths.socketPath, async (frame) => {
      if (frame.channel !== "command") return;
      await endpoint.currentConnection!.send(
        runnerCommandResultFrame(frame.commandId, { status: "ok" }),
      );
      if (frame.kind !== "execute") return;
      const durable = await writer.appendEngineFrame({
        session_id: "session-a",
        event_type: "assistant_message",
        payload: { type: "assistant_message", content: "durable" },
        searchable_text: "durable",
        created_at: "2026-08-11T00:00:01.000Z",
        semantic_dedupe_key: null,
        session_effect: null,
      }, {
        protocolVersion: 1,
        channel: "event",
        kind: "engine_event",
        payload: { type: "assistant_message", content: "durable" },
      });
      await endpoint.currentConnection!.send(outboxAvailableControlFrame(durable.source_seq));
      await endpoint.currentConnection!.send(executionEndedControlFrame(frame.commandId));
    }, vi.fn());
    await endpoint.listen();

    const primary = new EventOutboxPump(emptyStore("node-stream"), vi.fn());
    const mux = new EventOutboxPumpMux(primary);
    const batches: EventOutboxBatch[] = [];
    mux.connect(async (batch) => { batches.push(batch); });
    const dispatcher = new RunnerProcessDispatcher({
      spawn: spawnInput(stateDirectory),
      spawner: { spawn: async () => ({
        pid: 1001,
        paths,
        config: {} as never,
      }) },
      pumpMux: mux,
      logger: pino({ level: "silent" }),
      handleHostCall: async () => null,
    });

    const frames = await collect(dispatcher.executeFrames({
      agentSessionId: "session-a",
      prompt: "hello",
    }));
    await vi.waitFor(() => expect(batches.some(
      (batch) => batch.stream_id === bootstrap.stream_id,
    )).toBe(true));
    const batch = batches.find((candidate) => candidate.stream_id === bootstrap.stream_id)!;
    await mux.handleAck({
      type: "event_append_ack",
      stream_id: batch.stream_id,
      acked_through: batch.events.at(-1)!.source_seq,
      events: batch.events.map((event, index) => ({
        source_seq: event.source_seq,
        event_id: 9000 + index,
      })),
    });

    expect(frames).toEqual([expect.objectContaining({
      kind: "engine_event",
      payload: { type: "assistant_message", content: "durable" },
    })]);
    await expect(dispatcher.waitForSessionAck()).resolves.toBe(9000);
    await vi.waitFor(async () => {
      const observer = await RunnerSqliteEventOutbox.open(paths.databasePath);
      try {
        expect(await observer.readPendingIpcFrames()).toEqual([]);
      } finally {
        observer.close();
      }
    });
    await dispatcher.close();
    writer.close();
    await endpoint.close();
  });

  it("expires an unanswered runner request and removes its request lifetime", async () => {
    const stateDirectory = await temporaryDirectory();
    const paths = runnerProcessPaths(stateDirectory, "session-a");
    await mkdir(paths.sessionDirectory, { recursive: true });
    let endpoint!: RunnerSocketEndpoint;
    endpoint = new RunnerSocketEndpoint(paths.socketPath, async (frame) => {
      if (frame.channel !== "command") return;
      await endpoint.currentConnection!.send(
        runnerCommandResultFrame(frame.commandId, { status: "ok" }),
      );
      if (frame.kind !== "execute") return;
      await endpoint.currentConnection!.send(runnerRequestFrame("schedule:1", {
        kind: "schedule_tool_use",
        agentSessionId: "session-a",
        toolUseId: "tool-1",
        toolName: "schedule",
        input: {},
        now: "2026-08-11T00:00:00.000Z",
      }, { timeoutMs: 10 }));
    }, vi.fn());
    await endpoint.listen();
    const dispatcher = new RunnerProcessDispatcher({
      spawn: spawnInput(stateDirectory),
      spawner: { spawn: async () => ({ pid: 1001, paths, config: {} as never }) },
      pumpMux: new EventOutboxPumpMux(new EventOutboxPump(emptyStore("node-stream"), vi.fn())),
      logger: pino({ level: "silent" }),
      handleHostCall: async () => null,
    });

    const iterator = dispatcher.executeFrames({
      agentSessionId: "session-a",
      prompt: "hello",
    })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual(expect.objectContaining({
      value: expect.objectContaining({ correlationId: "schedule:1" }),
      done: false,
    }));
    const context = dispatcher.requestContext("schedule:1");
    expect(context?.timeoutMs).toBe(10);
    await vi.waitFor(() => expect(context?.signal.aborted).toBe(true));
    expect(dispatcher.requestContext("schedule:1")).toBeUndefined();

    await dispatcher.close();
    await endpoint.close();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "soulstream-runner-dispatcher-"));
  directories.push(directory);
  return directory;
}

function spawnInput(stateDirectory: string) {
  return {
    stateDirectory,
    sessionId: "session-a",
    backend: "codex" as const,
    agent: {
      id: "agent-a",
      name: "Agent A",
      backend: "codex" as const,
      workspace_dir: "/workspace/a",
    },
    codeSha: "sha-a",
    snapshotPath: "/release/sha-a/soul-server-ts",
    codexAdapterMode: "sdk" as const,
    claudeRuntimeV2Enabled: true,
    claudeRuntimeIdleTtlMs: 300_000,
    claudeRuntimeMaxEntries: 16,
    claudeRuntimeTurnTimeoutMs: 1_800_000,
    codexHome: "/home/test/.codex",
    rolloutRoot: "/home/test/.codex/sessions",
  };
}

function emptyStore(streamId: string) {
  return {
    streamId,
    ackedSeq: 0,
    onAppend: () => () => {},
    async readBatch() { return null; },
    async acknowledge() {},
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of iterable) result.push(value);
  return result;
}

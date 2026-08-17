import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
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
import { buildDurableRunnerEvent } from
  "../../src/runner/runner_child_runtime_helpers.js";
import {
  readRunnerHostAcknowledgedThrough,
  RunnerHostStateStore,
  runnerHostStatePath,
} from "../../src/runner/runner_host_state_store.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import { RunnerSocketEndpoint } from "../../src/runner/runner_socket_endpoint.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import { RunnerSqliteLifecycle } from "../../src/runner/sqlite_runner_lifecycle.js";
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
  it("prefers the first-durable child intervention and consumes a conflicting host fallback", async () => {
    const stateDirectory = await temporaryDirectory();
    const paths = runnerProcessPaths(stateDirectory, "session-a");
    await mkdir(paths.sessionDirectory, { recursive: true });
    const writer = await RunnerSqliteEventOutbox.create(paths.databasePath);
    await writer.initializeBootstrap({
      session_id: "session-a",
      created_at: "2026-08-17T00:00:00.000Z",
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
    await writer.stageIntervention({
      interventionId: "delivery-a",
      message: { text: "first durable prompt", user: "system" },
      queued: true,
      queuedAt: "2026-08-17T00:00:01.000Z",
    });
    writer.close();
    const host = RunnerHostStateStore.open(runnerHostStatePath(paths.databasePath));
    host.stageInterventionFallback({
      sessionId: "session-a",
      interventionId: "delivery-a",
      message: { text: "regenerated retry prompt", user: "system" },
      queued: true,
      stagedAt: "2026-08-17T00:00:02.000Z",
    });
    host.close();
    const logger = {
      debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn(),
    };
    const dispatcher = new RunnerProcessDispatcher({
      spawn: spawnInput(stateDirectory),
      offlineExisting: true,
      pumpMux: new EventOutboxPumpMux(new EventOutboxPump(emptyStore("node-stream"), vi.fn())),
      logger,
      handleHostCall: async () => null,
    } as never);

    vi.spyOn(
      dispatcher as unknown as {
        stageInterventionInChild(input: unknown): Promise<unknown>;
      },
      "stageInterventionInChild",
    ).mockRejectedValue(new Error("runner intervention id conflicts with durable payload"));

    await expect(dispatcher.stageIntervention({
      interventionId: "delivery-a",
      message: { text: "third regenerated prompt", user: "system" },
      queued: true,
    })).resolves.toEqual({
      eventSourceSeq: null,
      queuePosition: 1,
      durability: "runner",
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-a",
        interventionId: "delivery-a",
        durableOwner: "runner_sqlite",
      }),
      "Regenerated runner intervention suppressed in favor of first durable payload",
    );

    await expect(dispatcher.recoverPendingInterventions()).resolves.toEqual([{
      interventionId: "delivery-a",
      message: { text: "first durable prompt", user: "system" },
    }]);

    const inspectedHost = RunnerHostStateStore.open(runnerHostStatePath(paths.databasePath));
    expect(inspectedHost.readInterventionFallback("session-a", "delivery-a")).toBeNull();
    inspectedHost.close();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-a",
        interventionId: "delivery-a",
        fallbackRemoved: true,
        durableOwner: "runner_sqlite",
      }),
      "Duplicate host intervention fallback suppressed in favor of runner inbox",
    );
    await dispatcher.close();
  });

  it("reports ACK-loss fallback positions from the merged priority queue", async () => {
    const stateDirectory = await temporaryDirectory();
    const paths = runnerProcessPaths(stateDirectory, "session-a");
    await mkdir(paths.sessionDirectory, { recursive: true });
    const writer = await RunnerSqliteEventOutbox.create(paths.databasePath);
    await writer.initializeBootstrap({
      session_id: "session-a",
      created_at: "2026-08-17T00:00:00.000Z",
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
    await writer.stageIntervention({
      interventionId: "followup-low",
      message: {
        text: "background followup",
        user: "system",
        source: "claude_runtime_task_followup",
      },
      queued: true,
      queuedAt: "2026-08-17T00:00:01.000Z",
    });
    writer.close();
    const dispatcher = new RunnerProcessDispatcher({
      spawn: spawnInput(stateDirectory),
      offlineExisting: true,
      pumpMux: new EventOutboxPumpMux(new EventOutboxPump(emptyStore("node-stream"), vi.fn())),
      logger: pino({ level: "silent" }),
      handleHostCall: async () => null,
    } as never);
    vi.spyOn(
      dispatcher as unknown as {
        stageInterventionInChild(input: unknown): Promise<unknown>;
      },
      "stageInterventionInChild",
    ).mockRejectedValue(new Error("runner ACK lost"));

    await expect(dispatcher.stageIntervention({
      interventionId: "user-high",
      message: { text: "real user message", user: "alice", source: "user_message" },
      queued: true,
    })).resolves.toMatchObject({
      queuePosition: 1,
      durability: "host_fallback",
    });
    await expect(dispatcher.stageIntervention({
      interventionId: "followup-low",
      message: {
        text: "regenerated background followup",
        user: "system",
        source: "claude_runtime_task_followup",
      },
      queued: true,
    })).resolves.toMatchObject({
      queuePosition: 2,
      durability: "runner",
    });
    await expect(dispatcher.recoverPendingInterventions()).resolves.toEqual([
      expect.objectContaining({ interventionId: "user-high" }),
      expect.objectContaining({ interventionId: "followup-low" }),
    ]);
    await dispatcher.close();
  });

  it("releases an offline writer lock even when an earlier cleanup step throws", async () => {
    const stateDirectory = await temporaryDirectory();
    const paths = runnerProcessPaths(stateDirectory, "session-a");
    await mkdir(paths.sessionDirectory, { recursive: true });
    const writer = await RunnerSqliteEventOutbox.create(paths.databasePath);
    await writer.initializeBootstrap({
      session_id: "session-a",
      created_at: "2026-08-17T00:00:00.000Z",
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
    writer.close();
    const dispatcher = new RunnerProcessDispatcher({
      spawn: spawnInput(stateDirectory),
      offlineExisting: true,
      pumpMux: new EventOutboxPumpMux(new EventOutboxPump(emptyStore("node-stream"), vi.fn())),
      logger: pino({ level: "silent" }),
      handleHostCall: async () => null,
    });
    await dispatcher.recoverPendingInterventions();
    (dispatcher as unknown as { finishActiveRunnerObservation: () => void })
      .finishActiveRunnerObservation = () => { throw new Error("observer close boom"); };

    await expect(dispatcher.close()).rejects.toThrow("runner host resource cleanup failed");

    await expect(access(paths.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists a failed child stage in runner-host.sqlite and flushes it before apply", async () => {
    const stateDirectory = await temporaryDirectory();
    const paths = runnerProcessPaths(stateDirectory, "session-a");
    await mkdir(paths.sessionDirectory, { recursive: true });
    const writer = await RunnerSqliteEventOutbox.create(paths.databasePath);
    const bootstrap = await writer.initializeBootstrap({
      session_id: "session-a",
      created_at: "2026-08-17T00:00:00.000Z",
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
    let rejectFirstStage = true;
    const commandKinds: string[] = [];
    let endpoint!: RunnerSocketEndpoint;
    endpoint = new RunnerSocketEndpoint(paths.socketPath, async (frame) => {
      if (frame.channel !== "command") return;
      commandKinds.push(frame.kind === "invoke" ? String(frame.capability) : frame.kind);
      if (frame.kind === "stage_intervention") {
        if (rejectFirstStage) {
          rejectFirstStage = false;
          await endpoint.currentConnection!.send(runnerCommandResultFrame(frame.commandId, {
            status: "error",
            error: { code: "stage_intervention_failed", message: "sqlite busy" },
          }));
          return;
        }
        const staged = await writer.stageIntervention({
          interventionId: frame.interventionId,
          message: frame.message,
          ...(frame.event
            ? { event: buildDurableRunnerEvent("session-a", frame.event as never).appendInput }
            : {}),
          queued: frame.queued,
          queuedAt: "2026-08-17T00:00:01.000Z",
        });
        await endpoint.currentConnection!.send(runnerCommandResultFrame(frame.commandId, {
          status: "ok",
          data: staged,
        }));
        return;
      }
      if (frame.kind === "invoke" && frame.capability === "runner.apply_intervention") {
        await endpoint.currentConnection!.send(runnerCommandResultFrame(frame.commandId, {
          status: "ok",
          data: { status: "delivered", mechanism: "active_turn" },
        }));
        return;
      }
      await endpoint.currentConnection!.send(
        runnerCommandResultFrame(frame.commandId, { status: "ok" }),
      );
    }, vi.fn());
    await endpoint.listen();
    const primary = new EventOutboxPump(emptyStore("node-stream"), vi.fn());
    const mux = new EventOutboxPumpMux(primary);
    const batches: EventOutboxBatch[] = [];
    mux.connect(async (batch) => { batches.push(batch); });
    const dispatcher = new RunnerProcessDispatcher({
      spawn: spawnInput(stateDirectory),
      spawner: { spawn: async () => ({
        pid: 1001, paths, config: {} as never, adopted: false,
      }) },
      pumpMux: mux,
      logger: pino({ level: "silent" }),
      handleHostCall: async () => null,
    });

    await expect(dispatcher.stageIntervention({
      interventionId: "intervention-a",
      message: { text: "stop now", user: "alice" },
      event: { type: "user_message", content: "stop now", timestamp: 1 },
      queued: false,
    })).resolves.toEqual({
      eventSourceSeq: null,
      queuePosition: 0,
      durability: "host_fallback",
    });
    expect(await dispatcher.recoverPendingInterventions()).toEqual([{
      interventionId: "intervention-a",
      message: { text: "stop now", user: "alice" },
    }]);

    const applying = dispatcher.applyIntervention({
      interventionId: "intervention-a",
      input: { prompt: "stop now" },
    });
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
        event_id: 9100 + index,
      })),
    });
    await expect(applying).resolves.toMatchObject({ status: "delivered" });

    expect(commandKinds).toEqual([
      "stage_intervention",
      "stage_intervention",
      "runner.apply_intervention",
    ]);
    const host = RunnerHostStateStore.open(runnerHostStatePath(paths.databasePath));
    expect(host.readInterventionFallback("session-a", "intervention-a")).toBeNull();
    host.close();
    await dispatcher.close();
    writer.close();
    await endpoint.close();
  });

  it("replays a durable child frame, preserves source lineage, and compacts after both ACKs", async () => {
    const stateDirectory = await temporaryDirectory();
    const paths = runnerProcessPaths(stateDirectory, "session-a");
    await mkdir(paths.sessionDirectory, { recursive: true });
    const writer = await RunnerSqliteEventOutbox.create(paths.databasePath);
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
      if (frame.channel === "control" && frame.kind === "host_frame_applied") {
        const durableBootstrap = await writer.readBootstrap();
        const hostAck = readRunnerHostAcknowledgedThrough(
          runnerHostStatePath(paths.databasePath),
          durableBootstrap!.stream_id,
          durableBootstrap!.session_id,
        );
        if (hostAck !== null && hostAck > writer.ackedSeq) {
          await writer.acknowledge(durableBootstrap!.stream_id, hostAck);
        }
        await writer.acknowledgeHostFrame(frame.frameSeq);
        return;
      }
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
    const finishRunnerOperation = vi.fn();
    const beginRunnerOperation = vi.fn(() => finishRunnerOperation);
    const sqliteTransactionObserver = vi.fn();
    const dispatcher = new RunnerProcessDispatcher({
      spawn: spawnInput(stateDirectory),
      spawner: { spawn: async () => ({
        pid: 1001,
        paths,
        config: {} as never,
        adopted: false,
      }) },
      pumpMux: mux,
      logger: pino({ level: "silent" }),
      nodeStallMonitor: { beginRunnerOperation, sqliteTransactionObserver },
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
    expect(beginRunnerOperation).toHaveBeenCalledWith({
      sessionId: "session-a",
      commandId: expect.stringMatching(/^execute:/),
      operation: "execution:execute",
    });
    expect(beginRunnerOperation).toHaveBeenCalledWith({
      sessionId: "session-a",
      commandId: expect.stringMatching(/^execute:/),
      operation: "command:execute",
    });
    expect(finishRunnerOperation).toHaveBeenCalledTimes(2);
    expect(sqliteTransactionObserver).not.toHaveBeenCalled();
    await expect(dispatcher.waitForSessionAck()).resolves.toBe(9000);
    await vi.waitFor(async () => {
      const observer = await RunnerSqliteEventOutbox.create(paths.databasePath);
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
    const outbox = await RunnerSqliteEventOutbox.create(paths.databasePath);
    outbox.close();
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
      spawner: { spawn: async () => ({
        pid: 1001, paths, config: {} as never, adopted: false,
      }) },
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

  it("bounds rapid disconnect reconnects and terminalizes the active recovery with identity logs", async () => {
    const stateDirectory = await temporaryDirectory();
    const paths = runnerProcessPaths(stateDirectory, "session-a");
    await mkdir(paths.sessionDirectory, { recursive: true });
    const outbox = await RunnerSqliteEventOutbox.create(paths.databasePath);
    await outbox.initializeBootstrap({
      session_id: "session-a",
      created_at: "2026-08-17T00:00:00.000Z",
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
    outbox.close();
    const lifecycle = RunnerSqliteLifecycle.open(paths.databasePath);
    lifecycle.begin({
      pid: 1001,
      commandId: "execute-old",
      progressedAt: "2026-08-17T00:00:00.000Z",
    });
    lifecycle.close();

    let connectionCount = 0;
    let serverClosed = false;
    const server = createServer((socket) => {
      connectionCount += 1;
      socket.destroy();
      if (connectionCount === 20) {
        serverClosed = true;
        server.close();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const dispatcher = new RunnerProcessDispatcher({
      spawn: spawnInput(stateDirectory),
      spawner: { spawn: async () => ({
        pid: 1001, paths, config: {} as never, adopted: false,
      }) },
      pumpMux: new EventOutboxPumpMux(new EventOutboxPump(emptyStore("node-stream"), vi.fn())),
      logger,
      handleHostCall: async () => null,
      reconnectPolicy: {
        initialDelayMs: 1,
        maxDelayMs: 2,
        maxAttempts: 3,
        stableConnectionMs: 1_000,
      },
    } as never);

    const recovery = collect(dispatcher.recoverFrames("execute-old")).then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({
        status: "rejected" as const,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    const outcome = await Promise.race([
      recovery,
      new Promise<{ status: "timeout" }>((resolve) => {
        setTimeout(() => resolve({ status: "timeout" }), 500);
      }),
    ]);

    expect(outcome).toEqual({
      status: "rejected",
      message: "Runner IPC reconnect budget exhausted after 3 attempts",
    });
    expect(connectionCount).toBe(4);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-a",
        runnerDirectory: paths.sessionDirectory,
        socketPath: paths.socketPath,
        reconnectAttempt: 1,
        reconnectDelayMs: 1,
      }),
      "Runner IPC disconnected; reconnecting",
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-a",
        runnerDirectory: paths.sessionDirectory,
        socketPath: paths.socketPath,
        reconnectAttempts: 3,
      }),
      "Runner IPC reconnect budget exhausted; runner execution will be terminalized",
    );

    await dispatcher.detachHost();
    if (!serverClosed) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("adopts a live runner and finishes replay from its durable terminal state", async () => {
    const stateDirectory = await temporaryDirectory();
    const paths = runnerProcessPaths(stateDirectory, "session-a");
    await mkdir(paths.sessionDirectory, { recursive: true });
    const writer = await RunnerSqliteEventOutbox.create(paths.databasePath);
    await writer.initializeBootstrap({
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
    await writer.appendEngineFrame({
      session_id: "session-a",
      event_type: "assistant_message",
      payload: { type: "assistant_message", content: "replayed" },
      searchable_text: "replayed",
      created_at: "2026-08-11T00:00:01.000Z",
      semantic_dedupe_key: null,
      session_effect: null,
    }, {
      protocolVersion: 1,
      channel: "event",
      kind: "engine_event",
      payload: { type: "assistant_message", content: "replayed" },
    });
    const lifecycle = RunnerSqliteLifecycle.open(paths.databasePath);
    lifecycle.begin({
      pid: 1001,
      commandId: "execute-old",
      progressedAt: "2026-08-11T00:00:01.000Z",
    });
    lifecycle.finish("execute-old", "completed", "2026-08-11T00:00:02.000Z");
    lifecycle.close();
    const endpoint = new RunnerSocketEndpoint(paths.socketPath, async () => {}, vi.fn());
    await endpoint.listen();
    const spawn = vi.fn(async () => { throw new Error("must not spawn"); });
    const dispatcher = new RunnerProcessDispatcher({
      spawn: spawnInput(stateDirectory),
      adoptExisting: true,
      spawner: {
        spawn,
        adopt: async () => ({ pid: 1001, paths, config: {} as never, adopted: true }),
      },
      pumpMux: new EventOutboxPumpMux(new EventOutboxPump(emptyStore("node-stream"), vi.fn())),
      logger: pino({ level: "silent" }),
      handleHostCall: async () => null,
    });

    await expect(collect(dispatcher.recoverFrames("execute-old"))).resolves.toEqual([
      expect.objectContaining({
        kind: "engine_event",
        payload: { type: "assistant_message", content: "replayed" },
      }),
    ]);
    expect(spawn).not.toHaveBeenCalled();

    await dispatcher.detachHost();
    writer.close();
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

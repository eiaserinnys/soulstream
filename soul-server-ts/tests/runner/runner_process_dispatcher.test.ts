import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  engineEventFrame,
  executionEndedControlFrame,
  invokeCommandFrame,
  outboxAvailableControlFrame,
  prepareSessionCommandFrame,
  runnerCommandResultFrame,
  runnerRequestFrame,
  type RunnerFrame,
} from "../../src/runner/frame_protocol.js";
import { RunnerOrphanedSpawnError, RunnerProcessDispatcher } from
  "../../src/runner/runner_process_dispatcher.js";
import { IsolationPreparationPolicyError } from
  "../../src/runner/session_filesystem_errors.js";
import {
  RunnerIpcConnection,
  RunnerIpcRequestTimeoutError,
} from "../../src/runner/runner_ipc_connection.js";
import { RunnerParentOutbox } from "../../src/runner/runner_parent_outbox.js";
import { ProcessFrameStream } from "../../src/runner/runner_process_frame_stream.js";
import { RunnerProcessEngineProxy } from "../../src/runner/runner_process_engine_proxy.js";
import { isClosedClaudeEngineFailure } from "../../src/runner/closed_engine_error.js";
import { buildDurableRunnerEvent } from
  "../../src/runner/runner_child_runtime_helpers.js";
import {
  readRunnerHostAcknowledgedThrough,
  RunnerHostStateStore,
  runnerHostStatePath,
} from "../../src/runner/runner_host_state_store.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import {
  pendingRunnerRegistrationIdentity,
  runnerRegistrationIdentityPath,
  writeRunnerRegistrationIdentity,
} from "../../src/runner/runner_registration_identity.js";
import {
  connectRunnerSocket,
  RunnerSocketEndpoint,
} from "../../src/runner/runner_socket_endpoint.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import { RunnerSqliteLifecycle } from "../../src/runner/sqlite_runner_lifecycle.js";
import { createTaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";
import { TaskExecutorFinalizer } from "../../src/task/task_executor_finalizer.js";
import type { Task } from "../../src/task/task_models.js";
import type { EventOutboxBatch } from "../../src/upstream/event_outbox.js";
import { EventOutboxPump } from "../../src/upstream/event_outbox_pump.js";
import { EventOutboxPumpMux } from "../../src/upstream/event_outbox_pump_mux.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("RunnerProcessDispatcher", () => {
  it.each(["replaced", "removed", "retired", "pid-cleared"] as const)(
    "stops reconnecting after its registration is %s and releases its event stream",
    async (change) => {
      const stateDirectory = await temporaryDirectory();
      const paths = runnerProcessPaths(stateDirectory, "session-a");
      await mkdir(paths.sessionDirectory, { recursive: true });
      const identity = {
        ...pendingRunnerRegistrationIdentity("session-a", "sha-a"),
        pid: 1001,
        startIdentity: "start-1001",
      };
      await writeRunnerRegistrationIdentity(paths.sessionDirectory, identity);
      const mux = new EventOutboxPumpMux(
        new EventOutboxPump(emptyStore("fallback-stream"), vi.fn()),
      );
      const unregister = mux.register(
        new EventOutboxPump(emptyStore("stream-session-a"), vi.fn()),
      );
      let dispatcher!: RunnerProcessDispatcher & Record<string, unknown>;
      let connectCalls = 0;
      const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
      const stream = new ProcessFrameStream(async () => {});
      dispatcher = Object.assign(
        Object.create(RunnerProcessDispatcher.prototype),
        {
          closed: false,
          reconnectRequested: true,
          reconnectAttempts: 0,
          reconnectCause: new Error("initial socket failure"),
          reconnectPolicy: {
            initialDelayMs: 1, maxDelayMs: 1, maxAttempts: 3,
            stableConnectionMs: 1000,
          },
          spawnInput: spawnInput(stateDirectory),
          spawnedProcess: {
            registrationId: identity.registrationId,
            paths,
            pid: 1001,
          },
          options: {
            logger,
            reconnectSleep: async () => undefined,
            inspectWriterLock: async () => ({
              kind: "held",
              owner: { pid: 1001, startIdentity: "start-1001" },
            }),
            connectSocket: async () => {
              connectCalls += 1;
              if (connectCalls === 1) {
                if (change === "replaced") {
                  await writeRunnerRegistrationIdentity(paths.sessionDirectory, {
                    ...identity, registrationId: "replacement-registration",
                  });
                } else if (change === "removed") {
                  await rm(runnerRegistrationIdentityPath(paths.sessionDirectory));
                } else if (change === "retired") {
                  await writeRunnerRegistrationIdentity(paths.sessionDirectory, {
                    ...identity, retiredAt: new Date().toISOString(),
                  });
                } else {
                  await writeRunnerRegistrationIdentity(paths.sessionDirectory, {
                    ...identity, pid: null, startIdentity: null,
                  });
                }
                throw new Error("initial socket failure");
              }
              dispatcher.closed = true;
              throw new Error("unexpected reconnect");
            },
          },
          activeExecution: {
            commandId: "execute-a",
            registrationId: identity.registrationId,
            stream,
            acceptsInterventions: true,
          },
          requestLifetimes: new Map(),
          releaseHostResources: vi.fn(async () => { unregister(); }),
        },
      ) as RunnerProcessDispatcher & Record<string, unknown>;

      await (dispatcher as unknown as {
        runReconnectLoop(socketPath: string, firstConnectedForMs: number): Promise<void>;
      }).runReconnectLoop(paths.socketPath, 0);

      expect(connectCalls).toBe(1);
      expect(dispatcher.closed).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ expectedRegistrationId: identity.registrationId }),
        expect.stringContaining("Runner registration lost"),
      );
      await expect(collect(stream)).rejects.toThrow(
        "runner registration replaced or removed while the host was reconnecting",
      );
      expect(() => mux.register(
        new EventOutboxPump(emptyStore("stream-session-a"), vi.fn()),
      )).not.toThrow();
    },
  );

  it("continues reconnecting while the runner registration is still owned", async () => {
    const stateDirectory = await temporaryDirectory();
    const paths = runnerProcessPaths(stateDirectory, "session-a");
    await mkdir(paths.sessionDirectory, { recursive: true });
    const identity = {
      ...pendingRunnerRegistrationIdentity("session-a", "sha-a"),
      pid: 1001,
      startIdentity: "start-1001",
    };
    await writeRunnerRegistrationIdentity(paths.sessionDirectory, identity);
    let dispatcher!: RunnerProcessDispatcher & Record<string, unknown>;
    let connectCalls = 0;
    dispatcher = Object.assign(Object.create(RunnerProcessDispatcher.prototype), {
      closed: false,
      reconnectRequested: true,
      reconnectAttempts: 0,
      reconnectCause: new Error("socket failure"),
      reconnectPolicy: { initialDelayMs: 1, maxDelayMs: 1, maxAttempts: 3, stableConnectionMs: 1000 },
      spawnInput: spawnInput(stateDirectory),
      spawnedProcess: { registrationId: identity.registrationId, paths, pid: 1001 },
      options: {
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        reconnectSleep: async () => undefined,
        inspectWriterLock: async () => ({
          kind: "held",
          owner: { pid: 1001, startIdentity: "start-1001" },
        }),
        connectSocket: async () => {
          connectCalls += 1;
          if (connectCalls === 2) dispatcher.closed = true;
          throw new Error("socket failure");
        },
      },
    }) as RunnerProcessDispatcher & Record<string, unknown>;

    await (dispatcher as unknown as {
      runReconnectLoop(socketPath: string, firstConnectedForMs: number): Promise<void>;
    }).runReconnectLoop(paths.socketPath, 0);
    expect(connectCalls).toBe(2);
  });

  it("stops on a free writer lock without settling the active stream and rejects queued dispatches", async () => {
    const sleepStarted = deferred<void>();
    const releaseSleep = deferred<void>();
    const inspectWriterLock = vi.fn(async () => ({ kind: "free" }));
    const executeReceived = deferred<void>();
    const fixture = await connectedDispatcherFixture({
      reconnectSleep: async () => {
        sleepStarted.resolve();
        await releaseSleep.promise;
      },
      inspectWriterLock,
      onCommand: async (endpoint, frame) => {
        if (frame.kind === "execute") executeReceived.resolve();
        await endpoint.currentConnection!.send(
          runnerCommandResultFrame(frame.commandId, { status: "ok" }),
        );
      },
    });

    try {
      const stream = fixture.dispatcher.executeFrames({
        agentSessionId: "session-a",
        prompt: "leave execution open",
      });
      const streamOutcome = observePromise(collect(stream), 300);
      await executeReceived.promise;
      await vi.waitFor(() => expect(fixture.dispatcher.hasActiveExecution()).toBe(true));

      fixture.endpoint.currentConnection!.close();
      await sleepStarted.promise;
      const inFlightDispatch = fixture.dispatcher.dispatch(
        invokeCommandFrame("activity-during-reconnect", "codexDetachedCommandActivity", []),
      );
      const inFlightOutcome = observePromise(inFlightDispatch, 300);
      releaseSleep.resolve();

      await vi.waitFor(() => expect(hasLostRunner(fixture.dispatcher)).toBe(true), {
        timeout: 500,
      });
      expect(fixture.connectSocket).toHaveBeenCalledOnce();
      expect(inspectWriterLock).toHaveBeenCalledOnce();
      expect(fixture.dispatcher.isClosed()).toBe(false);
      expect(fixture.dispatcher.hasActiveExecution()).toBe(true);
      expect((await streamOutcome).status).toBe("pending");
      const inFlightResult = await inFlightOutcome;
      expect(inFlightResult).toMatchObject({ status: "rejected" });
      expect((inFlightResult as { status: "rejected"; error: unknown }).error)
        .toMatchObject({ message: "Runner process is unavailable: session-a" });

      const laterOutcome = await observePromise(fixture.dispatcher.dispatch(
        invokeCommandFrame("activity-after-reconnect", "codexDetachedCommandActivity", []),
      ), 300);
      expect(laterOutcome).toMatchObject({ status: "rejected" });
      expect((laterOutcome as { status: "rejected"; error: unknown }).error)
        .toMatchObject({ message: "Runner process is unavailable: session-a" });

    } finally {
      releaseSleep.resolve();
      await fixture.dispatcher.detachHost().catch(() => undefined);
      await fixture.endpoint.close();
    }
  });

  it.each(["held", "unavailable", "throw"] as const)(
    "continues reconnecting when writer lock inspection is %s",
    async (inspection) => {
      const inspectWriterLock = vi.fn(async () => {
        if (inspection === "throw") throw new Error("lock inspection failed");
        return inspection === "held"
          ? { kind: "held", owner: { pid: 2002, startIdentity: "start-2002" } }
          : { kind: "unavailable" };
      });
      const fixture = await connectedDispatcherFixture({
        reconnectSleep: async () => undefined,
        inspectWriterLock,
      });

      try {
        fixture.endpoint.currentConnection!.close();
        await vi.waitFor(() => expect(fixture.connectSocket).toHaveBeenCalledTimes(2), {
          timeout: 1_000,
        });
        expect(inspectWriterLock).toHaveBeenCalledOnce();
        expect(hasLostRunner(fixture.dispatcher)).toBe(false);
      } finally {
        await fixture.dispatcher.detachHost().catch(() => undefined);
        await fixture.endpoint.close();
      }
    },
  );

  it("lets terminal retirement finish when its activity query dispatches during a lost-runner reconnect", async () => {
    const firstSleepStarted = deferred<void>();
    const releaseFirstSleep = deferred<void>();
    const releaseLaterSleep = deferred<void>();
    let sleepCount = 0;
    const inspectWriterLock = vi.fn(async () => ({ kind: "free" }));
    const retireTerminalRegistration = vi.fn(async () => undefined);
    const fixture = await connectedDispatcherFixture({
      reconnectSleep: async () => {
        sleepCount += 1;
        if (sleepCount === 1) {
          firstSleepStarted.resolve();
          await releaseFirstSleep.promise;
        } else {
          await releaseLaterSleep.promise;
        }
      },
      inspectWriterLock,
      retireTerminalRegistration,
      connectSocketAttempt: async (attempt, socketPath, options) => {
        if (attempt === 1) return await connectRunnerSocket(socketPath, options);
        throw new Error("ECONNREFUSED");
      },
    });
    const engine = new RunnerProcessEngineProxy(
      "codex",
      "/workspace/a",
      fixture.dispatcher,
    );
    const activityStarted = deferred<void>();
    let activityError: unknown;

    try {
      fixture.endpoint.currentConnection!.close();
      await firstSleepStarted.promise;
      const retirement = fixture.dispatcher.retireTerminalRegistration(async () => {
        const query = engine.codexDetachedCommandActivity();
        activityStarted.resolve();
        try {
          await query;
        } catch (error) {
          activityError = error;
        }
      });
      await activityStarted.promise;
      releaseFirstSleep.resolve();

      const retirementOutcome = await observePromise(retirement, 500);
      expect(retirementOutcome.status).toBe("resolved");
      expect(activityError).toMatchObject({
        message: "Runner process is unavailable: session-a",
      });
      expect(fixture.connectSocket).toHaveBeenCalledOnce();
      expect(inspectWriterLock).toHaveBeenCalledOnce();
      expect(retireTerminalRegistration).toHaveBeenCalledOnce();
      expect(fixture.dispatcher.isClosed()).toBe(true);
    } finally {
      releaseFirstSleep.resolve();
      releaseLaterSleep.resolve();
      await fixture.dispatcher.detachHost().catch(() => undefined);
      await fixture.endpoint.close();
    }
  });

  it("classifies only the exact closed-engine failure from Claude", () => {
    const exact = {
      code: "execution_failed",
      message: "ClaudeEngineAdapter.execute called after close()",
    };

    expect(isClosedClaudeEngineFailure("claude", exact)).toBe(true);
    expect(isClosedClaudeEngineFailure("codex", exact)).toBe(false);
    expect(isClosedClaudeEngineFailure("claude", {
      ...exact,
      code: "close_failed",
    })).toBe(false);
    expect(isClosedClaudeEngineFailure("claude", {
      ...exact,
      message: `${exact.message} while preparing`,
    })).toBe(false);
    expect(isClosedClaudeEngineFailure("claude", {
      ...exact,
      message: `wrapped: ${exact.message}`,
    })).toBe(false);
  });

  it("continues settling close host-calls after closing admission", async () => {
    const fixture = await spawnedInitializationFixture();
    let allowCloseAck!: () => void;
    let closeCommandSeen!: () => void;
    const closeAck = new Promise<void>((resolve) => { allowCloseAck = resolve; });
    const closeSeen = new Promise<void>((resolve) => { closeCommandSeen = resolve; });
    const terminate = vi.fn(async () => undefined);
    const hostCall = vi.fn(async () => ({ released: true }));
    const responseSent = vi.fn(async () => { allowCloseAck(); });
    const dispatcher = Object.create(RunnerProcessDispatcher.prototype) as
      RunnerProcessDispatcher & {
        trackFrameHandler(frame: ReturnType<typeof runnerRequestFrame>): Promise<void>;
      };
    Object.assign(dispatcher, {
      ready: Promise.resolve(),
      spawnedProcess: fixture.spawned,
      spawnInput: spawnInput(fixture.stateDirectory),
      closed: false,
      inFlightFrameHandlers: new Set<Promise<void>>(),
      inFlightClaudeRuntimeObservations: new Set<Promise<void>>(),
      requestLifetimes: new Map(),
      recentHostResponses: new Map(),
      dispatch: async (frame: { commandId: string }) => {
        closeCommandSeen();
        await closeAck;
        return runnerCommandResultFrame(frame.commandId, { status: "ok" });
      },
      releaseHostResources: vi.fn(async () => undefined),
      options: {
        logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
        spawner: { terminate },
        handleHostCall: hostCall,
      },
      hostCallIdempotency: {
        execute: async (
          call: { correlationId: string },
          apply: (key: string) => Promise<unknown>,
        ) => ({
          data: await apply(call.correlationId), replayed: false,
        }),
      },
      connection: { send: responseSent, close: vi.fn() },
      sendBestEffort: async (frame: unknown) => await responseSent(frame),
    });

    const closing = dispatcher.close();
    await closeSeen;
    await dispatcher.trackFrameHandler(runnerRequestFrame("release-during-close", {
      kind: "host_call",
      service: "claude_accounts",
      operation: "release",
      args: [],
    }));
    const settledBeforeFallback = await Promise.race([
      closing.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    allowCloseAck();
    await closing;

    expect(settledBeforeFallback).toBe(true);
    expect(hostCall).toHaveBeenCalledOnce();
    expect(responseSent).toHaveBeenCalledWith(expect.objectContaining({
      kind: "response",
      correlationId: "release-during-close",
    }));
    expect(terminate).toHaveBeenCalledWith(fixture.spawned.paths, {
      registrationId: fixture.spawned.registrationId,
      pid: fixture.spawned.pid,
      startIdentity: "start-7101",
    });
    await dispatcher.trackFrameHandler(runnerRequestFrame("after-close", {
      kind: "host_call",
      service: "claude_accounts",
      operation: "release",
      args: [],
    }));
    expect(hostCall).toHaveBeenCalledOnce();
  });

  it("forwards terminal registration retirement with the spawned generation", async () => {
    const retireTerminalRegistration = vi.fn(async () => {});
    const dispatcher = Object.create(RunnerProcessDispatcher.prototype) as
      RunnerProcessDispatcher;
    const spawned = {
      registrationId: "registration-a",
      paths: { sessionDirectory: "/state/session-a" },
    };
    Object.assign(dispatcher, {
      ready: Promise.resolve(),
      spawnedProcess: spawned,
      spawnInput: { sessionId: "session-a" },
      options: {
        spawner: { retireTerminalRegistration },
        logger: { info: vi.fn() },
      },
      activeExecution: undefined,
      closed: false,
      inFlightFrameHandlers: new Set(),
      recentHostResponses: new Map(),
      requestLifetimes: new Map(),
    });

    await dispatcher.retireTerminalRegistration();

    expect(retireTerminalRegistration).toHaveBeenCalledWith(
      spawned.paths,
      "registration-a",
    );
  });

  it("does not settle the previous execution when the active execution turns over during the lifecycle read", async () => {
    let resolveLifecycle: (value: unknown) => void = () => {};
    const lifecycleRead = new Promise<unknown>((resolve) => {
      resolveLifecycle = resolve;
    });
    const previousStream = new ProcessFrameStream(async () => {});
    const currentStream = new ProcessFrameStream(async () => {});
    const previous = {
      commandId: "command-a",
      registrationId: undefined,
      stream: previousStream,
      acceptsInterventions: true,
    };
    const current = {
      commandId: "command-b",
      registrationId: undefined,
      stream: currentStream,
      acceptsInterventions: true,
    };
    const dispatcher = Object.create(RunnerProcessDispatcher.prototype) as
      RunnerProcessDispatcher;
    Object.assign(dispatcher, {
      outbox: { readLifecycle: async () => await lifecycleRead },
      spawnInput: { backend: "claude" },
      spawnedProcess: undefined,
      activeExecution: previous,
      requestLifetimes: new Map(),
    });

    const reconciliation = (dispatcher as unknown as {
      reconcileActiveLifecycleTerminal: () => Promise<boolean>;
    }).reconcileActiveLifecycleTerminal();
    (dispatcher as unknown as { activeExecution: unknown }).activeExecution = current;
    resolveLifecycle({
      session_id: "session-a",
      runner_pid: 1001,
      execution_command_id: "command-a",
      execution_state: "completed",
      progress_seq: 2,
      progress_at: "2026-09-02T04:52:10.000Z",
      liveness_at: "2026-09-02T04:52:10.000Z",
      in_flight_tools: [],
      terminal_error: null,
    });

    await expect(reconciliation).resolves.toBe(false);
    expect(previousStream.isSettled()).toBe(false);
    expect(currentStream.isSettled()).toBe(false);
    expect(dispatcher.activeExecutionCommandId()).toBe("command-b");
  });

  it("completes close when restricted preparation fails before any spawn", async () => {
    const terminate = vi.fn(async () => {});
    const dispatcher = Object.create(RunnerProcessDispatcher.prototype) as
      RunnerProcessDispatcher;
    const failure = new IsolationPreparationPolicyError("policy unavailable");
    Object.assign(dispatcher, {
      ready: Promise.reject(failure),
      spawnedProcess: undefined,
      spawnInput: { sessionId: "session-a" },
      options: {
        spawner: { terminate },
        logger: { info: vi.fn() },
      },
      activeExecution: undefined,
      closed: false,
      inFlightFrameHandlers: new Set(),
      recentHostResponses: new Map(),
      requestLifetimes: new Map(),
    });

    await expect(dispatcher.close()).resolves.toBeUndefined();

    expect(dispatcher.isClosed()).toBe(true);
    expect(terminate).not.toHaveBeenCalled();
  });

  it("completes terminal retirement when restricted preparation failed before any spawn", async () => {
    const retireTerminalRegistration = vi.fn(async () => {});
    const beforeRegistrationRetired = vi.fn(async () => {});
    const dispatcher = Object.create(RunnerProcessDispatcher.prototype) as
      RunnerProcessDispatcher;
    const failure = new IsolationPreparationPolicyError("policy unavailable");
    Object.assign(dispatcher, {
      ready: Promise.reject(failure),
      spawnedProcess: undefined,
      spawnInput: { sessionId: "session-a" },
      options: {
        spawner: { retireTerminalRegistration },
        logger: { info: vi.fn() },
      },
      activeExecution: undefined,
      closed: false,
      inFlightFrameHandlers: new Set(),
      recentHostResponses: new Map(),
      requestLifetimes: new Map(),
    });

    await expect(
      dispatcher.retireTerminalRegistration(beforeRegistrationRetired),
    ).resolves.toBeUndefined();

    expect(dispatcher.isClosed()).toBe(true);
    expect(beforeRegistrationRetired).not.toHaveBeenCalled();
    expect(retireTerminalRegistration).not.toHaveBeenCalled();
  });

  it("propagates a pre-spawn failure once a child was spawned, without terminating it", async () => {
    const terminate = vi.fn(async () => {});
    const dispatcher = Object.create(RunnerProcessDispatcher.prototype) as
      RunnerProcessDispatcher;
    const failure = new IsolationPreparationPolicyError("policy unavailable");
    const spawned = {
      registrationId: "registration-a",
      paths: { sessionDirectory: "/state/session-a" },
    };
    Object.assign(dispatcher, {
      ready: Promise.reject(failure),
      spawnedProcess: spawned,
      spawnInput: { sessionId: "session-a" },
      options: {
        spawner: { terminate },
        logger: { info: vi.fn() },
      },
      activeExecution: undefined,
      closed: false,
      inFlightFrameHandlers: new Set(),
      recentHostResponses: new Map(),
      requestLifetimes: new Map(),
    });

    await expect(dispatcher.close()).rejects.toBe(failure);
    await expect(dispatcher.retireTerminalRegistration()).rejects.toBe(failure);

    expect(terminate).not.toHaveBeenCalled();
  });

  it("rejects a running recovery when its exact registration is retired", async () => {
    const stateDirectory = await temporaryDirectory();
    const paths = runnerProcessPaths(stateDirectory, "session-a");
    await mkdir(paths.sessionDirectory, { recursive: true });
    const outbox = await RunnerSqliteEventOutbox.create(paths.databasePath);
    await outbox.initializeBootstrap({
      session_id: "session-a",
      created_at: "2026-09-02T04:52:10.000Z",
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
      progressedAt: "2026-09-02T04:52:10.000Z",
    });
    lifecycle.close();
    const endpoint = new RunnerSocketEndpoint(
      paths.socketPath,
      async () => undefined,
      vi.fn(),
    );
    await endpoint.listen();
    const retireTerminalRegistration = vi.fn(async () => {});
    const dispatcher = new RunnerProcessDispatcher({
      spawn: spawnInput(stateDirectory),
      runnerProcess: spawnedProcessForTest(paths),
      spawner: { retireTerminalRegistration },
      pumpMux: new EventOutboxPumpMux(new EventOutboxPump(emptyStore("node-stream"), vi.fn())),
      logger: pino({ level: "silent" }),
      handleHostCall: async () => null,
    });

    const recovery = collect(dispatcher.recoverFrames("execute-old"));
    // Attach the rejection expectation before retirement so the worker-backed
    // close path cannot surface the stream failure as an unhandled rejection.
    const recoveryFailure = expect(recovery).rejects.toThrow(
      "runner registration retired before terminal frame replay",
    );
    await vi.waitFor(() => expect(dispatcher.hasActiveExecution()).toBe(true));
    await dispatcher.retireTerminalRegistration();

    await recoveryFailure;
    expect(dispatcher.activeExecutionCommandId()).toBeUndefined();
    expect(dispatcher.isClosed()).toBe(true);
    expect(retireTerminalRegistration).toHaveBeenCalledWith(
      paths,
      expect.any(String),
    );
    await endpoint.close();
  });

  it("released event stream registration은 뒤늦은 pump 등록도 남기지 않는다", async () => {
    // An adoption can be rejected before the pump has started registering, so
    // releasing the registration finds nothing to release and the registration
    // lands afterwards -- owned by a dispatcher nobody holds. The next turn
    // then cannot register the session's stream at all and answers nothing
    // ("Durable event stream already registered", 260822 lab F9 next turn).
    //
    // The dispatcher is built without its spawn path on purpose: the contract
    // under test is two lines of pump bookkeeping, and starting a real child
    // would only add an unrelated failure mode to a test about them.
    const registerPump = vi.fn(() => vi.fn());
    const dispatcher = Object.create(RunnerProcessDispatcher.prototype) as
      RunnerProcessDispatcher & { ensurePump(): Promise<void> };
    Object.assign(dispatcher, {
      options: { pumpMux: { register: registerPump } },
      eventStreamReleased: false,
      pump: undefined,
      pumpInitialization: undefined,
      unregisterPump: undefined,
    });

    await dispatcher.releaseEventStreamRegistration();
    await dispatcher.ensurePump();

    expect(registerPump).not.toHaveBeenCalled();
  });

  it("[A2] sends the host response before continuation and logs continuation failure", async () => {
    const order: string[] = [];
    const sent: unknown[] = [];
    const warn = vi.fn();
    const dispatcher = Object.create(RunnerProcessDispatcher.prototype) as
      RunnerProcessDispatcher & {
        handleHostRequest(
          frame: ReturnType<typeof runnerRequestFrame>,
        ): Promise<(() => Promise<void>) | undefined>;
      };
    Object.assign(dispatcher, {
      options: {
        logger: { warn },
        handleHostCall: async (
          _call: unknown,
          registerPostResponse: (continuation: () => Promise<void>) => void,
        ) => {
          order.push("publish");
          registerPostResponse(async () => {
            order.push("continuation");
            throw new Error("follow-up failed");
          });
          return { published: true };
        },
      },
      recentHostResponses: new Map(),
      hostCallIdempotency: {
        execute: async (
          _call: unknown,
          apply: (idempotencyKey: string) => Promise<unknown>,
        ) => ({ data: await apply("host:a2"), replayed: false }),
      },
      sendBestEffort: async (frame: unknown) => {
        order.push("response");
        sent.push(frame);
      },
    });

    const continuation = await dispatcher.handleHostRequest(runnerRequestFrame("host:a2", {
      kind: "host_call",
      service: "detached_event",
      operation: "publish",
      args: ["session-a", { type: "text", text: "done", timestamp: 1 }],
    }));
    await continuation?.();

    expect(order).toEqual(["publish", "response", "continuation"]);
    expect(sent).toEqual([
      expect.objectContaining({
        kind: "response",
        result: expect.objectContaining({ status: "ok" }),
      }),
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: "host:a2" }),
      "Runner host post-response continuation failed; durable delivery remains pending",
    );
  });

  it("[A2] removes the current host handler before a continuation closes its stream owner", async () => {
    const mux = new EventOutboxPumpMux(
      new EventOutboxPump(emptyStore("node-stream"), vi.fn()),
    );
    const firstPump = new EventOutboxPump(emptyStore("runner-stream"), vi.fn());
    const unregisterFirst = vi.fn(mux.register(firstPump));
    const responses: string[] = [];
    const dispatcher = Object.create(RunnerProcessDispatcher.prototype) as
      RunnerProcessDispatcher;
    Object.assign(dispatcher, {
      closed: false,
      eventStreamReleased: false,
      finishActiveRunnerObservation: undefined,
      inFlightFrameHandlers: new Set<Promise<void>>(),
      inFlightClaudeRuntimeObservations: new Set<Promise<void>>(),
      recentHostResponses: new Map(),
      requestLifetimes: new Map(),
      pump: firstPump,
      pumpInitialization: undefined,
      unregisterPump: unregisterFirst,
      outbox: { close: vi.fn() },
      options: {
        offlineExisting: true,
        logger: { info: vi.fn(), warn: vi.fn() },
        handleHostCall: async (
          _call: unknown,
          registerPostResponse: (continuation: () => Promise<void>) => void,
        ) => {
          registerPostResponse(async () => await dispatcher.close());
          return { published: true };
        },
      },
      hostCallIdempotency: {
        execute: async (
          call: { correlationId: string },
          apply: (idempotencyKey: string) => Promise<unknown>,
        ) => ({ data: await apply(call.correlationId), replayed: false }),
      },
      connection: {
        send: async (frame: { correlationId?: string }) => {
          responses.push(frame.correlationId ?? "missing");
        },
        close: vi.fn(),
      },
    });
    const tracked = dispatcher as unknown as {
      trackFrameHandler(frame: ReturnType<typeof runnerRequestFrame>): Promise<void>;
    };

    const handling = tracked.trackFrameHandler(runnerRequestFrame("host:self-close", {
      kind: "host_call",
      service: "detached_event",
      operation: "publish",
      args: ["session-a", { type: "text", text: "done", timestamp: 1 }],
    }));
    const settled = await Promise.race([
      handling.then(() => true),
      new Promise<false>((resolve) => setImmediate(() => resolve(false))),
    ]);

    expect(responses).toEqual(["host:self-close"]);
    expect(settled).toBe(true);
    expect(unregisterFirst).toHaveBeenCalledTimes(1);
    expect(() => mux.register(
      new EventOutboxPump(emptyStore("runner-stream"), vi.fn()),
    )).not.toThrow();
  });

  it("logs host resource release when spawn input is unavailable", async () => {
    const info = vi.fn();
    const dispatcher = Object.create(RunnerProcessDispatcher.prototype) as
      RunnerProcessDispatcher;
    Object.assign(dispatcher, {
      instanceId: "dispatcher-without-spawn",
      spawnInput: undefined,
      socketPath: undefined,
      options: { logger: { info } },
      connection: undefined,
      pumpInitialization: undefined,
      finishActiveRunnerObservation: undefined,
      unregisterPump: undefined,
      outbox: undefined,
      stoppedRunnerWriter: undefined,
      stoppedRunnerWriterLock: undefined,
      inFlightFrameHandlers: new Set<Promise<void>>(),
    });
    const releaser = dispatcher as unknown as {
      releaseHostResources(reason: "close"): Promise<void>;
    };

    await expect(releaser.releaseHostResources("close")).resolves.toBeUndefined();

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith({
      dispatcherId: "dispatcher-without-spawn",
      sessionId: undefined,
      socketPath: undefined,
      reason: "close",
      hadConnection: false,
    }, "Runner host IPC connection released");
  });

  it("waits for an exact Claude runtime observation before detached follow-up admission", async () => {
    const fixture = await spawnedInitializationFixture();
    let releaseObservation!: () => void;
    const observationGate = new Promise<void>((resolve) => {
      releaseObservation = resolve;
    });
    const mutations: string[] = [];
    const receipts: string[] = [];
    const responses: string[] = [];
    const admissions: string[] = [];
    const trackedObservations = new Set<Promise<void>>();
    const dispatcher = Object.create(RunnerProcessDispatcher.prototype) as
      RunnerProcessDispatcher;
    Object.assign(dispatcher, {
      ready: Promise.resolve(),
      spawnedProcess: fixture.spawned,
      spawnInput: spawnInput(fixture.stateDirectory),
      closed: false,
      inFlightFrameHandlers: new Set<Promise<void>>(),
      inFlightClaudeRuntimeObservations: trackedObservations,
      recentHostResponses: new Map(),
      options: {
        logger: { warn: vi.fn() },
        handleHostCall: async (
          call: { correlationId: string; service: string; operation: string },
          registerPostResponse: (continuation: () => Promise<void>) => void,
        ) => {
          if (call.service === "claude_runtime" && call.operation === "observe") {
            mutations.push(call.correlationId);
            await observationGate;
            return { observed: true };
          }
          registerPostResponse(async () => {
            const identity = await dispatcher.prepareExecutionIdentity("execution-E2");
            admissions.push(identity.executionCommandId);
          });
          return { published: true };
        },
      },
      hostCallIdempotency: {
        execute: async (
          call: { correlationId: string },
          apply: (idempotencyKey: string) => Promise<unknown>,
        ) => {
          const data = await apply(call.correlationId);
          receipts.push(call.correlationId);
          return { data, replayed: false };
        },
      },
      connection: {
        send: async (frame: { correlationId?: string }) => {
          responses.push(frame.correlationId ?? "missing");
        },
      },
    });
    const tracked = dispatcher as unknown as {
      trackFrameHandler(frame: ReturnType<typeof runnerRequestFrame>): Promise<void>;
    };

    const observing = tracked.trackFrameHandler(runnerRequestFrame("host:observe", {
      kind: "host_call",
      service: "claude_runtime",
      operation: "observe",
      args: [{ type: "task_progress", task_id: "task-E1" }],
    }));
    await vi.waitFor(() => expect(mutations).toEqual(["host:observe"]));
    expect(trackedObservations.size).toBe(1);
    const detached = tracked.trackFrameHandler(runnerRequestFrame("host:detached", {
      kind: "host_call",
      service: "detached_event",
      operation: "publish",
      args: ["session-a", { type: "task_notification", task_id: "task-E1" }],
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(admissions).toEqual([]);
    expect(responses).not.toContain("host:observe");

    releaseObservation();
    await Promise.all([observing, detached]);

    expect(trackedObservations.size).toBe(0);
    expect(admissions).toEqual(["execution-E2"]);
    expect(mutations).toEqual(["host:observe"]);
    expect(receipts.filter((value) => value === "host:observe")).toHaveLength(1);
    expect(responses.filter((value) => value === "host:observe")).toHaveLength(1);
  });

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
      runnerProcess: null,
      offlineExisting: true,
      pumpMux: new EventOutboxPumpMux(new EventOutboxPump(emptyStore("node-stream"), vi.fn())),
      logger,
      handleHostCall: async () => null,
    } as never);

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
      runnerProcess: null,
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

  it("waits for in-flight frame handlers before closing runner-host.sqlite", async () => {
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
      runnerProcess: null,
      offlineExisting: true,
      pumpMux: new EventOutboxPumpMux(new EventOutboxPump(emptyStore("node-stream"), vi.fn())),
      logger: pino({ level: "silent" }),
      handleHostCall: async () => null,
    });
    await dispatcher.recoverPendingInterventions();
    let releaseFrame!: () => void;
    const inFlightFrame = new Promise<void>((resolve) => { releaseFrame = resolve; });
    (dispatcher as unknown as { inFlightFrameHandlers: Set<Promise<void>> })
      .inFlightFrameHandlers = new Set([inFlightFrame]);
    let closed = false;

    const closing = dispatcher.close().then(() => { closed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);

    releaseFrame();
    await closing;
    expect(closed).toBe(true);
  });

  it.each(["outbox", "socket"] as const)(
    "identity-fenced rollback removes a spawned child after %s parent initialization failure",
    async (failurePoint) => {
      const fixture = await spawnedInitializationFixture();
      const terminate = vi.fn(async () => {});
      const close = vi.fn();
      const dispatcher = new RunnerProcessDispatcher({
        spawn: spawnInput(fixture.stateDirectory),
        runnerProcess: fixture.spawned,
        spawner: { terminate },
        openParentOutbox: failurePoint === "outbox"
          ? async () => { throw new Error("outbox open failed"); }
          : async () => ({ close } as never),
        connectSocket: async () => { throw new Error("socket connect failed"); },
        pumpMux: new EventOutboxPumpMux(new EventOutboxPump(emptyStore("node-stream"), vi.fn())),
        logger: pino({ level: "silent" }),
        handleHostCall: async () => null,
      });

      await expect(dispatcher.prepareExecutionIdentity()).rejects.toThrow(
        failurePoint === "outbox" ? "outbox open failed" : "socket connect failed",
      );
      expect(terminate).toHaveBeenCalledWith(fixture.paths, {
        pid: 7101,
        startIdentity: "start-7101",
      });
      if (failurePoint === "socket") expect(close).toHaveBeenCalledOnce();
    },
  );

  it("hands an unkillable spawned child to durable orphaned_spawn recovery", async () => {
    const fixture = await spawnedInitializationFixture();
    const dispatcher = new RunnerProcessDispatcher({
      spawn: spawnInput(fixture.stateDirectory),
      runnerProcess: fixture.spawned,
      spawner: {
        terminate: async () => { throw new Error("child remained alive"); },
      },
      openParentOutbox: async () => { throw new Error("outbox open failed"); },
      connectSocket: async () => { throw new Error("must not connect"); },
      pumpMux: new EventOutboxPumpMux(new EventOutboxPump(emptyStore("node-stream"), vi.fn())),
      logger: pino({ level: "silent" }),
      handleHostCall: async () => null,
    });

    const error = await dispatcher.prepareExecutionIdentity().then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(RunnerOrphanedSpawnError);
    expect(error).toMatchObject({
      proof: {
        registrationId: expect.any(String),
        pid: 7101,
        startIdentity: "start-7101",
        executionCommandId: expect.stringMatching(/^command:/),
      },
    });
  });

  it("leaves a legacy host fallback inert through apply and the next execute", async () => {
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
    const commandKinds: string[] = [];
    let endpoint!: RunnerSocketEndpoint;
    endpoint = new RunnerSocketEndpoint(paths.socketPath, async (frame) => {
      if (frame.channel !== "command") return;
      commandKinds.push(frame.kind === "invoke" ? String(frame.capability) : frame.kind);
      if (frame.kind === "stage_intervention") {
        const staged = await writer.stageIntervention({
          interventionId: frame.interventionId,
          message: frame.message,
          ...(frame.event
            ? { event: (await buildDurableRunnerEvent("session-a", frame.event as never)).appendInput }
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
      if (frame.kind === "execute") {
        await endpoint.currentConnection!.send(executionEndedControlFrame(frame.commandId));
      }
    }, vi.fn());
    await endpoint.listen();
    const primary = new EventOutboxPump(emptyStore("node-stream"), vi.fn());
    const mux = new EventOutboxPumpMux(primary);
    const dispatcher = new RunnerProcessDispatcher({
      spawn: spawnInput(stateDirectory),
      runnerProcess: spawnedProcessForTest(paths),
      pumpMux: mux,
      logger: pino({ level: "silent" }),
      handleHostCall: async () => null,
    });

    const fallback = RunnerHostStateStore.open(runnerHostStatePath(paths.databasePath));
    expect(fallback.stageInterventionFallback({
      sessionId: "session-a",
      interventionId: "intervention-a",
      message: { text: "stop now", user: "alice" },
      queued: false,
      stagedAt: "2026-08-17T00:00:00.500Z",
    })).toEqual({ queuePosition: 0 });
    fallback.close();
    expect(await dispatcher.recoverPendingInterventions()).toEqual([{
      interventionId: "intervention-a",
      message: { text: "stop now", user: "alice" },
    }]);

    await expect(dispatcher.applyIntervention({
      interventionId: "intervention-a",
      input: { prompt: "stop now" },
    })).resolves.toMatchObject({ status: "delivered" });
    await expect(collect(dispatcher.executeFrames({
      agentSessionId: "session-a",
      prompt: "next turn",
      runnerInterventionIds: ["intervention-a"],
    }))).resolves.toEqual([]);

    expect(commandKinds).toEqual([
      "runner.apply_intervention",
      "execute",
    ]);
    const host = RunnerHostStateStore.open(runnerHostStatePath(paths.databasePath));
    expect(host.readInterventionFallback("session-a", "intervention-a")).toMatchObject({
      interventionId: "intervention-a",
      message: { text: "stop now", user: "alice" },
      queued: false,
    });
    host.close();
    await dispatcher.close();
    writer.close();
    await endpoint.close();
  });

  it("does not accept execute when another pump owns the bootstrap stream", async () => {
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
    const execute = vi.fn();
    let endpoint!: RunnerSocketEndpoint;
    endpoint = new RunnerSocketEndpoint(paths.socketPath, async (frame) => {
      if (frame.channel !== "command") return;
      if (frame.kind === "execute") execute();
      await endpoint.currentConnection!.send(
        runnerCommandResultFrame(frame.commandId, { status: "ok" }),
      );
      if (frame.kind === "execute") {
        await endpoint.currentConnection!.send(executionEndedControlFrame(frame.commandId));
      }
    }, vi.fn());
    await endpoint.listen();
    const mux = new EventOutboxPumpMux(
      new EventOutboxPump(emptyStore("node-stream"), vi.fn()),
    );
    const unregisterExistingPump = mux.register(
      new EventOutboxPump(emptyStore(bootstrap.stream_id), vi.fn()),
    );
    const dispatcher = new RunnerProcessDispatcher({
      spawn: spawnInput(stateDirectory),
      runnerProcess: spawnedProcessForTest(paths),
      pumpMux: mux,
      logger: pino({ level: "silent" }),
      handleHostCall: async () => null,
    });

    try {
      await dispatcher.prepareExecutionIdentity("owner-test");
      await expect(collect(dispatcher.executeFrames({
        agentSessionId: "session-a",
        prompt: "hello",
      }))).rejects.toThrow(`Durable event stream already registered: ${bootstrap.stream_id}`);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await dispatcher.close();
      unregisterExistingPump();
      writer.close();
      await endpoint.close();
    }
  });

  it("waits for delayed bootstrap preparation before accepting execute", async () => {
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
    let resolveBootstrapReadStarted!: () => void;
    const bootstrapReadStarted = new Promise<void>((resolve) => {
      resolveBootstrapReadStarted = resolve;
    });
    let releaseBootstrapRead!: () => void;
    const bootstrapReadGate = new Promise<void>((resolve) => {
      releaseBootstrapRead = resolve;
    });
    const execute = vi.fn();
    let endpoint!: RunnerSocketEndpoint;
    endpoint = new RunnerSocketEndpoint(paths.socketPath, async (frame) => {
      if (frame.channel !== "command") return;
      if (frame.kind === "execute") execute();
      await endpoint.currentConnection!.send(
        runnerCommandResultFrame(frame.commandId, { status: "ok" }),
      );
      if (frame.kind === "execute") {
        await endpoint.currentConnection!.send(executionEndedControlFrame(frame.commandId));
      }
    }, vi.fn());
    await endpoint.listen();
    const dispatcher = new RunnerProcessDispatcher({
      spawn: spawnInput(stateDirectory),
      runnerProcess: spawnedProcessForTest(paths),
      openParentOutbox: async (databasePath, sessionId, options) => {
        const outbox = await RunnerParentOutbox.open(databasePath, sessionId, options);
        const readBootstrap = outbox.readBootstrap.bind(outbox);
        vi.spyOn(outbox, "readBootstrap").mockImplementation(async () => {
          resolveBootstrapReadStarted();
          await bootstrapReadGate;
          return await readBootstrap();
        });
        return outbox;
      },
      pumpMux: new EventOutboxPumpMux(
        new EventOutboxPump(emptyStore("node-stream"), vi.fn()),
      ),
      logger: pino({ level: "silent" }),
      handleHostCall: async () => null,
    });
    await dispatcher.prepareExecutionIdentity("owner-test");
    const stream = dispatcher.executeFrames({
      agentSessionId: "session-a",
      prompt: "hello",
    });
    const streamResult = collect(stream);

    try {
      await bootstrapReadStarted;
      expect(execute).not.toHaveBeenCalled();
      releaseBootstrapRead();
      await expect(streamResult).resolves.toEqual([]);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      releaseBootstrapRead();
      await streamResult.catch(() => undefined);
      await dispatcher.close();
      writer.close();
      await endpoint.close();
    }
  });

  it("executes the first turn without a bootstrap and registers it after bootstrap appears", async () => {
    const stateDirectory = await temporaryDirectory();
    const paths = runnerProcessPaths(stateDirectory, "session-a");
    await mkdir(paths.sessionDirectory, { recursive: true });
    const writer = await RunnerSqliteEventOutbox.create(paths.databasePath);
    const execute = vi.fn();
    let createdBootstrap: { stream_id: string } | undefined;
    let endpoint!: RunnerSocketEndpoint;
    endpoint = new RunnerSocketEndpoint(paths.socketPath, async (frame) => {
      if (frame.channel !== "command") return;
      await endpoint.currentConnection!.send(
        runnerCommandResultFrame(frame.commandId, { status: "ok" }),
      );
      if (frame.kind !== "execute") return;
      execute();
      createdBootstrap = await writer.initializeBootstrap({
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
      await endpoint.currentConnection!.send(outboxAvailableControlFrame(1));
      await endpoint.currentConnection!.send(executionEndedControlFrame(frame.commandId));
    }, vi.fn());
    await endpoint.listen();
    const mux = new EventOutboxPumpMux(
      new EventOutboxPump(emptyStore("node-stream"), vi.fn()),
    );
    const registerPump = vi.spyOn(mux, "register");
    const dispatcher = new RunnerProcessDispatcher({
      spawn: spawnInput(stateDirectory),
      runnerProcess: spawnedProcessForTest(paths),
      pumpMux: mux,
      logger: pino({ level: "silent" }),
      handleHostCall: async () => null,
    });

    try {
      await dispatcher.prepareExecutionIdentity("owner-test");
      await expect(collect(dispatcher.executeFrames({
        agentSessionId: "session-a",
        prompt: "hello",
      }))).resolves.toEqual([]);
      await vi.waitFor(() => expect(registerPump).toHaveBeenCalledTimes(1));
      expect(execute).toHaveBeenCalledTimes(1);
      expect(registerPump).toHaveBeenCalledWith(
        expect.objectContaining({ streamId: createdBootstrap!.stream_id }),
      );
    } finally {
      await dispatcher.close();
      writer.close();
      await endpoint.close();
    }
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
      runnerProcess: spawnedProcessForTest(paths),
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
    const observedTransactionLabels = sqliteTransactionObserver.mock.calls.map(
      ([event]) => (event as { transactionLabel: string }).transactionLabel,
    );
    expect(observedTransactionLabels).toEqual(expect.arrayContaining([
      "runner_host.initialize_checkpoint",
      "runner_host.acknowledge_event",
    ]));
    expect(observedTransactionLabels.every(
      (label) => label.startsWith("runner_host."),
    )).toBe(true);
    await expect(dispatcher.waitForSessionAck()).resolves.toBeNull();
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

  it("replays only the current registration and settles stale registration IPC frames", async () => {
    const stateDirectory = await temporaryDirectory();
    const paths = runnerProcessPaths(stateDirectory, "session-a");
    await mkdir(paths.sessionDirectory, { recursive: true });
    const registrationA = {
      ...pendingRunnerRegistrationIdentity("session-a", "sha-a"),
      pid: 1001,
      startIdentity: "start-1001",
    };
    await writeRunnerRegistrationIdentity(paths.sessionDirectory, registrationA);
    const writerA = await RunnerSqliteEventOutbox.create(paths.databasePath);
    await writerA.initializeBootstrap({
      session_id: "session-a",
      created_at: "2026-09-03T08:27:49.000Z",
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
    await writerA.appendEngineFrame({
      session_id: "session-a",
      event_type: "assistant_message",
      payload: { type: "assistant_message", content: "registration-a-stale" },
      searchable_text: "registration-a-stale",
      created_at: "2026-09-03T08:27:50.000Z",
      semantic_dedupe_key: null,
      session_effect: null,
    }, {
      protocolVersion: 1,
      channel: "event",
      kind: "engine_event",
      payload: { type: "assistant_message", content: "registration-a-stale" },
    });
    writerA.close();

    const registrationB = {
      ...pendingRunnerRegistrationIdentity("session-a", "sha-b"),
      pid: 1002,
      startIdentity: "start-1002",
    };
    await writeRunnerRegistrationIdentity(paths.sessionDirectory, registrationB);
    const writerB = await RunnerSqliteEventOutbox.open(paths.databasePath);
    await writerB.appendEngineFrame({
      session_id: "session-a",
      event_type: "assistant_message",
      payload: { type: "assistant_message", content: "registration-b-current" },
      searchable_text: "registration-b-current",
      created_at: "2026-09-03T09:00:38.000Z",
      semantic_dedupe_key: null,
      session_effect: null,
    }, {
      protocolVersion: 1,
      channel: "event",
      kind: "engine_event",
      payload: { type: "assistant_message", content: "registration-b-current" },
    });

    let endpoint!: RunnerSocketEndpoint;
    endpoint = new RunnerSocketEndpoint(paths.socketPath, async (frame) => {
      if (frame.channel === "control" && frame.kind === "host_frame_applied") {
        await writerB.acknowledgeHostFrame(frame.frameSeq);
        return;
      }
      if (frame.channel !== "command") return;
      await endpoint.currentConnection!.send(
        runnerCommandResultFrame(frame.commandId, { status: "ok" }),
      );
      if (frame.kind === "execute") {
        await endpoint.currentConnection!.send(executionEndedControlFrame(frame.commandId));
      }
    }, vi.fn());
    await endpoint.listen();
    const dispatcher = new RunnerProcessDispatcher({
      spawn: spawnInput(stateDirectory),
      runnerProcess: Promise.resolve({
        pid: registrationB.pid,
        registrationId: registrationB.registrationId,
        paths,
        config: {} as never,
        adopted: false,
      }),
      pumpMux: new EventOutboxPumpMux(new EventOutboxPump(emptyStore("node-stream"), vi.fn())),
      logger: pino({ level: "silent" }),
      handleHostCall: async () => null,
    });

    const frames = await collect(dispatcher.executeFrames({
      agentSessionId: "session-a",
      prompt: "resume with registration b",
      resumeSessionId: "backend-a",
    }));

    expect(frames.map((frame) => frame.kind === "engine_event" && frame.payload)).toEqual([
      { type: "assistant_message", content: "registration-b-current" },
    ]);
    await vi.waitFor(() => expect(readRegistrationJournal(paths.databasePath)).toEqual([
      { registration_id: registrationA.registrationId, host_acked: 1 },
      { registration_id: registrationB.registrationId, host_acked: 1 },
    ]));
    expect(dispatcher.hasActiveExecution()).toBe(false);
    await expect(collect(dispatcher.executeFrames({
      agentSessionId: "session-a",
      prompt: "next message after replay",
      resumeSessionId: "backend-a",
    }))).resolves.toEqual([]);
    expect(dispatcher.hasActiveExecution()).toBe(false);

    await dispatcher.close();
    writerB.close();
    await endpoint.close();
  });

  it("keeps the original stream when an accepted execute ACK is lost", async () => {
    const stateDirectory = await temporaryDirectory();
    const paths = runnerProcessPaths(stateDirectory, "session-a");
    await mkdir(paths.sessionDirectory, { recursive: true });
    const outbox = await RunnerSqliteEventOutbox.create(paths.databasePath);
    outbox.close();
    const executeCommandIds: string[] = [];
    const statusExecutionCommandIds: Array<string | null> = [];
    let acceptedCommandId: string | undefined;
    let endpoint!: RunnerSocketEndpoint;
    endpoint = new RunnerSocketEndpoint(paths.socketPath, async (frame) => {
      if (frame.channel !== "command") return;
      if (frame.kind === "execute") {
        executeCommandIds.push(frame.commandId);
        acceptedCommandId = frame.commandId;
        endpoint.currentConnection!.close();
        return;
      }
      if (frame.kind === "execution_status") {
        statusExecutionCommandIds.push(acceptedCommandId ?? null);
        await endpoint.currentConnection!.send(runnerCommandResultFrame(frame.commandId, {
          status: "ok",
          data: { executionCommandId: acceptedCommandId ?? null },
        }));
        await endpoint.currentConnection!.send(executionEndedControlFrame(acceptedCommandId!));
        return;
      }
      await endpoint.currentConnection!.send(
        runnerCommandResultFrame(frame.commandId, { status: "ok" }),
      );
    }, vi.fn());
    await endpoint.listen();
    const dispatcher = new RunnerProcessDispatcher({
      spawn: spawnInput(stateDirectory),
      runnerProcess: spawnedProcessForTest(paths),
      pumpMux: new EventOutboxPumpMux(new EventOutboxPump(emptyStore("node-stream"), vi.fn())),
      logger: pino({ level: "silent" }),
      handleHostCall: async () => null,
      reconnectPolicy: {
        initialDelayMs: 1,
        maxDelayMs: 1,
        maxAttempts: 3,
        stableConnectionMs: 1_000,
      },
      reconnectSleep: async () => undefined,
      inspectWriterLock: async () => ({
        kind: "held",
        owner: { pid: 1001, startIdentity: "start-1001" },
      }),
    });

    const stream = dispatcher.executeFrames({
      agentSessionId: "session-a",
      prompt: "hello",
    });

    await expect(collect(stream)).resolves.toEqual([]);
    expect(executeCommandIds).toHaveLength(1);
    expect(statusExecutionCommandIds).toEqual([executeCommandIds[0]]);

    await dispatcher.close();
    await endpoint.close();
  });

  it("reconnects the same registered runner after a request deadline and replays its active stream once", async () => {
    const stateDirectory = await temporaryDirectory();
    const paths = runnerProcessPaths(stateDirectory, "session-a");
    await mkdir(paths.sessionDirectory, { recursive: true });
    const writer = await RunnerSqliteEventOutbox.create(paths.databasePath);
    await writer.initializeBootstrap({
      session_id: "session-a",
      created_at: "2026-09-05T00:00:00.000Z",
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
    const lifecycle = RunnerSqliteLifecycle.open(paths.databasePath);
    lifecycle.begin({
      pid: 1001,
      commandId: "execute-old",
      progressedAt: "2026-09-05T00:00:00.000Z",
    });
    lifecycle.close();
    const commandKinds: string[] = [];
    let endpoint!: RunnerSocketEndpoint;
    endpoint = new RunnerSocketEndpoint(paths.socketPath, async (frame) => {
      if (frame.channel !== "command") return;
      commandKinds.push(frame.kind === "invoke" ? frame.capability : frame.kind);
      if (frame.kind === "prepare_session" && frame.commandId === "deadline-stall") return;
      await endpoint.currentConnection!.send(
        runnerCommandResultFrame(frame.commandId, { status: "ok" }),
      );
    }, vi.fn());
    await endpoint.listen();
    const spawned = await spawnedProcessForTest(paths);
    const terminate = vi.fn(async () => undefined);
    let connectionCount = 0;
    const dispatcher = new RunnerProcessDispatcher({
      spawn: spawnInput(stateDirectory),
      runnerProcess: spawned,
      spawner: { terminate, retireTerminalRegistration: vi.fn(async () => undefined) },
      connectSocket: async (socketPath, options) => {
        const connection = await connectRunnerSocket(socketPath, options);
        connectionCount += 1;
        return connection;
      },
      reconnectPolicy: {
        initialDelayMs: 1,
        maxDelayMs: 1,
        maxAttempts: 3,
        stableConnectionMs: 1_000,
      },
      reconnectSleep: async () => undefined,
      inspectWriterLock: async () => ({
        kind: "held",
        owner: { pid: 1001, startIdentity: "start-1001" },
      }),
      pumpMux: new EventOutboxPumpMux(new EventOutboxPump(emptyStore("node-stream"), vi.fn())),
      logger: pino({ level: "silent" }),
      handleHostCall: async () => null,
    });

    try {
      const recovery = collect(dispatcher.recoverFrames("execute-old"));
      // The parent outbox now opens its storage in a real worker thread, so the
      // first connection waits for that worker to start under the test loader.
      await vi.waitFor(() => expect(connectionCount).toBe(1), { timeout: 10_000 });
      const identityBefore = await dispatcher.prepareExecutionIdentity("owner-r33");
      const hostConnection = (dispatcher as unknown as {
        connection?: RunnerIpcConnection;
      }).connection;
      expect(hostConnection).toBeDefined();

      await expect(hostConnection!.request(
        prepareSessionCommandFrame("deadline-stall", "session-a"),
        { timeoutMs: 10 },
      )).rejects.toBeInstanceOf(RunnerIpcRequestTimeoutError);

      await vi.waitFor(() => expect(connectionCount).toBe(2));
      expect(dispatcher.hasActiveExecution()).toBe(true);
      const identityAfter = await dispatcher.prepareExecutionIdentity("owner-r33");
      expect(identityAfter).toEqual(identityBefore);
      expect(identityAfter).toMatchObject({
        pid: spawned.pid,
        startIdentity: "start-1001",
      });

      const durable = await writer.appendEngineFrame({
        session_id: "session-a",
        event_type: "assistant_message",
        payload: { type: "assistant_message", content: "after reconnect" },
        searchable_text: "after reconnect",
        created_at: "2026-09-05T00:00:01.000Z",
        semantic_dedupe_key: null,
        session_effect: null,
      }, {
        protocolVersion: 1,
        channel: "event",
        kind: "engine_event",
        payload: { type: "assistant_message", content: "after reconnect" },
      });
      await endpoint.currentConnection!.send(outboxAvailableControlFrame(durable.source_seq));
      await endpoint.currentConnection!.send(executionEndedControlFrame("execute-old"));

      await expect(recovery).resolves.toEqual([expect.objectContaining({
        kind: "engine_event",
        payload: { type: "assistant_message", content: "after reconnect" },
      })]);
      expect(commandKinds.filter((kind) => kind === "interrupt" || kind === "close")).toEqual([]);
      expect(terminate).not.toHaveBeenCalled();
    } finally {
      await dispatcher.detachHost();
      writer.close();
      await endpoint.close();
    }
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
      runnerProcess: spawnedProcessForTest(paths),
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

  it("cleans an exact closed Claude turn and accepts the next input on a fresh runner despite an ambiguous old claim", async () => {
    const stateDirectory = await temporaryDirectory();
    const paths = runnerProcessPaths(stateDirectory, "session-a");
    await mkdir(paths.sessionDirectory, { recursive: true });
    const writer = await RunnerSqliteEventOutbox.create(paths.databasePath);
    await writer.initializeBootstrap({
      session_id: "session-a",
      created_at: "2026-10-30T00:00:00.000Z",
      resume: {
        schema_version: 1,
        backend_session_id: "backend-a",
        cwd: "/workspace/a",
        codex_home: null,
        rollout_root: null,
        code_sha: "sha-a",
        snapshot_path: "/release/sha-a/soul-server-ts",
      },
    });
    await writer.stageIntervention({
      interventionId: "ambiguous-old-claim",
      message: { text: "old input", user: "alice" },
      queued: true,
      queuedAt: "2026-10-30T00:00:00.000Z",
    });
    expect(await writer.claimIntervention(
      "ambiguous-old-claim",
      "execute:old-command",
    )).toBe(true);
    await writer.markInterventionAmbiguous(
      "ambiguous-old-claim",
      "execute:old-command",
    );
    writer.close();
    const lifecycle = RunnerSqliteLifecycle.open(paths.databasePath);
    const spawned = await spawnedProcessForTest(paths);
    let endpoint!: RunnerSocketEndpoint;
    endpoint = new RunnerSocketEndpoint(paths.socketPath, async (frame) => {
      if (frame.channel !== "command") return;
      await endpoint.currentConnection!.send(runnerCommandResultFrame(frame.commandId, {
        status: "ok",
      }));
      if (frame.kind !== "execute") return;
      lifecycle.begin({
        pid: spawned.pid,
        commandId: frame.commandId,
        progressedAt: new Date().toISOString(),
      });
      await endpoint.currentConnection!.send(engineEventFrame({
        type: "input_material_manifest",
        schema_version: 1,
        timestamp: 1,
        output_command_id: frame.commandId,
        input_id: "input-before-closed-error",
      }));
      lifecycle.finish(frame.commandId, "failed", new Date().toISOString(), {
        code: "execution_failed",
        message: "ClaudeEngineAdapter.execute called after close()",
      });
      await endpoint.currentConnection!.send(executionEndedControlFrame(frame.commandId, {
        code: "execution_failed",
        message: "ClaudeEngineAdapter.execute called after close()",
      }));
    }, vi.fn());
    await endpoint.listen();
    const codexInput = spawnInput(stateDirectory);
    const backend = {
      ...codexInput,
      backend: "claude" as const,
      agent: { ...codexInput.agent, backend: "claude" as const },
    };
    const terminate = vi.fn(async () => undefined);
    const dispatcher = new RunnerProcessDispatcher({
      spawn: backend,
      runnerProcess: spawned,
      spawner: { terminate },
      pumpMux: new EventOutboxPumpMux(new EventOutboxPump(emptyStore("node-stream"), vi.fn())),
      logger: pino({ level: "silent" }),
      handleHostCall: async () => null,
    });
    const task = {
      agentSessionId: "session-a",
      status: "error",
      runner: createTaskRunnerRuntime({
        backendId: "claude",
        detachedClaudeRuntime: true,
        close: vi.fn(async () => undefined),
      } as never, dispatcher, "runner"),
    } as unknown as Task;
    const finalizer = new TaskExecutorFinalizer({
      lifecycleTransition: {
        persistExecutorFinalState: vi.fn(async () => ({ terminalTransitionApplied: true })),
        notifyCompletionIfApplied: vi.fn(async () => undefined),
      } as never,
      logger: pino({ level: "silent" }),
    });
    let nextEndpoint: RunnerSocketEndpoint | undefined;
    let nextDispatcher: RunnerProcessDispatcher | undefined;
    let endpointClosed = false;

    try {
      await dispatcher.prepareSession("session-a");
      await expect(collect(dispatcher.executeFrames({
        agentSessionId: "session-a",
        prompt: "old turn",
      }))).rejects.toThrow("ClaudeEngineAdapter.execute called after close()");
      expect(dispatcher.hasClosedEngineFailureForFinalization()).toBe(true);

      await finalizer.finalize(task);

      expect(task.runner).toBeUndefined();
      expect(terminate).toHaveBeenCalledWith(paths, {
        registrationId: spawned.registrationId,
        pid: spawned.pid,
        startIdentity: "start-1001",
      });
      await endpoint.close();
      endpointClosed = true;

      const persistedInbox = await RunnerSqliteEventOutbox.open(paths.databasePath);
      try {
        expect(await persistedInbox.readPendingInterventions()).toEqual([]);
        expect(await persistedInbox.claimIntervention(
          "ambiguous-old-claim",
          "execute:new-command",
        )).toBe(false);
      } finally {
        persistedInbox.close();
      }

      const nextIdentity = {
        ...pendingRunnerRegistrationIdentity("session-a", "sha-a"),
        pid: 1002,
        startIdentity: "start-1002",
      };
      await writeRunnerRegistrationIdentity(paths.sessionDirectory, nextIdentity);
      const nextSpawned = {
        pid: 1002,
        registrationId: nextIdentity.registrationId,
        paths,
        config: {} as never,
        adopted: false,
      };
      nextEndpoint = new RunnerSocketEndpoint(paths.socketPath, async (frame) => {
        if (frame.channel !== "command") return;
        const connection = nextEndpoint?.currentConnection;
        if (!connection) throw new Error("next wake has no IPC connection");
        await connection.send(runnerCommandResultFrame(frame.commandId, { status: "ok" }));
        if (frame.kind !== "execute") return;
        lifecycle.begin({
          pid: nextSpawned.pid,
          commandId: frame.commandId,
          progressedAt: new Date().toISOString(),
        });
        await connection.send(engineEventFrame({
          type: "assistant_message",
          content: "new runner answered",
          timestamp: 2,
        }));
        await connection.send(engineEventFrame({
          type: "complete",
          result: "new runner answered",
          timestamp: 3,
        }));
        lifecycle.finish(frame.commandId, "completed", new Date().toISOString());
        await connection.send(executionEndedControlFrame(frame.commandId));
      }, vi.fn());
      await nextEndpoint.listen();
      const nextTerminate = vi.fn(async () => undefined);
      nextDispatcher = new RunnerProcessDispatcher({
        spawn: backend,
        runnerProcess: nextSpawned,
        spawner: { terminate: nextTerminate },
        pumpMux: new EventOutboxPumpMux(new EventOutboxPump(emptyStore("node-stream"), vi.fn())),
        logger: pino({ level: "silent" }),
        handleHostCall: async () => null,
      });

      await nextDispatcher.prepareSession("session-a");
      const nextEvents = await collect(nextDispatcher.executeFrames({
        agentSessionId: "session-a",
        prompt: "new input",
      }));

      expect(nextDispatcher.registrationId()).toBe(nextIdentity.registrationId);
      expect(nextDispatcher.registrationId()).not.toBe(spawned.registrationId);
      expect(nextEvents.some((frame) =>
        frame.kind === "engine_event" && frame.payload.type === "complete"
      )).toBe(true);
      expect(nextTerminate).not.toHaveBeenCalled();
    } finally {
      lifecycle.close();
      await dispatcher.close();
      if (!endpointClosed) await endpoint.close();
      if (nextDispatcher) await nextDispatcher.close();
      if (nextEndpoint) await nextEndpoint.close();
    }
  });

  it("converges a running recovery from durable terminal state after IPC reconnect", async () => {
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
    let resolveFailureServerStopped!: () => void;
    const failureServerStopped = new Promise<void>((resolve) => {
      resolveFailureServerStopped = resolve;
    });
    const server = createServer((socket) => {
      connectionCount += 1;
      socket.destroy();
      if (connectionCount === 5) {
        server.close(resolveFailureServerStopped);
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
    const unregisterPump = vi.fn();
    const registerPump = vi.fn(() => unregisterPump);
    const finishRecoveryObservation = vi.fn();
    const dispatcher = new RunnerProcessDispatcher({
      spawn: spawnInput(stateDirectory),
      runnerProcess: spawnedProcessForTest(paths),
      pumpMux: { register: registerPump } as never,
      logger,
      handleHostCall: async () => null,
      inspectWriterLock: async () => ({
        kind: "held",
        owner: { pid: 1001, startIdentity: "start-1001" },
      }),
      nodeStallMonitor: {
        beginRunnerOperation: vi.fn((input) => input.operation === "execution:recover"
          ? finishRecoveryObservation
          : vi.fn()),
      } as never,
      reconnectPolicy: {
        initialDelayMs: 1,
        maxDelayMs: 2,
        maxAttempts: 3,
        stableConnectionMs: 1_000,
      },
    } as never);

    let recoverySettled = false;
    const recovery = collect(dispatcher.recoverFrames("execute-old")).finally(() => {
      recoverySettled = true;
    });
    await failureServerStopped;

    expect(connectionCount).toBe(5);
    expect(recoverySettled).toBe(false);
    expect(dispatcher.isClosed()).toBe(false);
    expect(dispatcher.hasActiveExecution()).toBe(true);
    expect(unregisterPump).not.toHaveBeenCalled();
    expect(finishRecoveryObservation).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-a",
        runnerDirectory: paths.sessionDirectory,
        socketPath: paths.socketPath,
        reconnectAttempt: 4,
        reconnectBackoffStep: 3,
        reconnectDelayMs: 2,
      }),
      "Runner IPC disconnected; reconnecting",
    );

    const completedLifecycle = RunnerSqliteLifecycle.open(paths.databasePath);
    completedLifecycle.finish(
      "execute-old",
      "completed",
      "2026-08-17T00:01:00.000Z",
    );
    completedLifecycle.close();

    const endpoint = new RunnerSocketEndpoint(
      paths.socketPath,
      async () => undefined,
      vi.fn(),
    );
    await endpoint.listen();
    try {
      await vi.waitFor(() => expect(endpoint.currentConnection).toBeDefined());
      await vi.waitFor(() => expect(recoverySettled).toBe(true));
      await expect(recovery).resolves.toEqual([]);
      await vi.waitFor(() => {
        expect(registerPump).toHaveBeenCalledOnce();
        expect(unregisterPump).not.toHaveBeenCalled();
        expect(finishRecoveryObservation).toHaveBeenCalledOnce();
      });
      expect(dispatcher.isClosed()).toBe(false);
      expect(dispatcher.hasActiveExecution()).toBe(false);
    } finally {
      await dispatcher.detachHost();
      await endpoint.close();
    }
  });

  it("does not reuse an adopted command identity for the next execute turn", async () => {
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
    await writeRunnerRegistrationIdentity(paths.sessionDirectory, {
      ...pendingRunnerRegistrationIdentity("session-a", "sha-a"),
      pid: 1001,
      startIdentity: "start-1001",
    });
    let followupCommandId: string | undefined;
    let endpoint!: RunnerSocketEndpoint;
    endpoint = new RunnerSocketEndpoint(paths.socketPath, async (frame) => {
      if (frame.channel !== "command" || frame.kind !== "execute") return;
      followupCommandId = frame.commandId;
      await endpoint.currentConnection!.send(
        runnerCommandResultFrame(frame.commandId, { status: "ok" }),
      );
      await endpoint.currentConnection!.send(executionEndedControlFrame(frame.commandId));
    }, vi.fn());
    await endpoint.listen();
    const dispatcher = new RunnerProcessDispatcher({
      spawn: spawnInput(stateDirectory),
      runnerProcess: {
        pid: 1001,
        registrationId: "registration-a",
        paths,
        config: {} as never,
        adopted: true,
      },
      pumpMux: new EventOutboxPumpMux(new EventOutboxPump(emptyStore("node-stream"), vi.fn())),
      logger: pino({ level: "silent" }),
      handleHostCall: async () => null,
    });

    await expect(dispatcher.prepareExecutionIdentity("owner-old")).resolves.toMatchObject({
      executionCommandId: "owner-old",
    });
    await expect(collect(dispatcher.recoverFrames("execute-old"))).resolves.toEqual([
      expect.objectContaining({
        kind: "engine_event",
        payload: { type: "assistant_message", content: "replayed" },
      }),
    ]);
    await collect(dispatcher.executeFrames({
      agentSessionId: "session-a",
      prompt: "intervention follow-up",
      resumeSessionId: "backend-a",
    }));
    expect(followupCommandId).toMatch(/^execute:/);
    expect(followupCommandId).not.toBe("execute-old");

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

async function connectedDispatcherFixture(options: {
  reconnectSleep(delayMs: number): Promise<void>;
  inspectWriterLock(path: string): Promise<unknown>;
  onCommand?(
    endpoint: RunnerSocketEndpoint,
    frame: Extract<RunnerFrame, { channel: "command" }>,
  ): Promise<void>;
  retireTerminalRegistration?(): Promise<void>;
  connectSocketAttempt?(
    attempt: number,
    socketPath: string,
    connectOptions: Parameters<typeof connectRunnerSocket>[1],
  ): Promise<RunnerIpcConnection>;
}) {
  const stateDirectory = await temporaryDirectory();
  const paths = runnerProcessPaths(stateDirectory, "session-a");
  await mkdir(paths.sessionDirectory, { recursive: true });
  const outbox = await RunnerSqliteEventOutbox.create(paths.databasePath);
  await outbox.initializeBootstrap({
    session_id: "session-a",
    created_at: "2026-11-03T00:00:00.000Z",
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
  const spawned = await spawnedProcessForTest(paths);
  let endpoint!: RunnerSocketEndpoint;
  endpoint = new RunnerSocketEndpoint(paths.socketPath, async (frame) => {
    if (frame.channel !== "command") return;
    if (options.onCommand) {
      await options.onCommand(endpoint, frame);
      return;
    }
    await endpoint.currentConnection!.send(
      runnerCommandResultFrame(frame.commandId, { status: "ok" }),
    );
  }, vi.fn());
  await endpoint.listen();

  let connectAttemptCount = 0;
  const connectSocket = vi.fn(async (
    socketPath: string,
    connectOptions: Parameters<typeof connectRunnerSocket>[1],
  ) => {
    connectAttemptCount += 1;
    return await (options.connectSocketAttempt
      ? options.connectSocketAttempt(connectAttemptCount, socketPath, connectOptions)
      : connectRunnerSocket(socketPath, connectOptions));
  });
  const dispatcherOptions = {
    spawn: spawnInput(stateDirectory),
    runnerProcess: { ...spawned, adopted: true },
    spawner: {
      retireTerminalRegistration: options.retireTerminalRegistration ?? vi.fn(async () => undefined),
    },
    connectSocket,
    reconnectSleep: options.reconnectSleep,
    inspectWriterLock: options.inspectWriterLock,
    pumpMux: new EventOutboxPumpMux(
      new EventOutboxPump(emptyStore("node-stream"), vi.fn()),
    ),
    logger: pino({ level: "silent" }),
    handleHostCall: async () => null,
  } as unknown as ConstructorParameters<typeof RunnerProcessDispatcher>[0];
  const dispatcher = new RunnerProcessDispatcher(dispatcherOptions);
  await dispatcher.prepareSession("session-a");

  return { dispatcher, endpoint, paths, connectSocket };
}

function hasLostRunner(dispatcher: RunnerProcessDispatcher): boolean {
  return (dispatcher as RunnerProcessDispatcher & { hasLostRunner?(): boolean })
    .hasLostRunner?.() === true;
}

function observePromise<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<
  | { status: "resolved"; value: T }
  | { status: "rejected"; error: unknown }
  | { status: "pending" }
> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ status: "pending" }), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ status: "resolved", value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve({ status: "rejected", error });
      },
    );
  });
}

async function spawnedInitializationFixture() {
  const stateDirectory = await temporaryDirectory();
  const paths = runnerProcessPaths(stateDirectory, "session-a");
  await mkdir(paths.sessionDirectory, { recursive: true });
  const identity = {
    ...pendingRunnerRegistrationIdentity("session-a", "sha-a"),
    pid: 7101,
    startIdentity: "start-7101",
  };
  await writeRunnerRegistrationIdentity(paths.sessionDirectory, identity);
  return {
    stateDirectory,
    paths,
    spawned: {
      pid: 7101,
      registrationId: identity.registrationId,
      paths,
      config: {} as never,
      adopted: false,
    },
  };
}

async function spawnedProcessForTest(
  paths: ReturnType<typeof runnerProcessPaths>,
) {
  const identity = {
    ...pendingRunnerRegistrationIdentity("session-a", "sha-a"),
    pid: 1001,
    startIdentity: "start-1001",
  };
  await writeRunnerRegistrationIdentity(paths.sessionDirectory, identity);
  return {
    pid: 1001,
    registrationId: identity.registrationId,
    paths,
    config: {} as never,
    adopted: false,
  };
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

function readRegistrationJournal(databasePath: string): Array<{
  registration_id: string | null;
  host_acked: number;
}> {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(`
      SELECT outbox.registration_id, journal.host_acked
      FROM runner_ipc_journal AS journal
      JOIN runner_event_outbox AS outbox
        ON outbox.source_seq = journal.outbox_source_seq
      ORDER BY journal.frame_seq
    `).all() as Array<{ registration_id: string | null; host_acked: number }>;
  } finally {
    database.close();
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of iterable) result.push(value);
  return result;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  Query as ClaudeSdkQuery,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionMutationHost } from "../../src/control_plane/persistence_host_clients.js";
import type { SessionDB } from "../../src/db/session_db.js";
import { ClaudeEngineAdapter, ClaudeSdkClient } from "../../src/engine/claude_adapter.js";
import { ClaudeSessionClientRegistry } from
  "../../src/engine/claude_session_client_registry.js";
import { createEventQueue, type EventQueue } from
  "../../src/engine/claude_sdk_event_queue.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";
import { RunnerChildRuntime } from "../../src/runner/runner_child_runtime.js";
import type { RunnerChildConfig } from "../../src/runner/runner_child_config.js";
import { RunnerProcessDispatcher } from "../../src/runner/runner_process_dispatcher.js";
import { RunnerProcessEngineProxy } from "../../src/runner/runner_process_engine_proxy.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import type { SpawnRunnerProcessInput } from "../../src/runner/runner_process_spawn.js";
import {
  pendingRunnerRegistrationIdentity,
  readRunnerRegistrationIdentity,
  writeRunnerRegistrationIdentity,
} from "../../src/runner/runner_registration_identity.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import { createTaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import { TaskManager } from "../../src/task/task_manager.js";
import type { AddInterventionParams } from "../../src/task/task_intervention_route.js";
import { EventOutboxPump } from "../../src/upstream/event_outbox_pump.js";
import { EventOutboxPumpMux } from "../../src/upstream/event_outbox_pump_mux.js";
import type { EventOutboxPumpStore } from "../../src/upstream/event_outbox_pump_protocol.js";

import contextUsageFixture from "../engine/claude_context_usage_after_compact.fixture.json";
import { sdkInit, sdkResult } from "../engine/claude_sdk_persistent_test_harness.js";
import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const SESSION_ID = "session-compact-intervention-ipc";
const AGENT_ID = "claude-compact-intervention-test";
const FIRST_MARKER = "compact-window-agent-message";
const SECOND_MARKER = "compact-window-browser-message";
const silentLogger = pino({ level: "silent" });

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

interface RecordedEvent {
  sessionId: string;
  event: SSEEventPayload;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function eventObserver() {
  const events: RecordedEvent[] = [];
  const waiters: Array<{
    predicate: (record: RecordedEvent) => boolean;
    resolve(record: RecordedEvent): void;
  }> = [];
  return {
    events,
    observe(sessionId: string, event: SSEEventPayload): void {
      const record = { sessionId, event: structuredClone(event) };
      events.push(record);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index]!;
        if (!waiter.predicate(record)) continue;
        waiters.splice(index, 1);
        waiter.resolve(record);
      }
    },
    waitFor(predicate: (record: RecordedEvent) => boolean): Promise<RecordedEvent> {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
  };
}

function makeQueryHarness() {
  const queryCreated = deferred<{
    params: { prompt: string | AsyncIterable<SDKUserMessage> };
    output: EventQueue<SDKMessage>;
    input: AsyncIterator<SDKUserMessage>;
  }>();
  const interrupt = vi.fn(async () => undefined);
  const close = vi.fn();
  let activeOutput: EventQueue<SDKMessage> | undefined;
  const query = ((params) => {
    const prompt = params.prompt as AsyncIterable<SDKUserMessage>;
    const output = createEventQueue<SDKMessage>();
    activeOutput = output;
    queryCreated.resolve({ params, output, input: prompt[Symbol.asyncIterator]() });
    return {
      interrupt,
      close: () => {
        close();
        output.close();
      },
      backgroundTasks: vi.fn(async () => false),
      stopTask: vi.fn(async () => undefined),
      getContextUsage: vi.fn(async () => contextUsageFixture.afterCompact),
      [Symbol.asyncIterator]: () => output,
    } as unknown as ClaudeSdkQuery;
  }) satisfies import("../../src/engine/claude_sdk_client.js").ClaudeSdkQueryFn;
  return {
    close,
    interrupt,
    nextQuery: () => queryCreated.promise,
    push(message: SDKMessage): void {
      if (!activeOutput) throw new Error("fake Claude Query has not started");
      activeOutput.push(message);
    },
    end(): void {
      activeOutput?.close();
    },
    query,
  };
}

function inputText(input: SDKUserMessage): string {
  const message = input.message as { content?: unknown };
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((block) => block && typeof block === "object" && "text" in block
      ? String((block as { text: unknown }).text)
      : "")
    .join("\n");
}

function emptyStore(streamId: string): EventOutboxPumpStore {
  return {
    streamId,
    ackedSeq: 0,
    onAppend: () => () => {},
    readBatch: async () => null,
    acknowledge: async () => {},
  };
}

function makeTaskManagerDeps(persistence: ReturnType<typeof makeEventPersistenceTestDouble>["persistence"]) {
  const db = {
    getFolderById: vi.fn(async () => null),
    getSession: vi.fn(async () => null),
  } as unknown as SessionDB;
  const mutations: SessionMutationHost = {
    registerSession: vi.fn(async () => undefined),
    registerSessionWithWorktree: vi.fn(async () => undefined),
    transitionSession: vi.fn(async () => undefined),
    renameSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    acknowledgeReview: vi.fn(async () => "acknowledged"),
  };
  const broadcaster = {
    emitCatalogUpdated: vi.fn(async () => undefined),
    emitEventEnvelope: vi.fn(async () => undefined),
    emitSessionCreated: vi.fn(async () => undefined),
    emitSessionUpdated: vi.fn(async () => undefined),
  };
  return {
    broadcaster,
    db,
    manager: new TaskManager(
      "eiaserinnys",
      db,
      broadcaster as never,
      silentLogger,
      persistence,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      mutations,
    ),
    mutations,
  };
}

function messageParams(text: string, source: "agent" | "browser"): AddInterventionParams {
  return {
    agentSessionId: SESSION_ID,
    text,
    user: source,
    source: "user_message",
    callerInfo: { source, user_id: `${source}-sender` },
  };
}

describe("Claude compact/intervention runner IPC integration", () => {
  it("queues messages during compact and sends both in the immediately following turn", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "compact-intervention-ipc-"));
    const paths = runnerProcessPaths(stateDirectory, SESSION_ID);
    const agent: AgentProfile = {
      id: AGENT_ID,
      name: "Claude compact IPC test",
      backend: "claude",
      workspace_dir: stateDirectory,
    };
    const input: SpawnRunnerProcessInput = {
      stateDirectory,
      sessionId: SESSION_ID,
      backend: "claude",
      agent,
      codeSha: "compact-ipc-test",
      releaseManifestId: "compact-ipc-test-release",
      runtimeEnvIdentity: "compact-ipc-test-env",
      snapshotPath: stateDirectory,
      codexAdapterMode: "sdk",
      codexDetachedResultRetentionMs: 1_800_000,
      claudeRuntimeV2Enabled: true,
      claudeRuntimeIdleTtlMs: 300_000,
      claudeRuntimeMaxEntries: 4,
      claudeRuntimeTurnTimeoutMs: 1_800_000,
      internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
      codexHome: null,
      rolloutRoot: null,
    };
    const identity = pendingRunnerRegistrationIdentity(SESSION_ID, input.codeSha, input);
    const childConfig: RunnerChildConfig = {
      schemaVersion: 1,
      sessionId: SESSION_ID,
      registrationId: identity.registrationId,
      backend: "claude",
      agent,
      paths,
      codeSha: input.codeSha,
      releaseManifestId: input.releaseManifestId,
      runtimeEnvIdentity: input.runtimeEnvIdentity,
      snapshotPath: stateDirectory,
      codexAdapterMode: "sdk",
      codexDetachedResultRetentionMs: 1_800_000,
      claudeRuntimeV2Enabled: true,
      claudeRuntimeIdleTtlMs: 300_000,
      claudeRuntimeMaxEntries: 4,
      claudeRuntimeTurnTimeoutMs: 1_800_000,
      internalMcpUrl: input.internalMcpUrl,
      codexHome: null,
      rolloutRoot: null,
    };
    const runnerOutbox = await RunnerSqliteEventOutbox.create(paths.databasePath, {
      sessionId: SESSION_ID,
    });
    runnerOutbox.close();
    await mkdir(paths.sessionDirectory, { recursive: true });
    await writeRunnerRegistrationIdentity(paths.sessionDirectory, identity);

    const sdk = makeQueryHarness();
    const client = new ClaudeSdkClient({ query: sdk.query }, silentLogger);
    const registry = new ClaudeSessionClientRegistry(
      () => client,
      { idleTtlMs: 300_000, maxEntries: 4 },
    );
    const runtime = new RunnerChildRuntime(childConfig, silentLogger, {
      createEngine: (config) => new ClaudeEngineAdapter({
        workspaceDir: config.agent.workspace_dir,
        agentId: config.agent.id,
        client,
        processEnv: {},
        persistentSessionRegistry: registry,
      }, silentLogger),
    });
    let dispatcher: RunnerProcessDispatcher | undefined;
    const lifecycleEvents = eventObserver();
    const persistenceDouble = makeEventPersistenceTestDouble(async (sessionId, event) => {
      lifecycleEvents.observe(sessionId, event);
    });
    const taskManagerDeps = makeTaskManagerDeps(persistenceDouble.persistence);
    const task = await taskManagerDeps.manager.createTask({
      agentSessionId: SESSION_ID,
      prompt: "Start a normal Claude turn for the compact regression.",
      profileId: AGENT_ID,
      agentProfileSnapshot: agent,
    });
    await task.creationEffects;

    const pumpMux = new EventOutboxPumpMux(
      new EventOutboxPump(emptyStore("compact-ipc-node"), vi.fn()),
    );
    await pumpMux.connect(async (batch) => {
      await pumpMux.handleAck({
        type: "event_append_ack",
        stream_id: batch.stream_id,
        acked_through: batch.events.at(-1)!.source_seq,
        events: batch.events.map((event, index) => ({
          source_seq: event.source_seq,
          event_id: 10_000 + index,
        })),
      });
    });

    try {
      await runtime.start();
      const readyIdentity = await readRunnerRegistrationIdentity(paths.sessionDirectory);
      if (!readyIdentity?.startIdentity || readyIdentity.pid === null) {
        throw new Error("same-process runner did not publish a complete identity");
      }
      const spawned = {
        pid: readyIdentity.pid,
        registrationId: readyIdentity.registrationId,
        paths,
        config: childConfig,
        adopted: true,
      };
      dispatcher = new RunnerProcessDispatcher({
        spawn: input,
        runnerProcess: spawned,
        spawner: {
          terminate: async () => await runtime.shutdown(),
          retireTerminalRegistration: async () => await runtime.shutdown(),
        },
        pumpMux,
        logger: silentLogger,
        handleHostCall: async () => null,
      });
      const runner = createTaskRunnerRuntime(
        new RunnerProcessEngineProxy("claude", agent.workspace_dir, dispatcher, {
          retainDetachedRuntime: false,
        }),
        dispatcher,
        "runner",
      );
      const executor = new TaskExecutor(
        () => runner.engine,
        taskManagerDeps.db,
        persistenceDouble.persistence,
        taskManagerDeps.broadcaster as never,
        silentLogger,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => runner,
      );
      const execution = executor.startNewExecution(task, agent);
      void execution.catch(() => undefined);
      const activation = task.executionActivation;
      if (!activation) throw new Error("TaskExecutor did not expose execution activation");
      await activation.promise;

      const query = await sdk.nextQuery();
      if (typeof query.params.prompt === "string") {
        throw new Error("persistent Claude Query did not receive an input stream");
      }
      const firstInput = await query.input.next();
      if (firstInput.done) throw new Error("initial model input ended unexpectedly");
      sdk.push(sdkInit("claude-backend-session"));
      const ordinaryResult = sdkResult(
        "claude-backend-session",
        firstInput.value.uuid,
        "first turn completed",
      );
      sdk.push({
        ...ordinaryResult,
        usage: {
          input_tokens: 900_000,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          iterations: [{
            type: "message",
            input_tokens: 900_000,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          }],
        },
        modelUsage: {
          "claude-opus-4-6": { contextWindow: 1_000_000 },
        },
      } as unknown as SDKMessage);

      const compactInput = await query.input.next();
      if (compactInput.done) throw new Error("automatic compact input ended unexpectedly");
      expect(inputText(compactInput.value)).toContain("/compact");

      const addInterventionResults = await Promise.all([
        taskManagerDeps.manager.addIntervention(messageParams(FIRST_MARKER, "agent"), vi.fn()),
        taskManagerDeps.manager.addIntervention(messageParams(SECOND_MARKER, "browser"), vi.fn()),
      ]);

      const fatalEvent = lifecycleEvents.waitFor(({ event }) =>
        event.type === "error" && (event as { fatal?: unknown }).fatal === true,
      );
      let eventCountAtNextInput = 0;
      const nextInputPromise = query.input.next().then((result) => {
        eventCountAtNextInput = lifecycleEvents.events.length;
        return { kind: "input" as const, result };
      });
      let nextTurn: Awaited<typeof nextInputPromise> | {
        kind: "fatal";
        event: SSEEventPayload;
      } | { kind: "execution_ended" };
      if (addInterventionResults.every((result) =>
        "reason" in result && result.reason === "no_active_turn",
      )) {
        sdk.push({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto" },
          uuid: "compact-boundary-ipc-test",
          session_id: "claude-backend-session",
        } as unknown as SDKMessage);
        sdk.push(sdkResult(
          "claude-backend-session",
          compactInput.value.uuid,
          "automatic compact completed",
        ));
        nextTurn = await Promise.race([
          nextInputPromise,
          fatalEvent.then((record) => ({ kind: "fatal" as const, event: record.event })),
          execution.then(() => ({ kind: "execution_ended" as const })),
        ]);
      } else {
        const terminalError = await Promise.race([
          fatalEvent.then((record) => ({ kind: "fatal" as const, event: record.event })),
          nextInputPromise,
          execution.then(() => ({ kind: "execution_ended" as const })),
        ]);
        nextTurn = terminalError.kind === "fatal"
          ? terminalError
          : terminalError.kind === "input"
            ? terminalError
            : terminalError;
        sdk.push({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto" },
          uuid: "compact-boundary-ipc-test",
          session_id: "claude-backend-session",
        } as unknown as SDKMessage);
        sdk.push(sdkResult(
          "claude-backend-session",
          compactInput.value.uuid,
          "automatic compact completed",
        ));
      }
      const diagnostic = {
        addInterventionResults,
        fatal: nextTurn.kind === "fatal" ? nextTurn.event : undefined,
        status: task.status,
        nextInput: nextTurn.kind === "input" && !nextTurn.result.done
          ? inputText(nextTurn.result.value)
          : undefined,
      };
      process.stdout.write(`CLAUDE_COMPACTION_IPC_DIAGNOSTIC ${JSON.stringify(diagnostic)}\n`);

      expect(addInterventionResults, JSON.stringify(diagnostic)).toEqual([
        expect.objectContaining({
          delivered: false,
          queued: true,
          consumeWhen: "next_turn",
          reason: "no_active_turn",
        }),
        expect.objectContaining({
          delivered: false,
          queued: true,
          consumeWhen: "next_turn",
          reason: "no_active_turn",
        }),
      ]);
      expect(nextTurn.kind, JSON.stringify(diagnostic)).toBe("input");
      if (nextTurn.kind !== "input" || nextTurn.result.done) {
        throw new Error(`compact follow-up turn was not started: ${JSON.stringify(diagnostic)}`);
      }
      const followupInputText = inputText(nextTurn.result.value);
      expect(task.status, JSON.stringify(diagnostic)).toBe("running");
      expect(followupInputText).toContain(FIRST_MARKER);
      expect(followupInputText).toContain(SECOND_MARKER);

      const observed = lifecycleEvents.events.map(({ event }) => event);
      expect(observed.filter((event) =>
        event.type === "compact"
        && (event as { trigger?: unknown }).trigger === "auto_preemptive",
      )).toHaveLength(1);
      const compactIndex = observed.findIndex((event) =>
        event.type === "compact"
        && (event as { trigger?: unknown }).trigger === "auto_preemptive",
      );
      const usageIndex = observed.findIndex((event, index) =>
        index > compactIndex && event.type === "context_usage",
      );
      expect(compactIndex).toBeGreaterThanOrEqual(0);
      expect(usageIndex).toBe(compactIndex + 1);
      expect(usageIndex).toBeLessThan(eventCountAtNextInput);
      expect(observed.some((event) =>
        event.type === "error" && (event as { fatal?: unknown }).fatal === true,
      )).toBe(false);
      expect(observed.some((event) =>
        event.type === "session_ended"
        && (event as { status?: unknown }).status === "error",
      )).toBe(false);
      expect(sdk.interrupt).not.toHaveBeenCalled();

      sdk.push(sdkResult(
        "claude-backend-session",
        nextTurn.result.value.uuid,
        "follow-up completed",
      ));
      await execution;
    } finally {
      sdk.end();
      await dispatcher?.close().catch(() => undefined);
      await runtime.shutdown().catch(() => undefined);
      await rm(stateDirectory, { recursive: true, force: true });
    }
  }, 60_000);
});

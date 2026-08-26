import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as WSServerWebSocket } from "ws";
import pino from "pino";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentRegistry, type AgentProfile } from "../src/agent_registry.js";
import { UpstreamAdapter, isConnectionError } from "../src/upstream/adapter.js";
import type { TaskExecutor } from "../src/task/task_executor.js";
import type { TaskManager } from "../src/task/task_manager.js";
import type { Task } from "../src/task/task_models.js";
import { TaskInterventionRoute } from "../src/task/task_intervention_route.js";
import type { SessionDB } from "../src/db/session_db.js";
import type { EventOutboxPump } from "../src/upstream/event_outbox_pump.js";
import type { ReconnectPolicyBoundary } from "../src/upstream/adapter.js";
import { RunnerRecoveryCoordinator } from "../src/runner/runner_recovery_coordinator.js";
import type { RunnerRegistration } from "../src/runner/runner_process_registry.js";
import { ReleaseActivationState } from "../src/release/release_activation_state.js";
import type { ReleaseManifestV1 } from "../src/release/release_manifest.js";

const codexAgent: AgentProfile = {
  id: "codex-default",
  name: "Codex Default",
  backend: "codex",
  workspace_dir: "/tmp/codex-default",
};

const releaseManifest: ReleaseManifestV1 = {
  schema_version: 1,
  manifest_id: "manifest-1",
  release_cohort_id: "cohort-1",
  source_commit: "commit-1",
  host_bundle_hash: "sha256-host",
  runner_release_id: "sha256-runner-release",
  runner_artifact_hash: "sha256-runner-artifact",
  schema_generation: "schema-70",
  wire_generation: "wire-1",
  node: { version: "v22.18.0", platform: "linux", arch: "x64" },
  deployment_env_identity: "sha256-env",
  executables: {
    claude: { kind: "claude", path: "/usr/bin/claude", identity: "sha256-claude" },
    codex: { kind: "codex", path: "/usr/bin/codex", identity: "sha256-codex" },
  },
};

function makeDeps(
  opts: {
    agents?: AgentProfile[];
    runningSessionIds?: string[];
    listLiveRunnerSessionIds?: () => Promise<string[]>;
    waitForRunnerReconciliation?: () => Promise<void>;
    sessionDb?: SessionDB;
    eventOutboxPump?: EventOutboxPump;
    reconnectPolicy?: ReconnectPolicyBoundary;
    taskManager?: TaskManager;
    taskExecutor?: TaskExecutor;
  } = {},
) {
  const agentRegistry = new AgentRegistry(opts.agents ?? [codexAgent]);
  const taskManager = opts.taskManager ?? ({
    listTasks: () =>
      (opts.runningSessionIds ?? []).map((agentSessionId) => ({
        agentSessionId,
        status: "running" as const,
      })),
    createTask: async () => {
      throw new Error("createTask not stubbed in this test");
    },
    cancelTask: async () => false,
    deleteTask: async () => undefined,
    shutdown: async () => undefined,
    getTask: () => undefined,
    setTaskStatus: () => undefined,
  } as unknown as TaskManager);
  const taskExecutor = opts.taskExecutor ?? ({
    startExecution: () => undefined,
  } as unknown as TaskExecutor);
  return {
    agentRegistry,
    taskManager,
    taskExecutor,
    sessionDb: opts.sessionDb,
    eventOutboxPump: opts.eventOutboxPump,
    reconnectPolicy: opts.reconnectPolicy,
    listLiveRunnerSessionIds: opts.listLiveRunnerSessionIds,
    waitForRunnerReconciliation: opts.waitForRunnerReconciliation,
  };
}

interface MockOrch {
  port: number;
  url: string;
  server: WebSocketServer;
  receivedMessages: unknown[];
  sockets: WSServerWebSocket[];
  expectedAuthHeader?: string;
}

async function startMockOrch(
  opts: {
    authToken?: string;
    autoPong?: boolean;
    pingOnRegister?: boolean;
    acknowledgeRegistration?: boolean;
    acknowledgementCapabilities?: Record<string, unknown>;
    closeRegistrations?: number;
  } = {},
): Promise<MockOrch> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const port = (wss.address() as AddressInfo).port;
  const url = `ws://127.0.0.1:${port}/ws/node`;
  const received: unknown[] = [];
  const sockets: WSServerWebSocket[] = [];
  let registrationCount = 0;

  wss.on("connection", (socket, req) => {
    // Bearer auth 확인 (orch ws_handler.py L52-62 등가)
    if (opts.authToken) {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${opts.authToken}`) {
        socket.close(4401, "auth required");
        return;
      }
    }
    sockets.push(socket);
    socket.on("message", (raw) => {
      const text = Buffer.isBuffer(raw) ? raw.toString("utf-8") : String(raw);
      try {
        const msg = JSON.parse(text);
        received.push(msg);
        if (
          typeof msg === "object"
          && msg !== null
          && (msg as Record<string, unknown>).type === "node_register"
        ) {
          registrationCount += 1;
          if (opts.acknowledgeRegistration) {
            socket.send(JSON.stringify({
              type: "node_register_ack",
              node_id: (msg as Record<string, unknown>).node_id,
              ...(opts.acknowledgementCapabilities === undefined
                ? {}
                : { capabilities: opts.acknowledgementCapabilities }),
            }));
          }
          if (registrationCount <= (opts.closeRegistrations ?? 0)) {
            socket.close(1011, "event_ingress:PROTOCOL_CONFLICT");
          }
        }
        if (
          opts.pingOnRegister &&
          typeof msg === "object" &&
          msg !== null &&
          (msg as Record<string, unknown>).type === "node_register"
        ) {
          socket.send(JSON.stringify({
            type: "app_heartbeat_ping",
            sentAt: "2026-06-08T00:00:00Z",
          }));
        }
        if (
          opts.autoPong &&
          typeof msg === "object" &&
          msg !== null &&
          (msg as Record<string, unknown>).type === "app_heartbeat_ping"
        ) {
          socket.send(JSON.stringify({
            type: "app_heartbeat_pong",
            sentAt: (msg as Record<string, unknown>).sentAt,
          }));
        }
      } catch {
        received.push(text);
      }
    });
  });

  return { port, url, server: wss, receivedMessages: received, sockets };
}

async function stopMockOrch(orch: MockOrch): Promise<void> {
  for (const sock of orch.sockets) sock.close();
  await new Promise<void>((r) => orch.server.close(() => r()));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

const silentLogger = pino({ level: "silent" });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function recoveryRegistration(
  sessionId: string,
  lifecycleState: "reaped" | "completed",
  stateDirectory: string,
): RunnerRegistration {
  const sessionDirectory = join(stateDirectory, sessionId);
  return {
    config: {
      schemaVersion: 1,
      sessionId,
      backend: "codex",
      agent: {
        id: "agent-a",
        name: "Agent A",
        backend: "codex",
        workspace_dir: "/workspace/a",
      },
      paths: {
        sessionDirectory,
        databasePath: join(sessionDirectory, "runner.sqlite"),
        socketPath: join(sessionDirectory, "runner.sock"),
        pidPath: join(sessionDirectory, "runner.pid"),
        lockPath: join(sessionDirectory, "runner.lock"),
        configPath: join(sessionDirectory, "runner-config.json"),
      },
      codeSha: "sha-a",
      snapshotPath: "/release/sha-a/soul-server-ts",
      codexAdapterMode: "sdk",
      claudeRuntimeV2Enabled: true,
      claudeRuntimeIdleTtlMs: 300_000,
      claudeRuntimeMaxEntries: 16,
      claudeRuntimeTurnTimeoutMs: 1_800_000,
      internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
      codexHome: "/home/test/.codex",
      rolloutRoot: "/home/test/.codex/sessions",
    },
    pid: 4123,
    pidStartIdentity: "start-4123",
    pidAlive: false,
    registeredAtMs: Date.parse("2026-08-13T09:01:47.000Z"),
    bootstrap: {
      stream_id: `stream-${sessionId}`,
      source_seq: 1,
      session_id: sessionId,
      event_type: "runner_bootstrap",
      payload: {
        schema_version: 1,
        backend_session_id: `backend-${sessionId}`,
        cwd: "/workspace/a",
        codex_home: "/home/test/.codex",
        rollout_root: "/home/test/.codex/sessions",
        code_sha: "sha-a",
        snapshot_path: "/release/sha-a/soul-server-ts",
      },
      searchable_text: null,
      created_at: "2026-08-13T09:01:47.000Z",
      semantic_dedupe_key: null,
      session_effect: null,
      payload_hash: "0".repeat(64),
    },
    lifecycle: {
      session_id: sessionId,
      runner_pid: 4123,
      execution_command_id: `execute-${sessionId}`,
      execution_state: lifecycleState,
      progress_seq: 3,
      progress_at: "2026-08-13T09:01:47.735Z",
      liveness_at: "2026-08-13T09:01:47.735Z",
      in_flight_tools: [],
      terminal_error: lifecycleState === "reaped"
        ? { code: "runner_exited", message: "runner process exited" }
        : null,
    },
  };
}

function recoveryTask(agentSessionId: string): Task {
  return {
    agentSessionId,
    prompt: "continue",
    status: "running",
    createdAt: new Date("2026-08-13T09:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

describe("UpstreamAdapter", () => {
  let orch: MockOrch;

  beforeEach(async () => {
    orch = await startMockOrch();
  });

  afterEach(async () => {
    await stopMockOrch(orch);
  });

  it("연결 후 첫 메시지로 node_register payload를 발행한다", async () => {
    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "",
        userName: "",
        userPortraitPath: "",
        isProduction: false,
      },
      silentLogger,
      makeDeps(),
    );

    void adapter.run();
    await waitFor(() => orch.receivedMessages.length >= 1);

    const first = orch.receivedMessages[0] as Record<string, unknown>;
    expect(first.type).toBe("node_register");
    expect(first.node_id).toBe("eias-shopping-ts");
    expect(first.supported_backends).toEqual(["codex"]);
    // Phase B-3 + cogito aggregate: registry capacity and TS reflection capability.
    expect(first.capabilities).toEqual({
      max_concurrent: 1,
      reflect_brief: true,
      app_heartbeat_v1: true,
      runner_inventory_v1: true,
    });
    // PR(portrait wire): agents 매핑에 portrait_url 추가 (Python adapter.py:212-233 정합).
    // portrait_path 미설정 fixture → portrait_url=""·portrait_b64 키 미박힘.
    expect(first.agents).toEqual([
      { id: "codex-default", name: "Codex Default", backend: "codex", portrait_url: "" },
    ]);

    await adapter.shutdown();
  });

  it("holds an intervention behind startup reconciliation until a live runner is adopted", async () => {
    await stopMockOrch(orch);
    orch = await startMockOrch({ acknowledgeRegistration: true });
    const sessionId = "sess-restart-window";
    const task: Task = {
      agentSessionId: sessionId,
      prompt: "keep running",
      status: "running",
      profileId: codexAgent.id,
      createdAt: new Date("2026-08-26T10:00:00.000Z"),
      lastEventId: 1,
      lastReadEventId: 0,
      interventionQueue: [],
    };
    const runningDelivery = vi.fn(async () => ({ delivered: true as const }));
    const autoResume = vi.fn(async () => ({ autoResumed: true as const }));
    const route = new TaskInterventionRoute({
      getTask: () => task,
      loadEvictedTask: vi.fn().mockResolvedValue(null),
      rememberTask: vi.fn(),
      runningInterventionTransition: { deliver: runningDelivery },
      autoResumeTransition: { resume: autoResume },
    });
    const addIntervention = vi.fn((params, onResume) =>
      route.addIntervention(params, onResume));
    const taskManager = {
      listTasks: () => [task],
      addIntervention,
    } as unknown as TaskManager;
    const startExecution = vi.fn();
    const reconciliation = deferred<void>();
    const waitForRunnerReconciliation = vi.fn(async () => {
      await reconciliation.promise;
      task.runner = {
        engine: {} as never,
        eventPersistence: "runner",
        dispatcher: {
          hasActiveExecution: () => true,
        } as never,
      };
    });
    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "",
        userName: "",
        userPortraitPath: "",
        isProduction: false,
      },
      silentLogger,
      makeDeps({
        taskManager,
        taskExecutor: { startExecution } as unknown as TaskExecutor,
        waitForRunnerReconciliation,
      }),
    );

    try {
      void adapter.run();
      await waitFor(() => waitForRunnerReconciliation.mock.calls.length === 1);
      orch.sockets[0]!.send(JSON.stringify({
        type: "intervene",
        requestId: "req-restart-window",
        agentSessionId: sessionId,
        text: "stay in the adopted turn",
      }));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(addIntervention).not.toHaveBeenCalled();

      reconciliation.resolve();
      await waitFor(() => orch.receivedMessages.some(
        (message) => (message as Record<string, unknown>).type === "intervene_ack",
      ));
      expect(runningDelivery).toHaveBeenCalledOnce();
      expect(autoResume).not.toHaveBeenCalled();
      expect(startExecution).not.toHaveBeenCalled();
      expect(orch.receivedMessages).toContainEqual(expect.objectContaining({
        type: "intervene_ack",
        requestId: "req-restart-window",
        outcome: "delivered",
      }));
    } finally {
      reconciliation.resolve();
      await adapter.shutdown();
    }
  });

  it("node_register 뒤 outbox pump를 연결하고 event_append_ack를 전용 처리한다", async () => {
    const handleAck = vi.fn(async () => undefined);
    const connect = vi.fn();
    const pump = {
      connect,
      disconnect: vi.fn(),
      isAck: (value: unknown) =>
        Boolean(value && typeof value === "object"
          && (value as Record<string, unknown>).type === "event_append_ack"),
      handleAck,
    } as unknown as EventOutboxPump;
    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "",
        userName: "",
        userPortraitPath: "",
        isProduction: false,
      },
      silentLogger,
      makeDeps({ eventOutboxPump: pump }),
    );

    void adapter.run();
    await waitFor(() => connect.mock.calls.length === 1);
    orch.sockets[0]!.send(JSON.stringify({
      type: "event_append_ack",
      stream_id: "018f47b7-c6de-7d64-9c8d-0b62cbbb2e10",
      acked_through: 1,
      events: [{ source_seq: 1, event_id: 9 }],
    }));
    await waitFor(() => handleAck.mock.calls.length === 1);

    expect(handleAck).toHaveBeenCalledWith(expect.objectContaining({ acked_through: 1 }));
    await adapter.shutdown();
  });

  it("release receipt ACK 전에는 명령을 차단하고 heartbeat만 허용한다", async () => {
    const releaseActivationState = new ReleaseActivationState(releaseManifest, {
      now: () => new Date("2026-08-19T09:00:00.000Z"),
      registrationIdempotencyKey: "registration-key",
    });
    releaseActivationState.markPrewarmed({
      host: "verified",
      runner: "verified",
      env: "verified",
      executable: "verified",
    });
    const createTask = vi.fn(async (params: { agentSessionId: string; prompt: string }) => ({
      agentSessionId: params.agentSessionId,
      prompt: params.prompt,
      status: "running" as const,
      createdAt: new Date("2026-08-19T09:00:00.000Z"),
      lastEventId: 0,
      lastReadEventId: 0,
      interventionQueue: [],
    }));
    const startExecution = vi.fn();
    const taskManager = {
      listTasks: () => [],
      createTask,
      cancelTask: async () => false,
      deleteTask: async () => undefined,
      shutdown: async () => undefined,
      getTask: () => undefined,
      setTaskStatus: () => undefined,
    } as unknown as TaskManager;
    const taskExecutor = { startExecution } as unknown as TaskExecutor;
    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "",
        userName: "",
        userPortraitPath: "",
        isProduction: false,
        releaseActivationState,
      },
      silentLogger,
      makeDeps({ taskManager, taskExecutor }),
    );

    void adapter.run();
    await waitFor(() => orch.receivedMessages.some(
      (message) => (message as Record<string, unknown>).type === "node_register",
    ));
    const registration = orch.receivedMessages[0] as Record<string, unknown>;
    expect(registration.release_manifest).toEqual(releaseManifest);
    expect(registration.release_activation).toMatchObject({
      manifest_id: "manifest-1",
      registration_idempotency_key: "registration-key",
    });

    orch.sockets[0]!.send(JSON.stringify({
      type: "create_session",
      agentSessionId: "blocked-session",
      prompt: "must not start",
      profile: "codex-default",
      requestId: "blocked-request",
    }));
    orch.sockets[0]!.send(JSON.stringify({
      type: "app_heartbeat_ping",
      sentAt: "2026-08-19T09:00:00.000Z",
    }));
    await waitFor(() => orch.receivedMessages.some(
      (message) => (message as Record<string, unknown>).type === "app_heartbeat_pong",
    ));
    expect(createTask).not.toHaveBeenCalled();
    expect(releaseActivationState.isReady()).toBe(false);

    orch.sockets[0]!.send(JSON.stringify({
      type: "node_register_ack",
      node_id: "eias-shopping-ts",
      release_activation_receipt: {
        manifest_id: "manifest-1",
        activation_generation: 7,
        activated_at: "2026-08-19T09:00:01.000Z",
        registration_idempotency_key: "registration-key",
      },
    }));
    await waitFor(() => releaseActivationState.isReady());
    orch.sockets[0]!.send(JSON.stringify({
      type: "create_session",
      agentSessionId: "activated-session",
      prompt: "start now",
      profile: "codex-default",
      requestId: "activated-request",
    }));
    await waitFor(() => createTask.mock.calls.length === 1);
    expect(createTask.mock.calls[0]?.[0]).toMatchObject({
      agentSessionId: "activated-session",
    });
    expect(startExecution).toHaveBeenCalledOnce();
    await adapter.shutdown();
  });

  it("dead reaped/completed runner 복구가 outbox ACK에 의존해도 부팅을 완료한다", async () => {
    await stopMockOrch(orch);
    orch = await startMockOrch({ acknowledgeRegistration: true, autoPong: true });
    const logger = pino({ level: "silent" });
    const logInfo = vi.spyOn(logger, "info");
    const recoveryApplicationReady = deferred<void>();
    const stateDirectory = await mkdtemp(join(tmpdir(), "soulstream-adapter-recovery-"));
    const registrations = [
      recoveryRegistration("reaped-a", "reaped", stateDirectory),
      recoveryRegistration("reaped-b", "reaped", stateDirectory),
      recoveryRegistration("completed-a", "completed", stateDirectory),
    ];
    const tasks = new Map(
      registrations.map((registration) => [
        registration.config.sessionId,
        recoveryTask(registration.config.sessionId),
      ]),
    );
    const markRunnerFailureAndResume = vi.fn(async (
      task: Task,
      _message: string,
      resume: (task: Task) => void,
    ) => {
      await recoveryApplicationReady.promise;
      resume(task);
    });
    const recoverRegisteredRunner = vi.fn(async () => {
      await recoveryApplicationReady.promise;
    });
    const coordinator = new RunnerRecoveryCoordinator({
      stateDirectory,
      leaseTimeoutMs: 120_000,
      scanIntervalMs: 15_000,
      taskManager: {
        hydrateRunnerRecoveryTask: async (sessionId) => tasks.get(sessionId) ?? null,
        listOwnerNullRunningInventory: async () => [],
        reconcileExecutionOwnershipObservations: async () => false,
        markRunnerFailureAndResume,
      },
      taskExecutor: {
        recoverRegisteredRunner,
        restartRegisteredRunner: vi.fn(async () => undefined),
        restartRegisteredRunnerUnderRecoveryLease: vi.fn(async () => undefined),
        withSessionRecoveryLease: async (_sessionId, operation) => await operation(),
      },
      closedTailDrainer: { drain: vi.fn(async () => undefined) },
      logger: silentLogger,
      scan: async () => ({ registrations, errors: [] }),
      hydrate: async (registration) => registration,
    });
    await coordinator.start();

    const connect = vi.fn(async () => {
      recoveryApplicationReady.resolve();
      return true;
    });
    const pump = {
      connect,
      disconnect: vi.fn(),
      isAck: () => false,
      handleAck: vi.fn(),
      isRejection: () => false,
      handleRejection: vi.fn(),
    } as unknown as EventOutboxPump;
    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "",
        userName: "",
        userPortraitPath: "",
        isProduction: false,
      },
      logger,
      makeDeps({
        eventOutboxPump: pump,
        waitForRunnerReconciliation: async () => await coordinator.waitForSettled(),
      }),
    );

    try {
      void adapter.run();
      await waitFor(() => connect.mock.calls.length === 1);
      await waitFor(() => orch.receivedMessages.some(
        (message) => (message as Record<string, unknown>).type === "app_heartbeat_ping",
      ));
      await waitFor(() => recoverRegisteredRunner.mock.calls.length === 3);

      expect((orch.receivedMessages[0] as Record<string, unknown>).type).toBe("node_register");
      expect(markRunnerFailureAndResume).toHaveBeenCalledTimes(2);
      expect(recoverRegisteredRunner).toHaveBeenCalledTimes(3);
      expect(logInfo).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: "eias-shopping-ts" }),
        "Registered with upstream",
      );
    } finally {
      recoveryApplicationReady.resolve();
      await adapter.shutdown();
      await coordinator.stop();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("resets reconnect backoff only after registration ACK and initial outbox catch-up", async () => {
    await stopMockOrch(orch);
    orch = await startMockOrch({ acknowledgeRegistration: true });
    const reconnectPolicy = new RecordingReconnectPolicy();
    const pump = {
      connect: vi.fn(async () => true),
      disconnect: vi.fn(),
      isAck: () => false,
      handleAck: vi.fn(),
      isRejection: () => false,
      handleRejection: vi.fn(),
    } as unknown as EventOutboxPump;
    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "",
        userName: "",
        userPortraitPath: "",
        isProduction: false,
      },
      silentLogger,
      makeDeps({ eventOutboxPump: pump, reconnectPolicy }),
    );

    void adapter.run();
    await waitFor(() => reconnectPolicy.resetCalls === 1);

    expect(pump.connect).toHaveBeenCalledOnce();
    expect(reconnectPolicy.waitedDelays).toEqual([]);
    await adapter.shutdown();
  });

  it("grows reconnect backoff when registration ACK arrives but poison catch-up never completes", async () => {
    await stopMockOrch(orch);
    orch = await startMockOrch({
      acknowledgeRegistration: true,
      closeRegistrations: 3,
    });
    const reconnectPolicy = new RecordingReconnectPolicy();
    const neverDrained = new Promise<boolean>(() => undefined);
    const pump = {
      connect: vi.fn(() => neverDrained),
      disconnect: vi.fn(),
      isAck: () => false,
      handleAck: vi.fn(),
      isRejection: () => false,
      handleRejection: vi.fn(),
    } as unknown as EventOutboxPump;
    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "",
        userName: "",
        userPortraitPath: "",
        isProduction: false,
      },
      silentLogger,
      makeDeps({ eventOutboxPump: pump, reconnectPolicy }),
    );

    void adapter.run();
    await waitFor(() => reconnectPolicy.waitedDelays.length >= 3);

    expect(reconnectPolicy.waitedDelays.slice(0, 3)).toEqual([3, 6, 12]);
    expect(reconnectPolicy.resetCalls).toBe(0);
    await adapter.shutdown();
  });

  it("handles outbox rejection while reconciliation is pending and treats readiness as false", async () => {
    await stopMockOrch(orch);
    orch = await startMockOrch({ acknowledgeRegistration: true });
    const reconciliation = deferred<void>();
    const reconnectPolicy = new RecordingReconnectPolicy();
    const connectFailure = new Error("outbox catch-up failed");
    const neverDrained = new Promise<boolean>(() => undefined);
    const connect = vi.fn()
      .mockRejectedValueOnce(connectFailure)
      .mockImplementation(() => neverDrained);
    const pump = {
      connect,
      disconnect: vi.fn(),
      isAck: () => false,
      handleAck: vi.fn(),
      isRejection: () => false,
      handleRejection: vi.fn(),
    } as unknown as EventOutboxPump;
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "",
        userName: "",
        userPortraitPath: "",
        isProduction: false,
      },
      silentLogger,
      makeDeps({
        eventOutboxPump: pump,
        reconnectPolicy,
        waitForRunnerReconciliation: async () => await reconciliation.promise,
      }),
    );

    try {
      void adapter.run();
      await waitFor(() => connect.mock.calls.length === 1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toEqual([]);

      reconciliation.resolve();
      await waitFor(() => reconnectPolicy.waitedDelays.length === 1);
      expect(reconnectPolicy.resetCalls).toBe(0);
    } finally {
      reconciliation.resolve();
      process.off("unhandledRejection", onUnhandledRejection);
      await adapter.shutdown();
    }
  });

  it("registry 변경 후 같은 WebSocket으로 node_register를 재공지한다", async () => {
    const deps = makeDeps();
    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "",
        userName: "",
        userPortraitPath: "",
        isProduction: false,
      },
      silentLogger,
      deps,
    );

    void adapter.run();
    await waitFor(() => orch.receivedMessages.length >= 1);

    deps.agentRegistry.replace([
      codexAgent,
      {
        id: "fable",
        name: "서소영 Fable",
        backend: "codex",
        workspace_dir: "/tmp/fable",
      },
    ]);
    await adapter.reannounceAgentCatalog();
    await waitFor(
      () =>
        orch.receivedMessages.filter(
          (msg) => (msg as Record<string, unknown>).type === "node_register",
        ).length >= 2,
    );

    const registerMessages = orch.receivedMessages.filter(
      (msg) => (msg as Record<string, unknown>).type === "node_register",
    ) as Array<Record<string, unknown>>;
    const latest = registerMessages.at(-1) as Record<string, unknown>;
    expect((latest.agents as Array<Record<string, unknown>>).map((a) => a.id)).toEqual([
      "codex-default",
      "fable",
    ]);
    expect(latest.capabilities).toMatchObject({ max_concurrent: 2 });

    await adapter.shutdown();
  });

  it("새 orch와 capability가 합의되면 영속 dump 없이 runner inventory만 보낸다", async () => {
    await stopMockOrch(orch);
    orch = await startMockOrch({
      acknowledgeRegistration: true,
      acknowledgementCapabilities: { runner_inventory_v1: true },
    });
    const reconciliationOrder: string[] = [];
    const sessionDb = {
      listSessionsForUpstreamDump: vi.fn(async () => ({ sessions: [], total: 0 })),
    } as unknown as SessionDB;
    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "",
        userName: "",
        userPortraitPath: "",
        isProduction: false,
      },
      silentLogger,
      makeDeps({
        sessionDb,
        runningSessionIds: ["sess-memory", "sess-shared"],
        waitForRunnerReconciliation: async () => {
          reconciliationOrder.push("drained");
        },
        listLiveRunnerSessionIds: async () => {
          reconciliationOrder.push("scanned");
          return ["sess-runner", "sess-shared"];
        },
      }),
    );

    void adapter.run();
    await waitFor(() =>
      orch.receivedMessages.some(
        (msg) => (msg as Record<string, unknown>).type === "runner_inventory",
      ),
    );

    expect(sessionDb.listSessionsForUpstreamDump).not.toHaveBeenCalled();
    expect(orch.receivedMessages.find(
      (msg) => (msg as Record<string, unknown>).type === "runner_inventory",
    )).toMatchObject({
      type: "runner_inventory",
      running_session_ids: ["sess-memory", "sess-shared", "sess-runner"],
    });
    expect(reconciliationOrder).toEqual(["drained", "scanned"]);

    await adapter.shutdown();
  });

  it("구 orch ACK에는 새 frame을 보내지 않고 기존 sessions_update를 유지한다", async () => {
    await stopMockOrch(orch);
    orch = await startMockOrch({ acknowledgeRegistration: true });
    const reconciliationOrder: string[] = [];
    const sessionDb = {
      listSessionsForUpstreamDump: vi.fn(async () => ({
        sessions: [
          {
            session_id: "sess-1",
            display_name: "Running",
            status: "running",
            session_type: "codex",
            created_at: new Date("2026-06-07T00:00:00Z"),
            updated_at: new Date("2026-06-07T00:01:00Z"),
            event_count: 3,
            away_summary: null,
            caller_session_id: null,
            last_event_id: 3,
            last_read_event_id: 0,
            node_id: "eias-shopping-ts",
          },
        ],
        total: 1,
      })),
    } as unknown as SessionDB;
    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "",
        userName: "",
        userPortraitPath: "",
        isProduction: false,
      },
      silentLogger,
      makeDeps({
        sessionDb,
        runningSessionIds: ["sess-memory", "sess-shared"],
        waitForRunnerReconciliation: async () => {
          reconciliationOrder.push("drained");
        },
        listLiveRunnerSessionIds: async () => {
          reconciliationOrder.push("scanned");
          return ["sess-runner", "sess-shared"];
        },
      }),
    );

    void adapter.run();
    await waitFor(() =>
      orch.receivedMessages.some(
        (msg) => (msg as Record<string, unknown>).type === "sessions_update",
      ),
    );

    expect(sessionDb.listSessionsForUpstreamDump).toHaveBeenCalledWith({
      limit: 10_000,
      offset: 0,
      nodeId: "eias-shopping-ts",
    });
    const second = orch.receivedMessages.find(
      (msg) => (msg as Record<string, unknown>).type === "sessions_update",
    ) as Record<string, unknown>;
    expect(second).toMatchObject({
      type: "sessions_update",
      total: 1,
      requestId: "",
      running_session_ids: ["sess-memory", "sess-shared", "sess-runner"],
    });
    expect((second.sessions as Array<Record<string, unknown>>)[0]).toMatchObject({
      session_id: "sess-1",
      last_event_id: 3,
    });
    expect(orch.receivedMessages.some(
      (msg) => (msg as Record<string, unknown>).type === "runner_inventory",
    )).toBe(false);
    expect(reconciliationOrder).toEqual(["drained", "scanned"]);

    await adapter.shutdown();
  });

  it("health_check 명령을 받으면 health_status로 응답한다", async () => {
    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "",
        userName: "",
        userPortraitPath: "",
        isProduction: false,
      },
      silentLogger,
      makeDeps(),
    );

    void adapter.run();
    await waitFor(() => orch.sockets.length >= 1 && orch.receivedMessages.length >= 1);

    // orch가 health_check를 보냄
    orch.sockets[0]!.send(JSON.stringify({ type: "health_check", requestId: "hc-1" }));

    await waitFor(() =>
      orch.receivedMessages.some(
        (msg) => (msg as Record<string, unknown>).type === "health_status",
      ),
    );

    const reply = orch.receivedMessages.find(
      (msg) => (msg as Record<string, unknown>).type === "health_status",
    ) as Record<string, unknown>;
    expect(reply.type).toBe("health_status");
    expect(reply.node_id).toBe("eias-shopping-ts");
    expect(reply.requestId).toBe("hc-1");
    // Phase B-3: max_concurrent=agents.length=1, active=runningTasks=0
    expect(reply.runners).toEqual({ max_concurrent: 1, active: 0 });

    await adapter.shutdown();
  });

  it("respond 필수 필드 누락 시 명시 error 응답", async () => {
    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "",
        userName: "",
        userPortraitPath: "",
        isProduction: false,
      },
      silentLogger,
      makeDeps(),
    );
    void adapter.run();
    await waitFor(() => orch.sockets.length >= 1 && orch.receivedMessages.length >= 1);

    // P4에서 respond는 implemented — 필수 필드 누락은 명시 validation error.
    orch.sockets[0]!.send(JSON.stringify({ type: "respond", requestId: "r-1" }));
    await waitFor(() =>
      orch.receivedMessages.some(
        (msg) => (msg as Record<string, unknown>).type === "error",
      ),
    );

    const reply = orch.receivedMessages.find(
      (msg) => (msg as Record<string, unknown>).type === "error",
    ) as Record<string, unknown>;
    expect(reply.type).toBe("error");
    expect(reply.command_type).toBe("respond");
    expect(reply.requestId).toBe("r-1");
    expect(reply.message).toContain("respond requires agentSessionId");

    await adapter.shutdown();
  });

  it("AUTH_BEARER_TOKEN 헤더로 Bearer 인증을 보낸다", async () => {
    await stopMockOrch(orch);
    orch = await startMockOrch({ authToken: "test-token" });

    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "test-token",
        userName: "",
        userPortraitPath: "",
        isProduction: false,
      },
      silentLogger,
      makeDeps(),
    );
    void adapter.run();
    await waitFor(() => orch.receivedMessages.length >= 1);

    expect(orch.receivedMessages.length).toBeGreaterThan(0);
    await adapter.shutdown();
  });

  it("잘못된 AUTH 토큰이면 연결 close → 재연결 시도 (running 종료 후 정리)", async () => {
    await stopMockOrch(orch);
    orch = await startMockOrch({ authToken: "correct-token" });

    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "wrong-token",
        userName: "",
        userPortraitPath: "",
        isProduction: false,
      },
      silentLogger,
      makeDeps(),
    );
    void adapter.run();

    // 잠시 대기 — 토큰 거부로 receivedMessages 0건 유지되어야 함
    await new Promise((r) => setTimeout(r, 200));
    expect(orch.receivedMessages).toHaveLength(0);

    await adapter.shutdown();
  });

  it("orch app_heartbeat_ping에 app_heartbeat_pong으로 응답한다", async () => {
    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "",
        userName: "",
        userPortraitPath: "",
        isProduction: false,
      },
      silentLogger,
      makeDeps(),
    );

    void adapter.run();
    await waitFor(() => orch.sockets.length >= 1 && orch.receivedMessages.length >= 1);

    orch.sockets[0]!.send(JSON.stringify({
      type: "app_heartbeat_ping",
      sentAt: "2026-06-08T00:00:00Z",
    }));

    await waitFor(() =>
      orch.receivedMessages.some(
        (msg) => (msg as Record<string, unknown>).type === "app_heartbeat_pong",
      ),
    );

    const pong = orch.receivedMessages.find(
      (msg) => (msg as Record<string, unknown>).type === "app_heartbeat_pong",
    ) as Record<string, unknown>;
    expect(pong.sentAt).toBe("2026-06-08T00:00:00Z");

    await adapter.shutdown();
  });

  it("node_register 직후 초기 세션 dump가 지연되어도 orch heartbeat ping에 응답한다", async () => {
    await stopMockOrch(orch);
    orch = await startMockOrch({ pingOnRegister: true, acknowledgeRegistration: true });

    const sessionDump = deferred<{
      sessions: [];
      total: number;
    }>();
    const sessionDb = {
      listSessionsForUpstreamDump: vi.fn(() => sessionDump.promise),
    } as unknown as SessionDB;
    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "",
        userName: "",
        userPortraitPath: "",
        isProduction: false,
      },
      silentLogger,
      makeDeps({ sessionDb }),
    );

    void adapter.run();
    await waitFor(() =>
      orch.receivedMessages.some(
        (msg) => (msg as Record<string, unknown>).type === "node_register",
      ),
    );
    await waitFor(() =>
      orch.receivedMessages.some(
        (msg) => (msg as Record<string, unknown>).type === "app_heartbeat_pong",
      ),
      500,
    );

    sessionDump.resolve({ sessions: [], total: 0 });
    await waitFor(() =>
      orch.receivedMessages.some(
        (msg) => (msg as Record<string, unknown>).type === "sessions_update",
      ),
    );

    await adapter.shutdown();
  });

  it("허브가 ping을 보내지 않아도 등록 직후 능동적으로 app_heartbeat_ping을 발신한다", async () => {
    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "",
        userName: "",
        userPortraitPath: "",
        isProduction: false,
      },
      silentLogger,
      makeDeps(),
    );

    void adapter.run();
    await waitFor(() =>
      orch.receivedMessages.some(
        (msg) => (msg as Record<string, unknown>).type === "app_heartbeat_ping",
      ),
    );

    await adapter.shutdown();
  });

  it("허브가 ping도 pong도 보내지 않으면(half-open) 연결을 닫고 재연결 루프로 넘긴다", async () => {
    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "",
        userName: "",
        userPortraitPath: "",
        isProduction: false,
        heartbeatIntervalMs: 10,
        heartbeatMaxMissed: 1,
      },
      silentLogger,
      makeDeps(),
    );

    void adapter.run();
    await waitFor(() => orch.sockets.length >= 1 && orch.receivedMessages.length >= 1);

    await waitFor(
      () =>
        orch.sockets[0]!.readyState === orch.sockets[0]!.CLOSED ||
        orch.sockets[0]!.readyState === orch.sockets[0]!.CLOSING,
      500,
    );

    await adapter.shutdown();
  });

  it("app heartbeat pong이 없으면 연결을 닫고 재연결 루프로 넘긴다", async () => {
    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "",
        userName: "",
        userPortraitPath: "",
        isProduction: false,
        heartbeatIntervalMs: 10,
        heartbeatMaxMissed: 1,
      },
      silentLogger,
      makeDeps(),
    );

    void adapter.run();
    await waitFor(() => orch.sockets.length >= 1 && orch.receivedMessages.length >= 1);

    orch.sockets[0]!.send(JSON.stringify({
      type: "app_heartbeat_ping",
      sentAt: "2026-06-08T00:00:00Z",
    }));

    await waitFor(
      () =>
        orch.sockets[0]!.readyState === orch.sockets[0]!.CLOSED ||
        orch.sockets[0]!.readyState === orch.sockets[0]!.CLOSING,
      500,
    );

    await adapter.shutdown();
  });
});

class RecordingReconnectPolicy implements ReconnectPolicyBoundary {
  private currentDelay = 3;
  attempt = 0;
  resetCalls = 0;
  readonly waitedDelays: number[] = [];

  get currentDelaySeconds(): number {
    return this.currentDelay;
  }

  reset(): void {
    this.resetCalls += 1;
    this.currentDelay = 3;
    this.attempt = 0;
  }

  async wait(): Promise<void> {
    this.waitedDelays.push(this.currentDelay);
    this.attempt += 1;
    this.currentDelay = Math.min(this.currentDelay * 2, 60);
  }
}

describe("isConnectionError", () => {
  it("ECONNREFUSED는 연결 오류", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(isConnectionError(err)).toBe(true);
  });

  it("ETIMEDOUT, ENOTFOUND, ECONNRESET, EHOSTUNREACH, ENETUNREACH 모두 연결 오류", () => {
    const codes = ["ETIMEDOUT", "ENOTFOUND", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"];
    for (const code of codes) {
      const err = Object.assign(new Error(`x ${code}`), { code });
      expect(isConnectionError(err), `for ${code}`).toBe(true);
    }
  });

  it("WS handshake 메시지는 연결 오류", () => {
    const err = new Error("Unexpected server response: 401");
    expect(isConnectionError(err)).toBe(true);
  });

  it("일반 TypeError는 연결 오류가 아님", () => {
    expect(isConnectionError(new TypeError("cannot read property foo of undefined"))).toBe(false);
  });

  it("Error 아닌 값은 false", () => {
    expect(isConnectionError("string error")).toBe(false);
    expect(isConnectionError(null)).toBe(false);
    expect(isConnectionError(undefined)).toBe(false);
  });
});

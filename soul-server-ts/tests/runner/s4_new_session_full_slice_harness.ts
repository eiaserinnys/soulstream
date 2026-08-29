import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import pino from "pino";

import {
  createApp,
  createLiveDbCatalogRepository,
  type LivePostgresSql,
} from "../../../orch-server-ts/src/index.js";
import { NodeEventIngressController } from
  "../../../orch-server-ts/src/node/event_ingress_controller.js";
import {
  EventIngressRepository,
  type EventIngressSql,
} from "../../../orch-server-ts/src/node/event_ingress_repository.js";
import { applyEventSessionEffect } from
  "../../../orch-server-ts/src/node/event_session_effect_applier.js";
import {
  InMemoryNodeRegistry,
  type NodeRegistryEvent,
} from "../../../orch-server-ts/src/node/registry.js";
import { AgentRegistry, type AgentProfile } from "../../src/agent_registry.js";
import { parseEnv } from "../../src/config.js";
import { EventPersistence } from "../../src/db/event_persistence.js";
import { SessionDB } from "../../src/db/session_db.js";
import { DbClaudeSessionStore } from "../../src/engine/claude_session_store.js";
import { McpConfigService } from "../../src/mcp_config_service.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import { readRunnerRegistrationIdentity } from
  "../../src/runner/runner_registration_identity.js";
import { composeRunnerProcessRuntime } from
  "../../src/runtime/runner_process_composition.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import { TaskManager } from "../../src/task/task_manager.js";
import type { Task } from "../../src/task/task_models.js";
import { CommandDispatcher } from "../../src/upstream/dispatcher.js";
import { EventOutbox, type EventOutboxBatch } from "../../src/upstream/event_outbox.js";
import { EventOutboxPump } from "../../src/upstream/event_outbox_pump.js";
import { EventOutboxPumpMux } from "../../src/upstream/event_outbox_pump_mux.js";
import { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import type { FullSchemaPostgresHarness } from
  "../db/full_schema_postgres_harness.js";
import { configureTestSessionDataHost } from "../helpers/session_data_test_host.js";
import { createS4SessionMutationHost } from "./s4_session_mutation_host.js";
import type { S4Observation } from "./s4_new_session_full_slice_types.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const childFixturePath = join(testDirectory, "fixtures/runner_process_e2e_child.ts");
const requireFromTest = createRequire(import.meta.url);
const logger = pino({ level: "silent" });

export const S4_SESSION_ID = "s4-new-session-full-slice";
const S4_NODE_ID = "s4-new-server";
const S4_PROMPT = "S4 fresh-session prompt";

type Composition = NonNullable<Awaited<ReturnType<typeof composeRunnerProcessRuntime>>>;

export class S4NewSessionFullSliceHarness {
  private childPid: number | undefined;

  private constructor(
    private readonly sql: FullSchemaPostgresHarness["sql"],
    private readonly root: string,
    private readonly controlDirectory: string,
    private readonly stateDirectory: string,
    private readonly releaseDirectory: string,
    private readonly composition: Composition,
    private readonly mux: EventOutboxPumpMux,
    private readonly controller: NodeEventIngressController,
    private readonly taskManager: TaskManager,
    private readonly dispatcher: CommandDispatcher,
    private readonly entry: S4Observation["entry"],
    private readonly executionPromise: { current?: Promise<void> },
    private readonly pumpErrors: string[],
  ) {}

  static async create(
    postgres: FullSchemaPostgresHarness,
  ): Promise<S4NewSessionFullSliceHarness> {
    const root = await mkdtemp(join(tmpdir(), "s4-full-slice-"));
    const stateDirectory = join(root, "state");
    const artifactDirectory = join(root, "artifacts");
    const releasesDirectory = join(root, "runner-releases");
    const controlDirectory = join(root, "control");
    const outboxDirectory = join(root, "event-outbox");
    await Promise.all([
      mkdir(artifactDirectory, { recursive: true }),
      mkdir(controlDirectory, { recursive: true }),
    ]);
    await writeFile(join(artifactDirectory, "package.json"), "{\"type\":\"module\"}\n");
    await writeFile(
      join(artifactDirectory, "runner_entry.js"),
      `await import(${JSON.stringify(pathToFileURL(childFixturePath).href)});\n`,
    );
    const agentsConfigPath = join(root, "agents.yaml");
    const registryPath = join(root, "mcp-registry.yaml");
    const profilesPath = join(root, "mcp-profiles.yaml");
    await writeFile(agentsConfigPath, "agents: []\n");
    await writeFile(registryPath, "servers: []\n");
    await writeFile(profilesPath, "profiles: []\n");

    const env = parseEnv({
      SOULSTREAM_NODE_ID: S4_NODE_ID,
      SOULSTREAM_UPSTREAM_URL: "ws://127.0.0.1:1/ws/node",
      EVENT_OUTBOX_DIR: outboxDirectory,
      SOUL_RUNNER_PROCESS_ENABLED: "true",
      SOUL_RUNNER_STATE_DIR: stateDirectory,
      SOUL_RUNNER_ARTIFACT_DIR: artifactDirectory,
      SOUL_RUNNER_RELEASES_DIR: releasesDirectory,
      SOUL_RUNNER_LEASE_TIMEOUT_MS: "90000",
      MCP_ENABLED: "false",
    });
    const agent: AgentProfile = {
      id: "s4-codex-agent",
      name: "S4 Codex Agent",
      backend: "codex",
      workspace_dir: controlDirectory,
    };
    const registry = new AgentRegistry([agent]);
    const sql = postgres.createPeer();
    const db = new SessionDB();
    configureTestSessionDataHost(db, sql);
    const sessionMutations = createS4SessionMutationHost(sql);

    const publishedEvents: NodeRegistryEvent[] = [];
    const nodeRegistry = new InMemoryNodeRegistry();
    const registration = nodeRegistry.registerNode({
      type: "node_register",
      node_id: S4_NODE_ID,
      user: { email: "s4@example.com" },
      sessions: [],
    });
    const connection = {
      nodeId: S4_NODE_ID,
      connectionId: registration.node.connectionId,
    };
    const receiveWorkerMessage = async (message: unknown): Promise<void> => {
      publishedEvents.push(...nodeRegistry.receiveNodeMessage(connection, message as never));
    };
    const broadcaster = new SessionBroadcaster(receiveWorkerMessage, registry, S4_NODE_ID);
    const outbox = await EventOutbox.open(outboxDirectory);
    const pumpErrors: string[] = [];
    const pump = new EventOutboxPump(outbox, (error) => {
      pumpErrors.push(error instanceof Error ? error.message : String(error));
    });
    const mux = new EventOutboxPumpMux(pump);
    const ingressSql = postgres.createPeer();
    const ingress = new EventIngressRepository(
      { resolveSql: async () => ingressSql as unknown as EventIngressSql },
      applyEventSessionEffect,
    );
    let ackTail = Promise.resolve();
    const controller = new NodeEventIngressController({
      nodeId: S4_NODE_ID,
      connectionId: registration.node.connectionId,
      committer: { commitBatch: (nodeId, batch) => ingress.commitBatch(nodeId, batch) },
      isCurrentConnection: () => true,
      receiveCommittedEvent: (message) => nodeRegistry.receiveNodeMessage(connection, message),
      publish: (events) => { publishedEvents.push(...events); },
      send: (frame) => {
        if (mux.isAck(frame)) {
          ackTail = ackTail.then(async () => await mux.handleAck(frame));
        } else if (mux.isRejection(frame)) {
          ackTail = ackTail.then(async () => { await mux.handleRejection(frame); });
        } else {
          pumpErrors.push(`unexpected ingress frame: ${JSON.stringify(frame)}`);
        }
      },
      close: (_code, reason) => { pumpErrors.push(`ingress closed: ${reason}`); },
      logError: (error) => {
        pumpErrors.push(error instanceof Error ? error.message : String(error));
      },
      logWarn: () => undefined,
    });
    await mux.connect(async (batch: EventOutboxBatch) => {
      controller.enqueue(batch as unknown as Record<string, unknown>);
      await controller.drain();
      await ackTail;
    });
    const persistence = new EventPersistence(db, broadcaster, logger, outbox, pump);
    const mcpConfigService = new McpConfigService({
      agentsConfigPath,
      registryPath,
      profilesPath,
    });
    const composition = await composeRunnerProcessRuntime(true, {
      env,
      logger,
      pumpMux: mux,
      sessionStore: new DbClaudeSessionStore(db),
      mcpConfigService,
      buildChildProcessEnv: () => ({
        ...process.env,
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS,
          `--import ${pathToFileURL(requireFromTest.resolve("tsx")).href}`,
        ].filter(Boolean).join(" "),
        RUNNER_E2E_CONTROL_DIR: controlDirectory,
        RUNNER_E2E_S4_SCENARIO: "1",
      }),
      renewExecutionOwnership: async (task, renewedAt) => {
        const ownership = task.executionOwnership;
        if (!ownership) throw new Error("S4 ownership unavailable for renewal");
        const application = await persistence.renewExecutionOwnershipAndWaitForApplication(
          task.agentSessionId,
          {
            ...ownership,
            leaseExpiresAt: new Date(renewedAt.getTime() + env.SOUL_RUNNER_LEASE_TIMEOUT_MS),
            updatedAt: renewedAt,
          },
        );
        return application.applied;
      },
    });
    if (!composition) throw new Error("S4 runner composition unexpectedly disabled");
    const release = (await readdir(releasesDirectory))
      .find((entry) => entry.startsWith("sha256-"));
    if (!release) throw new Error("S4 runner release was not materialized");

    const taskManager = new TaskManager(
      S4_NODE_ID,
      db,
      broadcaster,
      logger,
      persistence,
      undefined,
      registry,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      sessionMutations,
    );
    const taskExecutor = new TaskExecutor(
      () => { throw new Error("S4 must use the detached process runner"); },
      db,
      persistence,
      broadcaster,
      logger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      composition.runtimeFactory,
    );
    const paths = runnerProcessPaths(stateDirectory, S4_SESSION_ID);
    const entry: S4Observation["entry"] = {
      callCount: 0,
      status: "missing",
      prompt: "missing",
      runnerAttached: true,
      ownershipAttached: true,
      executionPromiseAttached: true,
      pidPresent: true,
      socketPresent: true,
      lockPresent: true,
    };
    const executionPromise: { current?: Promise<void> } = {};
    const startExecution = taskExecutor.startExecution.bind(taskExecutor);
    taskExecutor.startExecution = (task, profile, activation) => {
      entry.callCount += 1;
      entry.status = task.status;
      entry.prompt = task.prompt;
      entry.runnerAttached = task.runner !== undefined;
      entry.ownershipAttached = task.executionOwnership !== undefined;
      entry.executionPromiseAttached = task.executionPromise !== undefined;
      entry.pidPresent = existsSync(paths.pidPath);
      entry.socketPresent = existsSync(paths.socketPath);
      entry.lockPresent = existsSync(paths.lockPath);
      const promise = startExecution(task, profile, activation);
      executionPromise.current = promise;
      return promise;
    };
    const dispatcher = new CommandDispatcher(
      receiveWorkerMessage,
      logger,
      S4_NODE_ID,
      registry,
      taskManager,
      taskExecutor,
    );
    return new S4NewSessionFullSliceHarness(
      sql,
      root,
      controlDirectory,
      stateDirectory,
      join(releasesDirectory, release),
      composition,
      mux,
      controller,
      taskManager,
      dispatcher,
      entry,
      executionPromise,
      pumpErrors,
    );
  }

  async run(): Promise<S4Observation> {
    await this.dispatcher.dispatch({
      type: "create_session",
      agentSessionId: S4_SESSION_ID,
      prompt: S4_PROMPT,
      profile: "s4-codex-agent",
      requestId: "s4-create-request",
    });
    const task = this.taskManager.getTask(S4_SESSION_ID);
    if (!task || !this.executionPromise.current) {
      throw new Error("S4 create_session did not enter TaskExecutor");
    }
    await this.executionPromise.current;

    const child = JSON.parse(
      await readFile(join(this.controlDirectory, "s4-execution.json"), "utf8"),
    ) as { pid: number; params: { prompt?: string; executionGeneration?: number } };
    this.childPid = child.pid;
    const [session] = await this.sql<Array<{
      status: string;
      termination_reason: string | null;
      execution_generation: number;
      execution_manifest_id: string | null;
      execution_runtime_env_identity: string | null;
      execution_registration_id: string | null;
      execution_pid: number | null;
      execution_start_identity: string | null;
      execution_command_id: string | null;
    }>>`
      SELECT status, termination_reason, execution_generation::int,
             execution_manifest_id, execution_runtime_env_identity,
             execution_registration_id, execution_pid,
             execution_start_identity, execution_command_id
      FROM sessions WHERE session_id = ${S4_SESSION_ID}
    `;
    if (!session) throw new Error("S4 canonical session missing");
    const [counts] = await this.sql<Array<{
      durable_event_count: number;
      receipt_count: number;
      acquire_count: number;
      release_count: number;
      delivery_count: number;
    }>>`
      SELECT
        (SELECT COUNT(*)::int FROM events WHERE session_id = ${S4_SESSION_ID})
          AS durable_event_count,
        (SELECT COUNT(*)::int FROM event_ingress_receipts
          WHERE session_id = ${S4_SESSION_ID}) AS receipt_count,
        (SELECT COUNT(*)::int FROM events
          WHERE session_id = ${S4_SESSION_ID}
            AND event_type = 'metadata'
            AND payload->>'metadata_type' = 'execution_ownership_transition'
            AND payload->'value'->>'phase' = 'execution_acquire') AS acquire_count,
        (SELECT COUNT(*)::int FROM events
          WHERE session_id = ${S4_SESSION_ID}
            AND event_type = 'session_ended') AS release_count,
        (SELECT COUNT(*)::int FROM session_deliveries
          WHERE target_session_id = ${S4_SESSION_ID}) AS delivery_count
    `;
    const userVisible = await this.replayUserVisibleEvents();
    const paths = runnerProcessPaths(this.stateDirectory, S4_SESSION_ID);
    const identity = await readRunnerRegistrationIdentity(paths.sessionDirectory);
    return {
      entry: { ...this.entry },
      child: {
        pid: child.pid,
        prompt: child.params.prompt ?? null,
        executionGeneration: child.params.executionGeneration ?? null,
      },
      receipt: {
        receiptCount: Number(counts?.receipt_count ?? 0),
        durableEventCount: Number(counts?.durable_event_count ?? 0),
        deliveryCount: Number(counts?.delivery_count ?? 0),
        pumpErrors: [...this.pumpErrors],
      },
      terminal: {
        status: session.status,
        terminationReason: session.termination_reason,
        executionGeneration: Number(session.execution_generation),
        executionIdentityCleared: [
          session.execution_manifest_id,
          session.execution_runtime_env_identity,
          session.execution_registration_id,
          session.execution_pid,
          session.execution_start_identity,
          session.execution_command_id,
        ].every((value) => value === null),
        acquireCount: Number(counts?.acquire_count ?? 0),
        releaseCount: Number(counts?.release_count ?? 0),
      },
      userVisible,
      nextTurn: { startExecutionCallCount: this.entry.callCount },
      cleanup: {
        taskStatus: task.status,
        runnerAttached: task.runner !== undefined,
        executionPromiseAttached: task.executionPromise !== undefined,
        registrationPid: identity?.pid ?? null,
        pidPresent: existsSync(paths.pidPath),
        socketPresent: existsSync(paths.socketPath),
        lockPresent: existsSync(paths.lockPath),
        pidAlive: isPidAlive(child.pid),
      },
    };
  }

  private async replayUserVisibleEvents(): Promise<S4Observation["userVisible"]> {
    const [cursor] = await this.sql<Array<{ first_event_id: number }>>`
      SELECT MIN(id)::int AS first_event_id
      FROM events
      WHERE session_id = ${S4_SESSION_ID}
    `;
    if (!cursor?.first_event_id) {
      throw new Error("S4 durable event cursor missing");
    }
    const repository = createLiveDbCatalogRepository({
      sql: this.sql as unknown as LivePostgresSql,
    });
    const app = createApp({
      config: {
        environment: "test",
        databaseUrl: "postgresql://test/test",
        authBearerToken: "test-token",
      },
      sessionHistoryRoutes: {
        provider: repository.sessionHistoryProvider,
        closeAfterHistorySync: true,
      },
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/sessions/${S4_SESSION_ID}/events`,
        headers: { "last-event-id": String(cursor.first_event_id) },
      });
      const frames = response.body
        .split("\n\n")
        .map((chunk) => chunk.trim())
        .filter(Boolean)
        .map((chunk) => {
          const event = chunk.split("\n")
            .find((line) => line.startsWith("event: "))?.slice(7) ?? "";
          const data = chunk.split("\n")
            .find((line) => line.startsWith("data: "))?.slice(6) ?? "null";
          return { event, data: JSON.parse(data) as unknown };
        });
      return {
        statusCode: response.statusCode,
        assistantReplyCount: frames.filter((frame) =>
          frame.event === "assistant_message"
          && isRecord(frame.data)
          && frame.data.content === "S4 initial reply").length,
        completionCount: frames.filter((frame) => frame.event === "session_ended").length,
      };
    } finally {
      await app.close();
      await repository.close();
    }
  }

  async cleanup(): Promise<void> {
    this.controller.stop();
    this.mux.disconnect();
    if (this.childPid && isPidAlive(this.childPid)) {
      process.kill(this.childPid, "SIGKILL");
    }
    await this.composition.hostOwnership.release();
    await chmod(this.releaseDirectory, 0o755).catch(() => undefined);
    await rm(this.root, { recursive: true, force: true });
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

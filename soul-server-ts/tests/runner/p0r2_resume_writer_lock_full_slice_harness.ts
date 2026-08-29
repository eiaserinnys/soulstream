import { createRequire } from "node:module";
import {
  access,
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

import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";

import { ClaudeTranscriptRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/claude_transcript_repository.js";
import { SessionMutationRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_mutation_repository.js";
import { SessionDeliveryRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_delivery_repository.js";
import { NodeEventIngressController } from
  "../../../orch-server-ts/src/node/event_ingress_controller.js";
import {
  EventIngressRepository,
  type EventIngressSql,
} from "../../../orch-server-ts/src/node/event_ingress_repository.js";
import { applyEventSessionEffect } from
  "../../../orch-server-ts/src/node/event_session_effect_applier.js";
import { InMemoryNodeRegistry } from
  "../../../orch-server-ts/src/node/registry.js";
import type { NodeRegistryEvent } from
  "../../../orch-server-ts/src/node/registry_types.js";
import {
  createLiveDbSqlResolver,
  type LivePostgresSql,
} from "../../../orch-server-ts/src/runtime/live_db_sql.js";
import { createLiveSessionHistoryProvider } from
  "../../../orch-server-ts/src/runtime/live_session_history_provider.js";
import {
  createRuntimeSessionEventHubSink,
  RuntimeSessionEventHub,
} from "../../../orch-server-ts/src/runtime/session_event_hub.js";
import { registerSessionHistoryRoutes } from
  "../../../orch-server-ts/src/session/session_history_routes.js";
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
import { AutoResumeTransition } from "../../src/task/task_auto_resume_transition.js";
import { TaskDeliveryLedgerGate } from "../../src/task/task_delivery_ledger_gate.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import { TaskInterventionRoute } from "../../src/task/task_intervention_route.js";
import type { Task } from "../../src/task/task_models.js";
import { RunningInterventionTransition } from
  "../../src/task/task_running_intervention_transition.js";
import { EventOutbox, type EventOutboxBatch } from "../../src/upstream/event_outbox.js";
import { EventOutboxPump } from "../../src/upstream/event_outbox_pump.js";
import { EventOutboxPumpMux } from "../../src/upstream/event_outbox_pump_mux.js";
import { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import type { FullSchemaPostgresHarness } from
  "../db/full_schema_postgres_harness.js";
import { configureTestSessionDataHost } from "../helpers/session_data_test_host.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const childFixturePath = join(testDirectory, "fixtures/runner_process_e2e_child.ts");
const requireFromTest = createRequire(import.meta.url);
const logger = pino({ level: "info" });

export const P0R2_SESSION_ID = "p0r2-resume-writer-lock-full-slice";
export const P0R2_DELIVERY_ID = "p0r2-correlation-resume-writer-lock";
const P0R2_NODE_ID = "p0r2-real-ingress-node";

type Composition = NonNullable<Awaited<ReturnType<typeof composeRunnerProcessRuntime>>>;

export interface P0R2Observation {
  routeResult: unknown;
  routeError: string | null;
  handoff: {
    oldPidAlive: boolean;
    writerLockPresent: boolean;
    registrationPid: number | null;
  };
  firstExecution: ExecutionObservation;
  successorExecution: ExecutionObservation | null;
  successorActivation: {
    status: string;
    executionGeneration: number;
    manifestId: string | null;
    runtimeEnvIdentity: string | null;
    registrationId: string | null;
    pid: number | null;
    startIdentity: string | null;
    commandId: string | null;
    registrationPid: number | null;
    registrationStartIdentity: string | null;
  } | null;
  interruptCount: number;
  persistedSuccessorReplyCount: number;
  sseSuccessorReplyCount: number;
  delivery: {
    state: string;
    aggregateState: string;
    attemptCount: number;
    acceptedCount: number;
    retryCount: number;
    lastError: string | null;
  };
  session: {
    status: string;
    executionGeneration: number;
    manifestId: string | null;
    registrationId: string | null;
    pid: number | null;
    startIdentity: string | null;
    commandId: string | null;
    terminationEventId: number | null;
  };
  ownership: {
    firstAcquire: OwnershipActivationObservation;
    firstRelease: OwnershipReleaseObservation;
    successorAcquireEventId: number;
    finalRelease: OwnershipReleaseObservation;
    legacyRowCount: number;
    legacyOpenRowCount: number;
  };
  errorEventCount: number;
  task: {
    status: string;
    runnerAttached: boolean;
    executionPromiseAttached: boolean;
    activationAttached: boolean;
    queueLength: number;
  };
  pumpErrors: string[];
}

interface ExecutionObservation {
  pid: number;
  params: Record<string, unknown>;
}

interface OwnershipActivationObservation {
  status: string;
  executionGeneration: number;
  manifestId: string | null;
  runtimeEnvIdentity: string | null;
  registrationId: string | null;
  pid: number | null;
  startIdentity: string | null;
  commandId: string | null;
}

interface OwnershipReleaseObservation {
  status: string;
  executionGeneration: number;
  terminationEventId: number;
  terminationCreatedAt: string;
  executionIdentityCleared: boolean;
}

interface InitialExecutionObservation {
  execution: ExecutionObservation;
  activation: OwnershipActivationObservation;
  release: OwnershipReleaseObservation;
}

interface SliceRuntime {
  task: Task;
  executor: TaskExecutor;
  route: TaskInterventionRoute;
  paths: ReturnType<typeof runnerProcessPaths>;
}

export interface P0R2EntryObservation {
  firstExecution: ExecutionObservation;
  persistedInitialReplyCount: number;
  sessionStatus: string;
  executionGeneration: number;
  executionIdentityCleared: boolean;
  ownershipAcquireCount: number;
  taskStatus: string;
  runnerAttached: boolean;
  executionPromiseAttached: boolean;
  pumpErrors: string[];
}

export class P0R2FullSliceHarness {
  private readonly childPids = new Set<number>();

  private constructor(
    private readonly sql: FullSchemaPostgresHarness["sql"],
    private readonly root: string,
    private readonly controlDirectory: string,
    private readonly stateDirectory: string,
    private readonly releaseDirectory: string,
    private readonly composition: Composition,
    private readonly mux: EventOutboxPumpMux,
    private readonly controller: NodeEventIngressController,
    private readonly historyApp: FastifyInstance,
    private readonly db: SessionDB,
    private readonly persistence: EventPersistence,
    private readonly broadcaster: SessionBroadcaster,
    private readonly deliveryRepository: SessionDeliveryRepository,
    private readonly agent: AgentProfile,
    private readonly pumpErrors: string[],
  ) {}

  static async create(
    postgres: FullSchemaPostgresHarness,
  ): Promise<P0R2FullSliceHarness> {
    const root = await mkdtemp(join(tmpdir(), "p0r2-full-slice-"));
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
      SOULSTREAM_NODE_ID: P0R2_NODE_ID,
      SOULSTREAM_UPSTREAM_URL: "ws://127.0.0.1:1/ws/node",
      EVENT_OUTBOX_DIR: outboxDirectory,
      SOUL_RUNNER_PROCESS_ENABLED: "true",
      SOUL_RUNNER_STATE_DIR: stateDirectory,
      SOUL_RUNNER_ARTIFACT_DIR: artifactDirectory,
      SOUL_RUNNER_RELEASES_DIR: releasesDirectory,
      SOUL_RUNNER_LEASE_TIMEOUT_MS: "90000",
      CLAUDE_SESSION_RUNTIME_V2_ENABLED: "true",
      MCP_ENABLED: "false",
    });
    const agent: AgentProfile = {
      id: "p0r2-agent",
      name: "P0R2 Agent",
      backend: "claude",
      workspace_dir: controlDirectory,
    };
    const agentRegistry = new AgentRegistry([agent]);
    const sql = postgres.createPeer();
    const db = new SessionDB();
    configureTestSessionDataHost(db, sql);
    const deliveryRepository = new SessionDeliveryRepository(sql as never);
    db.configureSessionDeliveryHost(deliveryRepository as never);
    db.configureClaudeTranscriptHost(
      new ClaudeTranscriptRepository(sql as never) as never,
    );
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
    const nodeRegistry = new InMemoryNodeRegistry();
    const registration = nodeRegistry.registerNode({
      type: "node_register",
      node_id: P0R2_NODE_ID,
      user: { email: "p0r2@example.com" },
      sessions: [{
        agentSessionId: P0R2_SESSION_ID,
        session_id: P0R2_SESSION_ID,
        session_type: "claude",
        status: "running",
        execution_generation: 0,
      }],
    });
    const nodeSource = {
      nodeId: P0R2_NODE_ID,
      connectionId: registration.node.connectionId,
    };
    const sessionEventHub = new RuntimeSessionEventHub();
    const publishToSessionSse = createRuntimeSessionEventHubSink(sessionEventHub);
    const publishEvents = (events: NodeRegistryEvent[]): void => {
      publishToSessionSse(events);
    };
    const broadcaster = new SessionBroadcaster(
      async (message) => publishEvents(nodeRegistry.receiveNodeMessage(nodeSource, message)),
      agentRegistry,
      P0R2_NODE_ID,
    );
    const historySql = postgres.createPeer();
    const historyApp = Fastify();
    registerSessionHistoryRoutes(historyApp, {
      provider: createLiveSessionHistoryProvider({
        sqlResolver: createLiveDbSqlResolver({
          sql: historySql as unknown as LivePostgresSql,
        }),
      }),
      liveEvents: {
        subscribe: (sessionId, listener) => {
          if (nodeRegistry.findConnectedNodeForSession(sessionId) === undefined) {
            return undefined;
          }
          return sessionEventHub.subscribe(sessionId, (event) => listener(event.data));
        },
      },
      closeAfterHistorySync: false,
    });
    await historyApp.listen({ host: "127.0.0.1", port: 0 });
    let ackTail = Promise.resolve();
    const controller = new NodeEventIngressController({
      nodeId: P0R2_NODE_ID,
      connectionId: registration.node.connectionId,
      committer: { commitBatch: (nodeId, batch) => ingress.commitBatch(nodeId, batch) },
      isCurrentConnection: () => true,
      receiveCommittedEvent: (message) => nodeRegistry.receiveNodeMessage(nodeSource, message),
      publish: publishEvents,
      send: (frame) => {
        if (mux.isAck(frame)) {
          ackTail = ackTail.then(async () => await mux.handleAck(frame));
          return;
        }
        if (mux.isRejection(frame)) {
          ackTail = ackTail.then(async () => { await mux.handleRejection(frame); });
          return;
        }
        pumpErrors.push(`unexpected ingress frame: ${JSON.stringify(frame)}`);
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
    const sessionStore = new DbClaudeSessionStore(db);
    const composition = await composeRunnerProcessRuntime(true, {
      env,
      logger,
      pumpMux: mux,
      sessionStore,
      mcpConfigService,
      buildChildProcessEnv: () => ({
        ...process.env,
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS,
          `--import ${pathToFileURL(requireFromTest.resolve("tsx")).href}`,
        ].filter(Boolean).join(" "),
        RUNNER_E2E_CONTROL_DIR: controlDirectory,
        RUNNER_E2E_P0R2_SCENARIO: "1",
      }),
      renewExecutionOwnership: async (task, renewedAt) => {
        const ownership = task.executionOwnership;
        if (!ownership) throw new Error("P0R2 ownership unavailable for renewal");
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
    if (!composition) throw new Error("P0R2 runner composition unexpectedly disabled");
    const releases = await readdir(releasesDirectory);
    const release = releases.find((entry) => entry.startsWith("sha256-"));
    if (!release) throw new Error("P0R2 runner release was not materialized");
    const harness = new P0R2FullSliceHarness(
      sql,
      root,
      controlDirectory,
      stateDirectory,
      join(releasesDirectory, release),
      composition,
      mux,
      controller,
      historyApp,
      db,
      persistence,
      broadcaster,
      deliveryRepository,
      agent,
      pumpErrors,
    );
    return harness;
  }

  async run(): Promise<P0R2Observation> {
    const slice = await this.prepareSlice();
    const initial = await this.startInitialExecution(slice);
    const firstExecution = initial.execution;
    const { task, executor, route, paths } = slice;
    const sse = await connectSessionSse(
      this.historyApp.listeningOrigin,
      P0R2_SESSION_ID,
      initial.release.terminationEventId,
    );
    let handoff: P0R2Observation["handoff"] | undefined;
    const successor = { promise: undefined as Promise<void> | undefined };
    let routeResult: unknown = null;
    let routeError: string | null = null;
    let successorExecution: ExecutionObservation | null = null;
    let successorActivation: P0R2Observation["successorActivation"] = null;
    let sseSuccessorReplyCount = 0;
    try {
      const baselineFrames = await sse.readUntil("history_sync");
      if (countSuccessorReplies(baselineFrames) !== 0) {
        throw new Error("P0R2 SSE baseline already contained the successor reply");
      }
      try {
        routeResult = await route.addIntervention({
          agentSessionId: P0R2_SESSION_ID,
          text: "resume after the completed attempt",
          user: "P0R2 User",
          callerInfo: { source: "browser", display_name: "P0R2 User" },
          source: "user_message",
          deliveryId: P0R2_DELIVERY_ID,
          deliveryIntent: "human_live_steer",
          completionId: `message:${P0R2_DELIVERY_ID}`,
          relationKey: `user_message:${P0R2_SESSION_ID}:${P0R2_DELIVERY_ID}`,
          deliveryCreatedAt: new Date().toISOString(),
        }, (resumedTask, activation) => {
          successor.promise = (async () => {
            const handoffIdentity = await readRunnerRegistrationIdentity(
              paths.sessionDirectory,
            );
            handoff = {
              oldPidAlive: isPidAlive(firstExecution.pid),
              writerLockPresent: await pathExists(paths.lockPath),
              registrationPid: handoffIdentity?.pid ?? null,
            };
            await executor.startExecution(resumedTask, this.agent, activation);
          })();
          return successor.promise;
        });
      } catch (error) {
        routeError = error instanceof Error ? error.message : String(error);
      }

      if (routeError === null && successor.promise) {
        successorExecution = await this.readExecutionWithDiagnostics(
          join(this.controlDirectory, "p0r2-successor-execution.json"),
          task,
          paths,
        );
        this.childPids.add(successorExecution.pid);
        const registration = await readRunnerRegistrationIdentity(paths.sessionDirectory);
        const [activeSession] = await this.sql<Array<{
          status: string;
          execution_generation: number;
          execution_manifest_id: string | null;
          execution_runtime_env_identity: string | null;
          execution_registration_id: string | null;
          execution_pid: number | null;
          execution_start_identity: string | null;
          execution_command_id: string | null;
        }>>`
          SELECT status, execution_generation::int, execution_manifest_id,
                 execution_runtime_env_identity, execution_registration_id,
                 execution_pid, execution_start_identity, execution_command_id
          FROM sessions WHERE session_id = ${P0R2_SESSION_ID}
        `;
        if (!activeSession) throw new Error("P0R2 successor activation row missing");
        successorActivation = {
          status: activeSession.status,
          executionGeneration: Number(activeSession.execution_generation),
          manifestId: activeSession.execution_manifest_id,
          runtimeEnvIdentity: activeSession.execution_runtime_env_identity,
          registrationId: activeSession.execution_registration_id,
          pid: activeSession.execution_pid,
          startIdentity: activeSession.execution_start_identity,
          commandId: activeSession.execution_command_id,
          registrationPid: registration?.pid ?? null,
          registrationStartIdentity: registration?.startIdentity ?? null,
        };
        await writeFile(join(this.controlDirectory, "p0r2-release-successor"), "release\n");
      }
      await successor.promise;
      const successorSseFrames = successor.promise
        ? await sse.readUntil("session_ended")
        : [];
      sseSuccessorReplyCount = countSuccessorReplies(successorSseFrames);
    } finally {
      await sse.close();
    }
    if (!handoff) throw new Error("P0R2 successor admission boundary was not reached");

    const [delivery] = await this.sql<Array<{
      state: string;
      aggregate_state: string;
      attempt_count: number;
      last_error: string | null;
      accepted_count: number;
      retry_count: number;
    }>>`
      SELECT delivery.state, delivery.aggregate_state, delivery.attempt_count,
             delivery.last_error,
             COUNT(*) FILTER (WHERE attempt.outcome = 'accepted')::int AS accepted_count,
             COUNT(*) FILTER (WHERE attempt.outcome <> 'accepted')::int AS retry_count
      FROM session_deliveries AS delivery
      LEFT JOIN session_delivery_attempts AS attempt
        ON attempt.delivery_id = delivery.delivery_id
      WHERE delivery.delivery_id = ${P0R2_DELIVERY_ID}
      GROUP BY delivery.delivery_id
    `;
    if (!delivery) throw new Error("P0R2 delivery row missing");
    const [session] = await this.sql<Array<{
      status: string;
      execution_generation: number;
      execution_manifest_id: string | null;
      execution_registration_id: string | null;
      execution_pid: number | null;
      execution_start_identity: string | null;
      execution_command_id: string | null;
      termination_event_id: number | null;
    }>>`
      SELECT status, execution_generation::int, execution_manifest_id,
             execution_registration_id, execution_pid, execution_start_identity,
             execution_command_id, termination_event_id
      FROM sessions WHERE session_id = ${P0R2_SESSION_ID}
    `;
    if (!session) throw new Error("P0R2 session row missing");
    const finalRelease = await this.readReleasedOwnership(2);
    const acquireEvents = await this.sql<Array<{ id: number }>>`
      SELECT id FROM events
      WHERE session_id = ${P0R2_SESSION_ID}
        AND event_type = 'metadata'
        AND payload->>'metadata_type' = 'execution_ownership_transition'
        AND payload->'value'->>'phase' = 'execution_acquire'
      ORDER BY id ASC
    `;
    if (acquireEvents.length !== 2 || !acquireEvents[1]) {
      throw new Error(`P0R2 expected two acquire events, got ${acquireEvents.length}`);
    }
    const [legacy] = await this.sql<Array<{
      row_count: number;
      open_count: number;
    }>>`
      SELECT COUNT(*)::int AS row_count,
             COUNT(*) FILTER (
               WHERE phase IN ('reserved', 'identity_proven', 'active')
             )::int AS open_count
      FROM session_execution_ownerships
      WHERE session_id = ${P0R2_SESSION_ID}
    `;
    const [replyCount] = await this.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM events
      WHERE session_id = ${P0R2_SESSION_ID}
        AND event_type = 'assistant_message'
        AND payload->>'content' = 'successor reply'
    `;
    const [errors] = await this.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM events
      WHERE session_id = ${P0R2_SESSION_ID}
        AND event_type IN ('error', 'assistant_error')
    `;
    const interruptEntries = (await readdir(this.controlDirectory))
      .filter((entry) => entry.startsWith("p0r2-interrupt-"));
    return {
      routeResult,
      routeError,
      handoff,
      firstExecution,
      successorExecution,
      successorActivation,
      interruptCount: interruptEntries.length,
      persistedSuccessorReplyCount: replyCount?.count ?? 0,
      sseSuccessorReplyCount,
      delivery: {
        state: delivery.state,
        aggregateState: delivery.aggregate_state,
        attemptCount: Number(delivery.attempt_count),
        acceptedCount: Number(delivery.accepted_count),
        retryCount: Number(delivery.retry_count),
        lastError: delivery.last_error,
      },
      session: {
        status: session.status,
        executionGeneration: Number(session.execution_generation),
        manifestId: session.execution_manifest_id,
        registrationId: session.execution_registration_id,
        pid: session.execution_pid,
        startIdentity: session.execution_start_identity,
        commandId: session.execution_command_id,
        terminationEventId: session.termination_event_id,
      },
      ownership: {
        firstAcquire: initial.activation,
        firstRelease: initial.release,
        successorAcquireEventId: Number(acquireEvents[1].id),
        finalRelease,
        legacyRowCount: Number(legacy?.row_count ?? -1),
        legacyOpenRowCount: Number(legacy?.open_count ?? -1),
      },
      errorEventCount: Number(errors?.count ?? -1),
      task: {
        status: task.status,
        runnerAttached: task.runner !== undefined,
        executionPromiseAttached: task.executionPromise !== undefined,
        activationAttached: task.executionActivation !== undefined,
        queueLength: task.interventionQueue.length,
      },
      pumpErrors: [...this.pumpErrors],
    };
  }

  async runEntryScaffold(): Promise<P0R2EntryObservation> {
    const slice = await this.prepareSlice();
    const firstExecution = (await this.startInitialExecution(slice)).execution;
    let replyCount = 0;
    let session: {
      status: string;
      execution_generation: number;
      execution_manifest_id: string | null;
      execution_runtime_env_identity: string | null;
      execution_registration_id: string | null;
      execution_pid: number | null;
      execution_start_identity: string | null;
      execution_command_id: string | null;
    } | undefined;
    let acquireCount = 0;
    await waitFor(async () => {
      const [reply] = await this.sql<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count FROM events
        WHERE session_id = ${P0R2_SESSION_ID}
          AND event_type = 'assistant_message'
          AND payload->>'content' = 'initial reply'
      `;
      [session] = await this.sql<Array<{
        status: string;
        execution_generation: number;
        execution_manifest_id: string | null;
        execution_runtime_env_identity: string | null;
        execution_registration_id: string | null;
        execution_pid: number | null;
        execution_start_identity: string | null;
        execution_command_id: string | null;
      }>>`
        SELECT status, execution_generation::int, execution_manifest_id,
               execution_runtime_env_identity, execution_registration_id,
               execution_pid, execution_start_identity, execution_command_id
        FROM sessions WHERE session_id = ${P0R2_SESSION_ID}
      `;
      const [ownership] = await this.sql<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count FROM events
        WHERE session_id = ${P0R2_SESSION_ID}
          AND event_type = 'metadata'
          AND payload->>'metadata_type' = 'execution_ownership_transition'
          AND payload->'value'->>'phase' = 'execution_acquire'
      `;
      replyCount = reply?.count ?? 0;
      acquireCount = ownership?.count ?? 0;
      return replyCount === 1
        && session?.status === "completed"
        && session.execution_generation === 1
        && acquireCount === 1;
    });
    if (!session) throw new Error("P0R2 entry persistence missing");
    const executionIdentityCleared = [
      session.execution_manifest_id,
      session.execution_runtime_env_identity,
      session.execution_registration_id,
      session.execution_pid,
      session.execution_start_identity,
      session.execution_command_id,
    ].every((value) => value === null);
    return {
      firstExecution,
      persistedInitialReplyCount: replyCount,
      sessionStatus: session.status,
      executionGeneration: Number(session.execution_generation),
      executionIdentityCleared,
      ownershipAcquireCount: acquireCount,
      taskStatus: slice.task.status,
      runnerAttached: slice.task.runner !== undefined,
      executionPromiseAttached: slice.task.executionPromise !== undefined,
      pumpErrors: [...this.pumpErrors],
    };
  }

  private async prepareSlice(): Promise<SliceRuntime> {
    const now = new Date();
    await new SessionMutationRepository(this.sql as never).registerSession({
      idempotencyKey: `register:${P0R2_SESSION_ID}`,
      sessionId: P0R2_SESSION_ID,
      nodeId: P0R2_NODE_ID,
      agentId: this.agent.id,
      claudeSessionId: null,
      sessionType: "claude",
      prompt: "initial turn",
      clientId: null,
      status: "running",
      createdAt: now,
      updatedAt: now,
      callerSessionId: null,
      predecessorSessionId: null,
      notifyCompletion: false,
      reviewRequired: false,
      reviewState: "not_required",
    });
    const task: Task = {
      agentSessionId: P0R2_SESSION_ID,
      prompt: "initial turn",
      status: "running",
      profileId: this.agent.id,
      agentProfileSnapshot: this.agent,
      sessionType: "claude",
      reviewState: "not_required",
      callerInfo: { source: "browser", display_name: "P0R2 User" },
      createdAt: new Date(),
      lastEventId: 0,
      lastReadEventId: 0,
      interventionQueue: [],
      useMcp: false,
    };
    const ledger = new TaskDeliveryLedgerGate(true, this.deliveryRepository as never);
    const executor = new TaskExecutor(
      () => { throw new Error("P0R2 must use the detached process runner"); },
      this.db,
      this.persistence,
      this.broadcaster,
      logger,
      undefined,
      undefined,
      undefined,
      undefined,
      ledger,
      undefined,
      this.composition.runtimeFactory,
    );
    const running = new RunningInterventionTransition({
      broadcaster: this.broadcaster,
      logger,
      persistence: this.persistence,
    });
    const autoResume = new AutoResumeTransition({
      logger,
      persistence: this.persistence,
      agentRegistry: new AgentRegistry([this.agent]),
    });
    const route = new TaskInterventionRoute({
      getTask: (sessionId) => sessionId === P0R2_SESSION_ID ? task : undefined,
      loadEvictedTask: async () => null,
      rememberTask: () => undefined,
      runningInterventionTransition: running,
      autoResumeTransition: autoResume,
      deliveryLedgerGate: ledger,
    });
    return {
      task,
      executor,
      route,
      paths: runnerProcessPaths(this.stateDirectory, P0R2_SESSION_ID),
    };
  }

  private async startInitialExecution(
    slice: SliceRuntime,
  ): Promise<InitialExecutionObservation> {
    const { task, executor, paths } = slice;
    const initialExecution = executor.startExecution(task, this.agent);
    await waitFor(async () => await pathExists(paths.pidPath));
    await this.rememberRegisteredChild(paths);
    const firstExecution = await this.readExecutionWithDiagnostics(
      join(this.controlDirectory, "p0r2-first-execution.json"),
      task,
      paths,
    );
    this.childPids.add(firstExecution.pid);
    let activation: OwnershipActivationObservation | undefined;
    await waitFor(async () => {
      const [row] = await this.sql<Array<{
        status: string;
        execution_generation: number;
        execution_manifest_id: string | null;
        execution_runtime_env_identity: string | null;
        execution_registration_id: string | null;
        execution_pid: number | null;
        execution_start_identity: string | null;
        execution_command_id: string | null;
      }>>`
        SELECT status, execution_generation::int, execution_manifest_id,
               execution_runtime_env_identity, execution_registration_id,
               execution_pid, execution_start_identity, execution_command_id
        FROM sessions WHERE session_id = ${P0R2_SESSION_ID}
      `;
      activation = row ? {
        status: row.status,
        executionGeneration: Number(row.execution_generation),
        manifestId: row.execution_manifest_id,
        runtimeEnvIdentity: row.execution_runtime_env_identity,
        registrationId: row.execution_registration_id,
        pid: row.execution_pid,
        startIdentity: row.execution_start_identity,
        commandId: row.execution_command_id,
      } : undefined;
      return activation?.status === "running"
        && activation.executionGeneration === 1
        && activation.manifestId !== null
        && activation.runtimeEnvIdentity !== null
        && activation.registrationId !== null
        && activation.pid === firstExecution.pid
        && activation.startIdentity !== null
        && activation.commandId !== null;
    });
    if (!activation) throw new Error("P0R2 first ownership acquisition was not observed");
    await writeFile(join(this.controlDirectory, "p0r2-continue-first"), "continue\n");
    await initialExecution;
    return {
      execution: firstExecution,
      activation,
      release: await this.readReleasedOwnership(1),
    };
  }

  private async readReleasedOwnership(
    expectedGeneration: number,
  ): Promise<OwnershipReleaseObservation> {
    let released: OwnershipReleaseObservation | undefined;
    await waitFor(async () => {
      const [row] = await this.sql<Array<{
        status: string;
        execution_generation: number;
        execution_manifest_id: string | null;
        execution_runtime_env_identity: string | null;
        execution_registration_id: string | null;
        execution_pid: number | null;
        execution_start_identity: string | null;
        execution_command_id: string | null;
        execution_lease_expires_at: Date | string | null;
        termination_event_id: number | null;
        termination_created_at: Date | string | null;
      }>>`
        SELECT session.status, session.execution_generation::int,
               session.execution_manifest_id, session.execution_runtime_env_identity,
               session.execution_registration_id, session.execution_pid,
               session.execution_start_identity, session.execution_command_id,
               session.execution_lease_expires_at, session.termination_event_id,
               terminal.created_at AS termination_created_at
        FROM sessions AS session
        LEFT JOIN events AS terminal ON terminal.id = session.termination_event_id
        WHERE session.session_id = ${P0R2_SESSION_ID}
      `;
      if (!row || row.execution_generation !== expectedGeneration
        || row.termination_event_id === null || row.termination_created_at === null) {
        return false;
      }
      const executionIdentityCleared = [
        row.execution_manifest_id,
        row.execution_runtime_env_identity,
        row.execution_registration_id,
        row.execution_pid,
        row.execution_start_identity,
        row.execution_command_id,
        row.execution_lease_expires_at,
      ].every((value) => value === null);
      if (!executionIdentityCleared) return false;
      released = {
        status: row.status,
        executionGeneration: Number(row.execution_generation),
        terminationEventId: Number(row.termination_event_id),
        terminationCreatedAt: new Date(row.termination_created_at).toISOString(),
        executionIdentityCleared,
      };
      return true;
    });
    if (!released) {
      throw new Error(`P0R2 generation ${expectedGeneration} release was not observed`);
    }
    return released;
  }

  private async rememberRegisteredChild(
    paths: ReturnType<typeof runnerProcessPaths>,
  ): Promise<void> {
    const identity = await readRunnerRegistrationIdentity(paths.sessionDirectory);
    if (identity?.pid !== null && identity?.pid !== undefined) {
      this.childPids.add(identity.pid);
    }
  }

  private async readExecutionWithDiagnostics(
    path: string,
    task: Task,
    paths: ReturnType<typeof runnerProcessPaths>,
  ): Promise<ExecutionObservation> {
    try {
      return await readExecution(path);
    } catch (error) {
      const identity = await readRunnerRegistrationIdentity(paths.sessionDirectory)
        .catch(() => null);
      const controlEntries = await readdir(this.controlDirectory).catch(() => []);
      throw new Error(
        `P0R2 entry observation failed: ${error instanceof Error ? error.message : String(error)}`
        + `; task=${JSON.stringify({ status: task.status, error: task.error ?? null })}`
        + `; registration=${JSON.stringify(identity)}`
        + `; control=${JSON.stringify(controlEntries.sort())}`
        + `; pumpErrors=${JSON.stringify(this.pumpErrors)}`,
        { cause: error },
      );
    }
  }

  async cleanup(): Promise<void> {
    this.controller.stop();
    this.mux.disconnect();
    await this.historyApp.close();
    const paths = runnerProcessPaths(this.stateDirectory, P0R2_SESSION_ID);
    await this.rememberRegisteredChild(paths).catch(() => undefined);
    for (const pid of this.childPids) killIfAlive(pid);
    await waitFor(async () => [...this.childPids].every((pid) => !isPidAlive(pid)), 2_000)
      .catch(() => undefined);
    await this.composition.hostOwnership.release();
    await chmod(this.releaseDirectory, 0o755).catch(() => undefined);
    await rm(this.root, { recursive: true, force: true });
  }
}

async function readExecution(path: string): Promise<ExecutionObservation> {
  await waitFor(async () => await pathExists(path));
  const parsed = JSON.parse(await readFile(path, "utf8")) as {
    pid?: unknown;
    params?: unknown;
  };
  if (!Number.isSafeInteger(parsed.pid) || !isRecord(parsed.params)) {
    throw new Error(`P0R2 execution observation invalid: ${path}`);
  }
  return { pid: parsed.pid as number, params: parsed.params };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`P0R2 condition not reached within ${timeoutMs}ms`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killIfAlive(pid: number): void {
  if (!isPidAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

interface SessionSseFrame {
  event: string;
  data: unknown;
  id?: string;
}

interface SessionSseReader {
  readUntil(eventType: string): Promise<SessionSseFrame[]>;
  close(): Promise<void>;
}

async function connectSessionSse(
  origin: string,
  sessionId: string,
  lastEventId: number,
): Promise<SessionSseReader> {
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/sessions/${sessionId}/events`, {
    headers: { "last-event-id": String(lastEventId) },
    signal: controller.signal,
  });
  if (response.status !== 200) {
    throw new Error(`P0R2 SSE connection failed with status ${response.status}`);
  }
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error("P0R2 session history route did not return an SSE stream");
  }
  const stream = response.body?.getReader();
  if (!stream) throw new Error("P0R2 SSE response body is missing");
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async readUntil(eventType) {
      const frames: SessionSseFrame[] = [];
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) {
          const chunk = await stream.read();
          if (chunk.done) {
            throw new Error(`P0R2 SSE ended before ${eventType}`);
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          continue;
        }
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame = parseSessionSseFrame(raw);
        if (!frame) continue;
        frames.push(frame);
        if (frame.event === eventType) return frames;
      }
    },
    async close() {
      controller.abort();
      await stream.cancel().catch(() => undefined);
    },
  };
}

function parseSessionSseFrame(raw: string): SessionSseFrame | null {
  const values = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    values.set(line.slice(0, separator), line.slice(separator + 1).trimStart());
  }
  const event = values.get("event");
  const data = values.get("data");
  if (!event || data === undefined) return null;
  const id = values.get("id");
  return {
    event,
    data: JSON.parse(data) as unknown,
    ...(id === undefined ? {} : { id }),
  };
}

function countSuccessorReplies(frames: readonly SessionSseFrame[]): number {
  return frames.filter((frame) =>
    frame.event === "assistant_message"
    && isRecord(frame.data)
    && frame.data.content === "successor reply"
  ).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

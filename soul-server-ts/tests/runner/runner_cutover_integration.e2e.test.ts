import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentRegistry, type AgentProfile } from "../../src/agent_registry.js";
import type { CatalogService } from "../../src/catalog/catalog_service.js";
import { parseEnv } from "../../src/config.js";
import type { EventPersistence } from "../../src/db/event_persistence.js";
import type { SessionDB } from "../../src/db/session_db.js";
import {
  attachClaudeBackgroundDeliveryMetadata,
  readClaudeBackgroundDeliveryMetadata,
} from
  "../../src/engine/claude_background_delivery_metadata.js";
import type { EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import type { ClaudeClientEvent } from "../../src/engine/claude_event_mapper.js";
import { McpConfigService } from "../../src/mcp_config_service.js";
import { getCurrentMcpCallerSessionId } from "../../src/mcp/request_context.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { RunnerProcessDispatcher } from "../../src/runner/runner_process_dispatcher.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import { parseRunnerChildConfig } from "../../src/runner/runner_process_spawn.js";
import { readRunnerRegistrationSummary } from
  "../../src/runner/runner_process_registry.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import { composeRunnerProcessRuntime } from "../../src/runtime/runner_process_composition.js";
import { buildServer } from "../../src/server.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import {
  CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
  ClaudeRuntimeTaskFollowupController,
} from
  "../../src/task/claude_runtime_task_followup.js";
import { AutoResumeTransition } from
  "../../src/task/task_auto_resume_transition.js";
import { TaskEngineEventPublisher } from
  "../../src/task/task_engine_event_publisher.js";
import { createDetachedClaudeEventBridge } from
  "../../src/runtime/detached_claude_event_bridge.js";
import { RunningInterventionTransition } from
  "../../src/task/task_running_intervention_transition.js";
import type { TaskManager } from "../../src/task/task_manager.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import type { EventOutboxBatch } from "../../src/upstream/event_outbox.js";
import {
  EventOutboxPump,
  type EventOutboxPumpStore,
} from "../../src/upstream/event_outbox_pump.js";
import { EventOutboxPumpMux } from "../../src/upstream/event_outbox_pump_mux.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import { makeEventPersistenceTestDouble } from "../task/event_persistence_test_double.js";
import { RunnerCutoverOwnershipLedger } from "./runner_cutover_ownership_ledger.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(testDirectory, "../..");
const childFixturePath = join(testDirectory, "fixtures/runner_process_e2e_child.ts");
const requireFromTest = createRequire(import.meta.url);
const temporaryRoots: string[] = [];
const readOnlyReleases: string[] = [];
const childPids = new Set<number>();
const mcpServers: Array<Awaited<ReturnType<typeof buildServer>>> = [];

afterEach(async () => {
  for (const pid of childPids) killIfAlive(pid);
  childPids.clear();
  for (const server of mcpServers.splice(0)) {
    if (server.closeMcp) await server.closeMcp();
    if (server.internalMcpServer) await server.internalMcpServer.close();
    await server.close();
  }
  for (const release of readOnlyReleases.splice(0)) {
    await chmod(release, 0o755).catch(() => undefined);
  }
  await Promise.all(temporaryRoots.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("runner cutover all-flags-on integration", () => {
  it("retains the real Claude runner through delayed background terminals and reclaims it after follow-up", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-background-lifecycle-"));
    temporaryRoots.push(root);
    const stateDirectory = join(root, "state");
    const artifactDirectory = join(root, "artifacts");
    const releasesDirectory = join(root, "runner-releases");
    const controlDirectory = join(root, "control");
    await mkdir(artifactDirectory, { recursive: true });
    await mkdir(controlDirectory, { recursive: true });
    await writeFile(join(artifactDirectory, "package.json"), '{"type":"module"}\n');
    await writeFile(
      join(artifactDirectory, "runner_entry.js"),
      `await import(${JSON.stringify(pathToFileURL(childFixturePath).href)});\n`,
    );
    const agentsConfigPath = join(root, "agents.yaml");
    const registryPath = join(root, "mcp-registry.yaml");
    const profilesPath = join(root, "mcp-profiles.yaml");
    await writeFile(agentsConfigPath, "agents: []\n");
    await writeFile(registryPath, "servers: []\n");
    await writeFile(
      profilesPath,
      "profiles:\n  - id: cutover-internal\n    mcp_servers: []\n",
    );
    const mcpConfigService = new McpConfigService({
      agentsConfigPath,
      registryPath,
      profilesPath,
    });
    const env = parseEnv({
      SOULSTREAM_NODE_ID: "background-lifecycle-test-node",
      SOULSTREAM_UPSTREAM_URL: "ws://127.0.0.1:1/ws/node",
      EVENT_OUTBOX_DIR: join(root, "legacy-outbox"),
      SOUL_RUNNER_PROCESS_ENABLED: "true",
      SOUL_RUNNER_STATE_DIR: stateDirectory,
      SOUL_RUNNER_ARTIFACT_DIR: artifactDirectory,
      SOUL_RUNNER_RELEASES_DIR: releasesDirectory,
      SOUL_RUNNER_LEASE_TIMEOUT_MS: "90000",
      MCP_ENABLED: "false",
    });
    const task = makeTask("session-background-lifecycle");
    const agent = makeAgent(controlDirectory);
    const logger = pino({ level: "silent" });
    const { mux } = mockOrchIngress();
    const persistenceDouble = makeEventPersistenceTestDouble(async (_sessionId, event, liveTask) => {
      if (event.type === "assistant_message" && typeof event.content === "string") {
        liveTask.lastAssistantText = event.content;
      }
    });
    const broadcaster = {
      emitEventEnvelope: vi.fn(async () => undefined),
      emitSessionUpdated: vi.fn(async () => undefined),
    } as unknown as SessionBroadcaster;
    const autoResume = new AutoResumeTransition({
      logger,
      persistence: persistenceDouble.persistence,
    });
    const lifecycleDeliveryIds = new Map<string, string>();
    const publishedDeliveryIds = new Map<string, string>();
    const collectedDeliveryIds = new Map<string, string>();
    const deliveredInterventions: InterventionMessage[] = [];
    const acceptedDeliveries = makeAcceptedDeliveryRecorder();
    let executor!: TaskExecutor;
    const followup = new ClaudeRuntimeTaskFollowupController({
      taskManager: {
        addIntervention: vi.fn(async (message, onResume) => {
          const canonical = {
            ...message,
            deliveryLeaseOwner: message.deliveryLeaseOwner ?? "cutover-followup-claim",
          };
          deliveredInterventions.push(canonical);
          acceptedDeliveries.accept(task.agentSessionId, canonical);
          if (task.status === "initializing") {
            // Match TaskInterventionRoute: a second detached completion waits
            // for the first V1 owner admission before choosing queue vs resume.
            const activation = task.executionActivation?.promise;
            if (!activation) throw new Error("initializing follow-up lost its activation barrier");
            await activation;
          }
          if (task.status === "running") {
            return { delivered: true };
          }
          await autoResume.resume(task, canonical, onResume, { publishUserMessage: false });
          return { autoResumed: true };
        }),
        reserveInterventionRetry: vi.fn(async () => undefined),
      },
      onResume: (resumedTask, activation) =>
        executor.startExecution(resumedTask, agent, activation),
      releaseRetainedRunner: async (retainedTask) =>
        await executor.releaseRetainedClaudeRunner(retainedTask),
      logger,
      deliveryV2Enabled: true,
    });
    const detachedPublisher = new TaskEngineEventPublisher({
      broadcaster,
      logger,
      persistence: persistenceDouble.persistence,
    });
    const observedAndPublished: string[] = [];
    const publishDetached = createDetachedClaudeEventBridge({
      logger,
      findTask: (sessionId) => sessionId === task.agentSessionId ? task : undefined,
      getPublisher: () => detachedPublisher,
      collectDetached: async (liveTask, payload) => {
        const taskId = String((payload as Record<string, unknown>).task_id);
        observedAndPublished.push(`publish:${taskId}`);
        const delivery = readClaudeBackgroundDeliveryMetadata(payload);
        if (delivery) collectedDeliveryIds.set(taskId, delivery.deliveryId);
        await followup.collectDetached(liveTask, payload);
      },
    });
    const composition = await composeRunnerProcessRuntime(true, {
      env,
      logger,
      pumpMux: mux,
      sessionStore: {
        appendIdempotent: vi.fn(async () => undefined),
        deleteIdempotent: vi.fn(async () => undefined),
      } as never,
      mcpConfigService,
      observeClaudeRuntime: async (_sessionId, event: ClaudeClientEvent) => {
        const taskId = "taskId" in event ? event.taskId : event.type;
        observedAndPublished.push(`observe:${taskId}`);
        const deliveryId = `lifecycle-delivery:${taskId}`;
        lifecycleDeliveryIds.set(taskId, deliveryId);
        attachClaudeBackgroundDeliveryMetadata(event, {
          deliveryId,
          completionId: `completion:${taskId}`,
          relationKey: `claude_runtime:${task.agentSessionId}:${taskId}`,
          producerTerminalRevision: `terminal:${taskId}`,
          deliveryCreatedAt: new Date(0).toISOString(),
          source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
          storedPayload: {
            text: `background task ${taskId} completed`,
            user: "system",
            attachment_paths: null,
            context: null,
            caller_info: null,
            followup_key: `${task.agentSessionId}:${taskId}`,
            followup_attempt: 1,
            followup_task_ids: [taskId],
          },
          storedPayloadHash: `payload-hash:${taskId}`,
        });
        return true;
      },
      publishDetachedClaudeEvent: async (sessionId, event, idempotencyKey) => {
        const taskId = "taskId" in event ? event.taskId : event.type;
        const delivery = readClaudeBackgroundDeliveryMetadata(event);
        if (delivery) publishedDeliveryIds.set(taskId, delivery.deliveryId);
        return await publishDetached(sessionId, event, idempotencyKey);
      },
      buildChildProcessEnv: () => ({
        ...process.env,
        NODE_OPTIONS: `--import ${pathToFileURL(requireFromTest.resolve("tsx")).href}`,
        RUNNER_E2E_CONTROL_DIR: controlDirectory,
        RUNNER_E2E_BACKGROUND_SCENARIO: "multi-terminal",
      }),
    });
    if (!composition) throw new Error("runner background composition unexpectedly disabled");
    const releaseEntries = await import("node:fs/promises")
      .then(({ readdir }) => readdir(releasesDirectory));
    const releaseId = releaseEntries.find((entry) => entry.startsWith("sha256-"));
    if (!releaseId) throw new Error("runner background release was not prewarmed");
    readOnlyReleases.push(join(releasesDirectory, releaseId));
    const db = {
      updateSession: vi.fn(async () => undefined),
      setClaudeSessionId: vi.fn(async () => undefined),
    } as unknown as SessionDB;
    const createExecutor = () => new TaskExecutor(
      () => { throw new Error("in-process engine must not be selected"); },
      db,
      persistenceDouble.persistence,
      broadcaster,
      logger,
      undefined,
      undefined,
      undefined,
      followup,
      acceptedDeliveries,
      undefined,
      composition.runtimeFactory,
    );
    executor = createExecutor();

    executor.startExecution(task, agent);
    const paths = runnerProcessPaths(stateDirectory, task.agentSessionId);
    await waitFor(async () => await pathExists(paths.pidPath));
    const pid = Number.parseInt((await readFile(paths.pidPath, "utf8")).trim(), 10);
    childPids.add(pid);
    await task.executionPromise;

    expect(task.status).toBe("completed");
    expect(task.runnerRetainedForClaudeBackground).toBe(true);
    expect(isPidAlive(pid)).toBe(true);

    await task.runner!.dispatcher.detachHost();
    task.runner = undefined;
    task.runnerRetainedForClaudeBackground = undefined;
    task.executionPromise = undefined;
    const registration = await readRunnerRegistrationSummary(paths.sessionDirectory);
    const lifecycle = registration.lifecycle;
    if (!lifecycle) throw new Error("completed runner lifecycle is unavailable");
    executor = createExecutor();
    await executor.recoverRegisteredRunner(
      task,
      registration,
      lifecycle.execution_command_id,
      "replay",
    );

    expect(task.status).toBe("completed");
    expect(task.runnerRetainedForClaudeBackground).toBe(true);
    expect(isPidAlive(pid)).toBe(true);

    await writeFile(join(controlDirectory, "release-background-1"), "go\n");
    await waitFor(async () =>
      await pathExists(join(controlDirectory, "published-background-1"))
      || await pathExists(join(controlDirectory, "child-error"))
    );
    if (await pathExists(join(controlDirectory, "child-error"))) {
      throw new Error(await readFile(join(controlDirectory, "child-error"), "utf8"));
    }
    expect(isPidAlive(pid)).toBe(true);
    expect(await pathExists(join(controlDirectory, "followup-executed"))).toBe(false);

    await writeFile(join(controlDirectory, "release-background-2"), "go\n");
    await waitFor(async () =>
      await pathExists(join(controlDirectory, "published-background-2"))
      || await pathExists(join(controlDirectory, "child-error"))
    );
    if (await pathExists(join(controlDirectory, "child-error"))) {
      throw new Error(await readFile(join(controlDirectory, "child-error"), "utf8"));
    }
    expect(observedAndPublished).toEqual([
      "observe:background-1",
      "publish:background-1",
      "observe:background-2",
      "publish:background-2",
    ]);
    let observedFollowupPid: number | undefined;
    await waitFor(async () => {
      const path = join(controlDirectory, "followup-executed");
      if (!(await pathExists(path))) return false;
      const candidate = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
      if (candidate !== pid) return false;
      observedFollowupPid = candidate;
      return true;
    });
    expect(observedFollowupPid).toBe(pid);
    const followupExecution = task.executionPromise;
    if (followupExecution) await followupExecution;
    await waitFor(async () =>
      await pathExists(join(controlDirectory, "followup-execution-count"))
      && task.status === "completed"
    );
    expect(
      (await readFile(join(controlDirectory, "followup-execution-count"), "utf8")).trim(),
    ).toBe("2");
    expect(deliveredInterventions.map((message) => ({
      deliveryId: message.deliveryId,
      taskIds: message.followupTaskIds,
    }))).toEqual([
      {
        deliveryId: lifecycleDeliveryIds.get("background-1"),
        taskIds: ["background-1"],
      },
      {
        deliveryId: lifecycleDeliveryIds.get("background-2"),
        taskIds: ["background-2"],
      },
    ]);

    for (const taskId of ["background-1", "background-2"]) {
      const lifecycleDeliveryId = lifecycleDeliveryIds.get(taskId);
      if (!lifecycleDeliveryId) throw new Error(`missing lifecycle delivery for ${taskId}`);
      expect(
        publishedDeliveryIds.get(taskId),
        `${taskId} detached publish lost its host-owned delivery identity`,
      ).toBe(lifecycleDeliveryId);
      expect(
        collectedDeliveryIds.get(taskId),
        `${taskId} mapped detached payload lost its host-owned delivery identity`,
      ).toBe(lifecycleDeliveryId);
      const semanticDeliveryIds = new Set([
        lifecycleDeliveryId,
        ...deliveredInterventions.flatMap((message) =>
          message.followupTaskIds?.includes(taskId) && message.deliveryId
            ? [message.deliveryId]
            : []
        ),
      ]);
      expect(
        semanticDeliveryIds,
        `${taskId} terminal crossed the runner boundary with multiple delivery identities`,
      ).toEqual(new Set([lifecycleDeliveryId]));
    }
    expect(task.lastAssistantText).toBe("background follow-up 2 complete");
    expect(task.runner).toBeUndefined();
    expect(task.runnerRetainedForClaudeBackground).toBeUndefined();
    await waitFor(async () => !isPidAlive(pid));
    childPids.delete(pid);
    await composition.hostOwnership.release();
  }, 45_000);

  it("creates a snapshot-backed session, pumps SQLite events, survives host restart, replays, and completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-cutover-smoke-"));
    temporaryRoots.push(root);
    const stateDirectory = join(root, "state");
    const artifactDirectory = join(root, "artifacts");
    const releasesDirectory = join(root, "runner-releases");
    const controlDirectory = join(root, "control");
    await mkdir(artifactDirectory, { recursive: true });
    await mkdir(controlDirectory, { recursive: true });
    await writeFile(join(artifactDirectory, "package.json"), '{"type":"module"}\n');
    await writeFile(
      join(artifactDirectory, "runner_entry.js"),
      `try {\n  await import(${JSON.stringify(pathToFileURL(childFixturePath).href)});\n}`
        + ` catch (error) {\n  const { writeFile } = await import("node:fs/promises");\n`
        + `  await writeFile(process.env.RUNNER_E2E_CONTROL_DIR + "/child-error", String(error?.stack ?? error));\n`
        + `  throw error;\n}\n`,
    );

    const {
      baseUrl: mcpBaseUrl,
      internalUrl: mcpInternalUrl,
      callerSessionIds,
    } = await startInternalMcpServer();
    const agentsConfigPath = join(root, "agents.yaml");
    const registryPath = join(root, "mcp-registry.yaml");
    const profilesPath = join(root, "mcp-profiles.yaml");
    await writeFile(agentsConfigPath, "agents: []\n");
    await writeFile(
      registryPath,
      `servers:\n  - id: soulstream\n    type: streamable_http\n    url: ${mcpBaseUrl}/mcp\n`,
    );
    await writeFile(
      profilesPath,
      "profiles:\n  - id: cutover-internal\n    mcp_servers:\n      - soulstream\n",
    );
    const mcpConfigService = new McpConfigService({
      agentsConfigPath,
      registryPath,
      profilesPath,
    });

    const env = parseEnv({
      SOULSTREAM_NODE_ID: "cutover-test-node",
      SOULSTREAM_UPSTREAM_URL: "ws://127.0.0.1:1/ws/node",
      EVENT_OUTBOX_DIR: join(root, "legacy-outbox"),
      SOUL_RUNNER_PROCESS_ENABLED: "true",
      SOUL_RUNNER_STATE_DIR: stateDirectory,
      SOUL_RUNNER_ARTIFACT_DIR: artifactDirectory,
      SOUL_RUNNER_RELEASES_DIR: releasesDirectory,
      SOUL_RUNNER_LEASE_TIMEOUT_MS: "90000",
      MCP_ENABLED: "true",
      MCP_INTERNAL_PORT: new URL(mcpInternalUrl).port,
      MCP_STATELESS_TRANSPORT_ENABLED: "true",
    });
    expect(env).toMatchObject({
      SOUL_RUNNER_PROCESS_ENABLED: true,
      MCP_ENABLED: true,
      MCP_STATELESS_TRANSPORT_ENABLED: true,
    });

    const { mux, batches } = mockOrchIngress();
    const composition = await composeRunnerProcessRuntime(true, {
      env,
      logger: pino({ level: "silent" }),
      pumpMux: mux,
      sessionStore: {
        appendIdempotent: vi.fn(async () => undefined),
        deleteIdempotent: vi.fn(async () => undefined),
      } as never,
      mcpConfigService,
      buildChildProcessEnv: () => ({
        ...process.env,
        NODE_OPTIONS: `--import ${pathToFileURL(requireFromTest.resolve("tsx")).href}`,
        RUNNER_E2E_CONTROL_DIR: controlDirectory,
        RUNNER_E2E_REQUIRE_INTERNAL_MCP: "1",
      }),
    });
    if (!composition) throw new Error("runner composition unexpectedly disabled");
    const releaseEntries = await import("node:fs/promises")
      .then(({ readdir }) => readdir(releasesDirectory));
    const releaseId = releaseEntries.find((entry) => entry.startsWith("sha256-"));
    if (!releaseId) throw new Error("runner release was not prewarmed");
    const releaseRoot = join(releasesDirectory, releaseId);
    readOnlyReleases.push(releaseRoot);

    const ownershipLedger = new RunnerCutoverOwnershipLedger();
    const task = makeTask();
    const agent = makeAgent(controlDirectory);
    const firstHost = taskExecutor(
      composition.runtimeFactory,
      undefined,
      undefined,
      ownershipLedger,
    );
    firstHost.executor.startExecution(task, agent);
    const paths = runnerProcessPaths(stateDirectory, task.agentSessionId);
    await waitFor(async () => await pathExists(paths.pidPath));
    const pid = Number.parseInt((await readFile(paths.pidPath, "utf8")).trim(), 10);
    childPids.add(pid);
    const childErrorPath = join(controlDirectory, "child-error");
    await waitFor(async () =>
      await pathExists(join(controlDirectory, "execute-started"))
      || await pathExists(childErrorPath)
      || task.status === "error");
    if (await pathExists(childErrorPath)) {
      throw new Error(await readFile(childErrorPath, "utf8"));
    }
    if (task.status === "error") {
      throw new Error(`runner cutover execution failed before child start: ${task.error ?? "unknown"}`);
    }
    expect(JSON.parse(await readFile(join(controlDirectory, "internal-mcp-called"), "utf8")))
      .toMatchObject({ path: "/mcp/internal", isError: false });
    expect(callerSessionIds).toEqual([task.agentSessionId]);

    await expect(composition.releaseGarbageCollector.collect()).resolves.toEqual({
      removed: [],
      retained: [{ releaseId, reason: "live_runner" }],
    });
    expect(await pathExists(releaseRoot)).toBe(true);

    await writeFile(join(controlDirectory, "emit-first"), "go\n");
    await waitFor(async () => durableContents(batches).includes("before-detach")
      && await pendingFrameCount(paths.databasePath) === 0);
    expect(batches.flatMap((batch) => batch.events).find(
      (event) => (event.payload as { content?: string }).content === "before-detach",
    )).toMatchObject({
      stream_id: expect.any(String),
      source_seq: 3,
      payload: { content: "before-detach" },
    });
    expect((await readRunnerBootstrap(paths.databasePath)).payload).toMatchObject({
      code_sha: releaseId,
      snapshot_path: releaseRoot,
      cwd: controlDirectory,
    });

    const oldExecution = task.executionPromise;
    const executionOwnership = task.executionOwnership;
    if (!executionOwnership) throw new Error("execution ownership missing before host restart");
    await (task.runner!.dispatcher as RunnerProcessDispatcher).detachHost();
    task.runner = undefined;
    task.executionPromise = undefined;
    await writeFile(join(controlDirectory, "emit-after-detach"), "go\n");
    // Force the detached append to commit before adoption. Its doorbell has no
    // host connection and is therefore intentionally lost; recovery must kick
    // the durable backlog instead of relying on a future child notification.
    await waitFor(async () => await hasDurableContent(paths.databasePath, "after-detach"));
    expect(isPidAlive(pid)).toBe(true);

    const registration = await readRunnerRegistrationSummary(paths.sessionDirectory);
    const recoveredDeliveries = makeAcceptedDeliveryRecorder();
    const restartedHost = taskExecutor(
      composition.runtimeFactory,
      undefined,
      executionOwnership,
      ownershipLedger,
      recoveredDeliveries,
    );
    const recovery = restartedHost.executor.recoverRegisteredRunner(
      task,
      registration,
      undefined,
      "adopt",
    );
    let recoveryFailure: Error | undefined;
    void recovery.catch((error: unknown) => {
      recoveryFailure = error instanceof Error ? error : new Error(String(error));
    });
    await waitFor(async () =>
      recoveryFailure !== undefined || durableContents(batches).includes("after-detach"));
    if (recoveryFailure) throw recoveryFailure;
    const transition = new RunningInterventionTransition({
      broadcaster: {
        emitEventEnvelope: vi.fn(async () => undefined),
      } as unknown as SessionBroadcaster,
      logger: pino({ level: "silent" }),
      persistence: restartedHost.persistence,
    });
    const recoveredDelivery: InterventionMessage = {
      text: "post-recovery intervention",
      user: "soak",
      deliveryId: "cutover-live-intervention",
      deliveryLeaseOwner: "cutover-live-claim",
      deliveryIntent: "human_live_steer",
    };
    recoveredDeliveries.accept(task.agentSessionId, recoveredDelivery);
    await expect(transition.deliver(task, recoveredDelivery))
      .resolves.toMatchObject({ delivered: true });
    await writeFile(join(controlDirectory, "finish"), "go\n");
    await recovery;

    expect(restartedHost.acquireExecutionOwnershipAndWaitForApplication).toHaveBeenCalledTimes(2);
    expect(restartedHost.acquireExecutionOwnershipAndWaitForApplication).toHaveBeenNthCalledWith(
      1,
      task.agentSessionId,
      expect.objectContaining({
        ownerKind: "adopted_runner",
        reviewState: "not_required",
        executionCommandId: executionOwnership.executionCommandId,
      }),
    );
    expect(restartedHost.acquireExecutionOwnershipAndWaitForApplication).toHaveBeenNthCalledWith(
      2,
      task.agentSessionId,
      expect.objectContaining({
        ownerKind: "adopted_runner",
        deliveryId: recoveredDelivery.deliveryId,
        deliveryLeaseOwner: recoveredDelivery.deliveryLeaseOwner,
        previousExecutionGeneration: 1,
        previousExecutionCommandId: executionOwnership.executionCommandId,
        executionCommandId: `delivery:${recoveredDelivery.deliveryId}`,
      }),
    );
    expect(task.status).toBe("completed");
    expect(task.lastAssistantText).toBe("after-detach");
    await waitFor(async () => !isPidAlive(pid));
    childPids.delete(pid);
    expect(new Set(durableContents(batches))).toEqual(new Set([
      "before-detach",
      "after-detach",
    ]));
    expect(JSON.parse(await readFile(
      join(controlDirectory, "followup-execution-input.json"),
      "utf8",
    ))).toMatchObject({ prompt: "post-recovery intervention" });
    expect(await pendingFrameCount(paths.databasePath)).toBe(0);
    expect(ownershipLedger.rowsFor(task.agentSessionId)).toMatchObject([
      {
        ownershipGeneration: 1,
        ownerKind: "runner_process",
        phase: "terminal",
        terminalAt: expect.any(String),
        runnerFact: "closed",
      },
      {
        ownershipGeneration: 2,
        ownerKind: "adopted_runner",
        phase: "terminal",
        terminalAt: expect.any(String),
        runnerFact: "completed",
      },
    ]);
    expect(ownershipLedger.nonTerminalRowsFor(task.agentSessionId)).toEqual([]);
    expect(task.executionOwnership).toBeUndefined();
    void oldExecution;

    await rm(join(controlDirectory, "finish"));
    const resumeHost = taskExecutor(
      composition.runtimeFactory,
      undefined,
      undefined,
      ownershipLedger,
    );
    const explicitResume = new AutoResumeTransition({
      logger: pino({ level: "silent" }),
      persistence: resumeHost.persistence,
    });
    await explicitResume.resume(
      task,
      { text: "explicit resume after adopt", user: "soak" },
      (resumedTask, activation) =>
        resumeHost.executor.startExecution(resumedTask, agent, activation),
    );
    const resumedPid = await waitForReplacementPid(paths.pidPath, pid);
    childPids.add(resumedPid);
    const resumedExecution = task.executionPromise;
    if (!resumedExecution) throw new Error("explicit resume execution promise missing");
    await writeFile(join(controlDirectory, "finish"), "go\n");
    await resumedExecution;
    expect(resumeHost.acquireExecutionOwnershipAndWaitForApplication).toHaveBeenCalledTimes(1);
    expect(resumeHost.acquireExecutionOwnershipAndWaitForApplication).toHaveBeenCalledWith(
      task.agentSessionId,
      expect.objectContaining({
        ownerKind: "runner_process",
        expectedTerminalEventId: expect.any(Number),
      }),
    );
    expect(task.status).toBe("completed");
    await waitFor(async () => !isPidAlive(resumedPid));
    childPids.delete(resumedPid);
    const resumedRows = ownershipLedger.rowsFor(task.agentSessionId);
    expect(resumedRows).toHaveLength(3);
    expect(resumedRows[2]).toMatchObject({
      ownershipGeneration: 3,
      ownerKind: "runner_process",
      phase: "terminal",
      terminalAt: expect.any(String),
      runnerFact: "completed",
    });
    expect(resumedRows[2]?.registrationId).not.toBe(resumedRows[1]?.registrationId);
    expect(resumedRows[2]?.pid).toBe(resumedPid);
    expect(resumedPid).not.toBe(pid);
    expect(ownershipLedger.nonTerminalRowsFor(task.agentSessionId)).toEqual([]);
    await composition.hostOwnership.release();

    const secondControlDirectory = join(root, "control-second");
    await mkdir(secondControlDirectory, { recursive: true });
    const staleLockPath = join(releasesDirectory, ".locks", releaseId);
    await mkdir(staleLockPath, { recursive: true });
    await writeFile(
      join(staleLockPath, "owner.json"),
      `${JSON.stringify({ pid: 2_147_483_647, startIdentity: "dead-owner" })}\n`,
    );
    const secondComposition = await composeRunnerProcessRuntime(true, {
      env,
      logger: pino({ level: "silent" }),
      pumpMux: mux,
      sessionStore: {
        appendIdempotent: vi.fn(async () => undefined),
        deleteIdempotent: vi.fn(async () => undefined),
      } as never,
      mcpConfigService,
      buildChildProcessEnv: () => ({
        ...process.env,
        NODE_OPTIONS: `--import ${pathToFileURL(requireFromTest.resolve("tsx")).href}`,
        RUNNER_E2E_CONTROL_DIR: secondControlDirectory,
        RUNNER_E2E_REQUIRE_INTERNAL_MCP: "1",
      }),
    });
    if (!secondComposition) throw new Error("second runner composition unexpectedly disabled");
    const secondTask = makeTask("session-cutover-stale-lock");
    const secondAgent = makeAgent(secondControlDirectory);
    const cleanStartDeliveries = makeAcceptedDeliveryRecorder();
    const secondHost = taskExecutor(
      secondComposition.runtimeFactory,
      undefined,
      undefined,
      ownershipLedger,
      cleanStartDeliveries,
    );
    secondHost.executor.startExecution(secondTask, secondAgent);
    const secondPaths = runnerProcessPaths(stateDirectory, secondTask.agentSessionId);
    await waitFor(async () => await pathExists(secondPaths.pidPath));
    const secondPid = Number.parseInt((await readFile(secondPaths.pidPath, "utf8")).trim(), 10);
    childPids.add(secondPid);
    await waitFor(async () => await pathExists(join(secondControlDirectory, "execute-started")));
    expect(JSON.parse(await readFile(
      join(secondControlDirectory, "internal-mcp-called"),
      "utf8",
    ))).toMatchObject({ path: "/mcp/internal", isError: false });
    const secondTransition = new RunningInterventionTransition({
      broadcaster: {
        emitEventEnvelope: vi.fn(async () => undefined),
      } as unknown as SessionBroadcaster,
      logger: pino({ level: "silent" }),
      persistence: secondHost.persistence,
    });
    const cleanStartDelivery: InterventionMessage = {
      text: "clean-start live intervention",
      user: "soak",
      deliveryId: "clean-start-live-intervention",
      deliveryLeaseOwner: "clean-start-live-claim",
      deliveryIntent: "human_live_steer",
    };
    cleanStartDeliveries.accept(secondTask.agentSessionId, cleanStartDelivery);
    await expect(secondTransition.deliver(secondTask, cleanStartDelivery))
      .resolves.toMatchObject({ delivered: true });
    await writeExecutionControls(secondControlDirectory);
    const secondExecution = secondTask.executionPromise;
    if (!secondExecution) throw new Error("clean-start execution promise missing");
    await secondExecution;
    expect(secondTask.status).toBe("completed");
    await waitFor(async () => !isPidAlive(secondPid));
    childPids.delete(secondPid);
    expect(JSON.parse(await readFile(
      join(secondControlDirectory, "followup-execution-input.json"),
      "utf8",
    ))).toMatchObject({ prompt: "clean-start live intervention" });
    expect(secondHost.acquireExecutionOwnershipAndWaitForApplication).toHaveBeenCalledTimes(2);
    expect(secondHost.acquireExecutionOwnershipAndWaitForApplication).toHaveBeenNthCalledWith(
      2,
      secondTask.agentSessionId,
      expect.objectContaining({
        ownerKind: "runner_process",
        deliveryId: cleanStartDelivery.deliveryId,
        deliveryLeaseOwner: cleanStartDelivery.deliveryLeaseOwner,
        previousExecutionGeneration: 1,
        previousExecutionCommandId: expect.any(String),
        executionCommandId: `delivery:${cleanStartDelivery.deliveryId}`,
      }),
    );
    expect(ownershipLedger.rowsFor(secondTask.agentSessionId)).toMatchObject([
      {
        ownershipGeneration: 1,
        ownerKind: "runner_process",
        pid: secondPid,
        phase: "terminal",
        terminalAt: expect.any(String),
        runnerFact: "closed",
      },
      {
        ownershipGeneration: 2,
        ownerKind: "runner_process",
        pid: secondPid,
        phase: "terminal",
        terminalAt: expect.any(String),
        runnerFact: "completed",
      },
    ]);
    expect(ownershipLedger.nonTerminalRowsFor(secondTask.agentSessionId)).toEqual([]);
    expect(secondTask.executionOwnership).toBeUndefined();

    await rm(join(secondControlDirectory, "finish"));
    const secondResumeHost = taskExecutor(
      secondComposition.runtimeFactory,
      undefined,
      undefined,
      ownershipLedger,
    );
    const secondExplicitResume = new AutoResumeTransition({
      logger: pino({ level: "silent" }),
      persistence: secondResumeHost.persistence,
    });
    await secondExplicitResume.resume(
      secondTask,
      { text: "explicit resume after clean completion", user: "soak" },
      (resumedTask, activation) =>
        secondResumeHost.executor.startExecution(resumedTask, secondAgent, activation),
    );
    const secondResumedPid = await waitForReplacementPid(secondPaths.pidPath, secondPid);
    childPids.add(secondResumedPid);
    const secondResumedExecution = secondTask.executionPromise;
    if (!secondResumedExecution) throw new Error("clean-start resume promise missing");
    await writeFile(join(secondControlDirectory, "finish"), "go\n");
    await secondResumedExecution;
    expect(secondResumeHost.acquireExecutionOwnershipAndWaitForApplication)
      .toHaveBeenCalledTimes(1);
    expect(secondResumeHost.acquireExecutionOwnershipAndWaitForApplication).toHaveBeenCalledWith(
      secondTask.agentSessionId,
      expect.objectContaining({
        ownerKind: "runner_process",
        expectedTerminalEventId: expect.any(Number),
      }),
    );
    expect(secondTask.status).toBe("completed");
    await waitFor(async () => !isPidAlive(secondResumedPid));
    childPids.delete(secondResumedPid);
    const secondResumedRows = ownershipLedger.rowsFor(secondTask.agentSessionId);
    expect(secondResumedRows).toHaveLength(3);
    expect(secondResumedRows[2]).toMatchObject({
      ownershipGeneration: 3,
      ownerKind: "runner_process",
      phase: "terminal",
      terminalAt: expect.any(String),
      runnerFact: "completed",
    });
    expect(secondResumedRows[2]?.registrationId)
      .not.toBe(secondResumedRows[1]?.registrationId);
    expect(secondResumedRows[2]?.pid).toBe(secondResumedPid);
    expect(secondResumedPid).not.toBe(secondPid);
    expect(ownershipLedger.nonTerminalRowsFor(secondTask.agentSessionId)).toEqual([]);
    expect(callerSessionIds).toEqual([
      task.agentSessionId,
      task.agentSessionId,
      task.agentSessionId,
      secondTask.agentSessionId,
      secondTask.agentSessionId,
      secondTask.agentSessionId,
    ]);
    await secondComposition.hostOwnership.release();
  }, 45_000);

  it.each(["success", "refail"] as const)(
    "runs prompt-too-long rollover through the real runner child and SQLite (%s)",
    async (scenario) => {
      const root = await mkdtemp(join(tmpdir(), `runner-rollover-${scenario}-`));
      temporaryRoots.push(root);
      const stateDirectory = join(root, "state");
      const artifactDirectory = join(root, "artifacts");
      const releasesDirectory = join(root, "runner-releases");
      const controlDirectory = join(root, "control");
      await mkdir(artifactDirectory, { recursive: true });
      await mkdir(controlDirectory, { recursive: true });
      await writeFile(join(artifactDirectory, "package.json"), '{"type":"module"}\n');
      await writeFile(
        join(artifactDirectory, "runner_entry.js"),
        `await import(${JSON.stringify(pathToFileURL(childFixturePath).href)});\n`,
      );
      const agentsConfigPath = join(root, "agents.yaml");
      const registryPath = join(root, "mcp-registry.yaml");
      const profilesPath = join(root, "mcp-profiles.yaml");
      await writeFile(agentsConfigPath, "agents: []\n");
      await writeFile(registryPath, "servers: []\n");
      await writeFile(
        profilesPath,
        "profiles:\n  - id: cutover-internal\n    mcp_servers: []\n",
      );
      const mcpConfigService = new McpConfigService({
        agentsConfigPath,
        registryPath,
        profilesPath,
      });
      const env = parseEnv({
        SOULSTREAM_NODE_ID: "rollover-test-node",
        SOULSTREAM_UPSTREAM_URL: "ws://127.0.0.1:1/ws/node",
        EVENT_OUTBOX_DIR: join(root, "legacy-outbox"),
        SOUL_RUNNER_PROCESS_ENABLED: "true",
        SOUL_RUNNER_STATE_DIR: stateDirectory,
        SOUL_RUNNER_ARTIFACT_DIR: artifactDirectory,
        SOUL_RUNNER_RELEASES_DIR: releasesDirectory,
        SOUL_RUNNER_LEASE_TIMEOUT_MS: "90000",
        MCP_ENABLED: "false",
      });
      const { mux, batches } = mockOrchIngress();
      const composition = await composeRunnerProcessRuntime(true, {
        env,
        logger: pino({ level: "silent" }),
        pumpMux: mux,
        sessionStore: {
          appendIdempotent: vi.fn(async () => undefined),
          deleteIdempotent: vi.fn(async () => undefined),
        } as never,
        mcpConfigService,
        buildChildProcessEnv: () => ({
          ...process.env,
          NODE_OPTIONS: `--import ${pathToFileURL(requireFromTest.resolve("tsx")).href}`,
          RUNNER_E2E_CONTROL_DIR: controlDirectory,
          RUNNER_E2E_ROLLOVER_SCENARIO: scenario,
        }),
      });
      if (!composition) throw new Error("runner rollover composition unexpectedly disabled");
      const releaseEntries = await import("node:fs/promises")
        .then(({ readdir }) => readdir(releasesDirectory));
      const releaseId = releaseEntries.find((entry) => entry.startsWith("sha256-"));
      if (!releaseId) throw new Error("runner rollover release was not prewarmed");
      readOnlyReleases.push(join(releasesDirectory, releaseId));
      const task = makeTask(`session-runner-rollover-${scenario}`);
      task.codexThreadId = "backend-session-old";
      task.prompt = "seed context usage";
      let queuedLargeFollowup = false;
      const rolloverDeliveries = makeAcceptedDeliveryRecorder();
      const host = taskExecutor(composition.runtimeFactory, (_event, target) => {
        if (_event.type !== "context_usage" || queuedLargeFollowup) return;
        queuedLargeFollowup = true;
        rolloverDeliveries.accept(target.agentSessionId, {
          text: "한".repeat(8_000),
          user: "u",
          deliveryId: `rollover:${target.agentSessionId}`,
          deliveryLeaseOwner: "rollover-claim",
          deliveryIntent: "human_live_steer",
        });
      }, undefined, undefined, rolloverDeliveries);
      const paths = runnerProcessPaths(stateDirectory, task.agentSessionId);

      host.executor.startExecution(task, makeAgent(controlDirectory));
      await waitFor(async () => await pathExists(paths.pidPath));
      const pid = Number.parseInt((await readFile(paths.pidPath, "utf8")).trim(), 10);
      childPids.add(pid);
      await task.executionPromise;

      expect(await pathExists(join(controlDirectory, "rollover-compact-attempted"))).toBe(true);
      const executionParams = await Promise.all([1, 2, 3].map(async (index) =>
        JSON.parse(await readFile(
          join(controlDirectory, `rollover-execution-${index}.json`),
          "utf8",
        )) as Record<string, unknown>
      ));
      expect(executionParams[1]).toMatchObject({ resumeSessionId: "backend-session-old" });
      expect(executionParams[2]).toMatchObject({
        backendSessionRolloverFrom: "backend-session-old",
      });
      expect(executionParams[2]).not.toHaveProperty("resumeSessionId");
      expect((await readRunnerBootstrap(paths.databasePath)).payload).toMatchObject({
        backend_session_id: "backend-session-fresh",
      });
      expect(batches.flatMap((batch) => batch.events).find(
        (event) => (event.payload as { session_id?: unknown }).session_id
          === "backend-session-fresh",
      )).toMatchObject({
        session_effect: {
          kind: "rotate_backend_session_id",
          expected_backend_session_id: "backend-session-old",
          backend_session_id: "backend-session-fresh",
        },
      });
      if (scenario === "success") {
        expect({ status: task.status, error: task.error }).toEqual({
          status: "completed",
          error: undefined,
        });
        expect(task.claudeBackendRolloverAttempts).toBe(0);
        expect(task.claudeBackendRolloverCycleFrom).toBeUndefined();
      } else {
        expect(task.status).toBe("error");
        expect(task.error).toContain("Prompt is too long after rollover");
        expect(task.claudeBackendRolloverAttempts).toBe(1);
        expect(task.claudeBackendRolloverCycleFrom).toBe("backend-session-old");
      }
      expect(task.codexThreadId).toBe("backend-session-fresh");
      await waitFor(async () => !isPidAlive(pid));
      childPids.delete(pid);
      await composition.hostOwnership.release();
    },
    45_000,
  );
});

function taskExecutor(
  runnerProcessFactory: NonNullable<Awaited<ReturnType<typeof composeRunnerProcessRuntime>>>["runtimeFactory"],
  observeEvent?: (event: SSEEventPayload, task: Task) => void | Promise<void>,
  recoveredOwnership?: NonNullable<Task["executionOwnership"]>,
  ownershipLedger?: RunnerCutoverOwnershipLedger,
  deliveryRecorder?: ReturnType<typeof makeAcceptedDeliveryRecorder>,
): {
  executor: TaskExecutor;
  persistence: EventPersistence;
  enqueueRunningTransitionAndWaitForApplication: ReturnType<
    typeof makeEventPersistenceTestDouble
  >["enqueueRunningTransitionAndWaitForApplication"];
  acquireExecutionOwnershipAndWaitForApplication: ReturnType<
    typeof makeEventPersistenceTestDouble
  >["acquireExecutionOwnershipAndWaitForApplication"];
} {
  const observe = async (_sessionId: string, event: SSEEventPayload, task: Task) => {
    if (event.type === "assistant_message" && typeof event.content === "string") {
      task.lastAssistantText = event.content;
    }
    await observeEvent?.(event, task);
  };
  const persistenceDouble = ownershipLedger
    ? ownershipLedger.createHostPersistence(observe)
    : makeEventPersistenceTestDouble(observe);
  const db = {
    getSession: vi.fn(async () => {
      // A replacement host reads the sessions-row owner written by the first
      // host; its fresh persistence test double cannot reconstruct that row.
      if (!recoveredOwnership) return null;
      return {
        execution_generation: recoveredOwnership.ownershipGeneration,
        execution_manifest_id: recoveredOwnership.manifestId,
        execution_runtime_env_identity: recoveredOwnership.runtimeEnvIdentity,
        execution_registration_id: recoveredOwnership.registrationId,
        execution_pid: recoveredOwnership.pid,
        execution_start_identity: recoveredOwnership.startIdentity,
        execution_command_id: recoveredOwnership.executionCommandId,
      };
    }),
    updateSession: vi.fn(async () => undefined),
    setClaudeSessionId: vi.fn(async () => undefined),
  } as unknown as SessionDB;
  const broadcaster = {
    emitEventEnvelope: vi.fn(async () => undefined),
    emitSessionUpdated: vi.fn(async () => undefined),
  } as unknown as SessionBroadcaster;
  const unusedEngine = (): EnginePort => {
    throw new Error("in-process engine must not be selected with runner flag on");
  };
  return {
    executor: new TaskExecutor(
      unusedEngine,
      db,
      persistenceDouble.persistence,
      broadcaster,
      pino({ level: "silent" }),
      undefined,
      undefined,
      undefined,
      undefined,
      deliveryRecorder,
      undefined,
      runnerProcessFactory,
    ),
    persistence: persistenceDouble.persistence,
    enqueueRunningTransitionAndWaitForApplication:
      persistenceDouble.enqueueRunningTransitionAndWaitForApplication,
    acquireExecutionOwnershipAndWaitForApplication:
      persistenceDouble.acquireExecutionOwnershipAndWaitForApplication,
  };
}

function makeTask(agentSessionId = "session-cutover-smoke"): Task {
  return {
    agentSessionId,
    prompt: "exercise runner cutover",
    status: "running",
    profileId: "cutover-agent",
    createdAt: new Date(),
    lastEventId: 0,
    lastReadEventId: 0,
  };
}

function makeAcceptedDeliveryRecorder() {
  const accepted = new Map<string, {
    targetSessionId: string;
    message: InterventionMessage;
  }>();
  return {
    accept(targetSessionId: string, message: InterventionMessage): void {
      if (!message.deliveryId) throw new Error("canonical test delivery id is required");
      accepted.set(message.deliveryId, { targetSessionId, message });
    },
    async nextAcceptedForTarget(targetSessionId: string) {
      return [...accepted.values()].find(
        (entry) => entry.targetSessionId === targetSessionId,
      )?.message;
    },
    async acceptedDelivery(deliveryId: string, targetSessionId: string) {
      const entry = accepted.get(deliveryId);
      if (!entry || entry.targetSessionId !== targetSessionId) {
        throw new Error(`canonical test delivery is unavailable: ${deliveryId}`);
      }
      const canonical = {
        ...entry.message,
        deliveryLeaseOwner: `delivery:${deliveryId}`,
      };
      entry.message = canonical;
      return canonical;
    },
    async recordConsumed(message: InterventionMessage) {
      if (message.deliveryId) accepted.delete(message.deliveryId);
    },
  };
}

function makeAgent(workspaceDirectory: string): AgentProfile {
  return {
    id: "cutover-agent",
    name: "Cutover Agent",
    backend: "claude",
    workspace_dir: workspaceDirectory,
    mcp_profile: "cutover-internal",
  };
}

async function startInternalMcpServer(): Promise<{
  baseUrl: string;
  internalUrl: string;
  callerSessionIds: Array<string | undefined>;
}> {
  const callerSessionIds: Array<string | undefined> = [];
  const logger = pino({ level: "silent" });
  const runtime: McpRuntime = {
    nodeId: "cutover-test-node",
    agentsConfigPath: "/tmp/cutover-agents.yaml",
    db: {} as SessionDB,
    taskManager: {
      listTasks: () => [],
      getTask: () => undefined,
    } as unknown as TaskManager,
    taskExecutor: {} as TaskExecutor,
    agentRegistry: new AgentRegistry([]),
    catalogService: {} as CatalogService,
    agentProfileSource: {
      async list() {
        callerSessionIds.push(getCurrentMcpCallerSessionId());
        return [];
      },
    } as never,
    logger,
  };
  const server = await buildServer({
    host: "127.0.0.1",
    port: 0,
    nodeId: "cutover-test-node",
    logger,
    mcp: {
      runtime,
      path: "/mcp",
      statelessTransport: true,
      auth: {
        requireAuth: false,
        bearerToken: "",
        allowedHosts: ["127.0.0.1", "localhost"],
      },
    },
  });
  mcpServers.push(server);
  if (!server.internalMcpServer) {
    throw new Error("internal MCP companion was not composed");
  }
  const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
  const internalUrl = await server.internalMcpServer.listen({ host: "127.0.0.1", port: 0 });
  return { baseUrl, internalUrl, callerSessionIds };
}

async function writeExecutionControls(controlDirectory: string): Promise<void> {
  await writeFile(join(controlDirectory, "emit-first"), "go\n");
  await writeFile(join(controlDirectory, "emit-after-detach"), "go\n");
  await writeFile(join(controlDirectory, "finish"), "go\n");
}

function mockOrchIngress(): { mux: EventOutboxPumpMux; batches: EventOutboxBatch[] } {
  const mux = new EventOutboxPumpMux(new EventOutboxPump(emptyStore(), vi.fn()));
  const batches: EventOutboxBatch[] = [];
  mux.connect(async (batch) => {
    batches.push(batch);
    await mux.handleAck({
      type: "event_append_ack",
      stream_id: batch.stream_id,
      acked_through: batch.events.at(-1)!.source_seq,
      events: batch.events.map((event) => ({
        source_seq: event.source_seq,
        event_id: 20_000 + event.source_seq,
      })),
    });
  });
  return { mux, batches };
}

function durableContents(batches: EventOutboxBatch[]): string[] {
  return batches.flatMap((batch) => batch.events.flatMap((event) => {
    const content = (event.payload as { content?: unknown }).content;
    return typeof content === "string" ? [content] : [];
  }));
}

function emptyStore(): EventOutboxPumpStore {
  return {
    streamId: "node-cutover-primary",
    ackedSeq: 0,
    onAppend: () => () => {},
    readBatch: async () => null,
    acknowledge: async () => {},
  };
}

async function readRunnerBootstrap(path: string) {
  const outbox = await RunnerSqliteEventOutbox.openReadOnly(path);
  try {
    const bootstrap = await outbox.readBootstrap();
    if (!bootstrap) throw new Error("runner bootstrap missing");
    return bootstrap;
  } finally {
    outbox.close();
  }
}

async function pendingFrameCount(path: string): Promise<number> {
  const outbox = await RunnerSqliteEventOutbox.openReadOnly(path);
  try {
    return (await outbox.readPendingIpcFrames()).length;
  } finally {
    outbox.close();
  }
}

async function hasDurableContent(path: string, expectedContent: string): Promise<boolean> {
  const outbox = await RunnerSqliteEventOutbox.openReadOnly(path);
  try {
    const batch = await outbox.readBatchAfter(1);
    return batch?.events.some((event) =>
      (event.payload as { content?: unknown }).content === expectedContent) ?? false;
  } finally {
    outbox.close();
  }
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

async function readPidIfExists(path: string): Promise<number | null> {
  try {
    return Number.parseInt((await readFile(path, "utf8")).trim(), 10);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function hasCompleteJson(path: string): Promise<boolean> {
  if (!(await pathExists(path))) return false;
  try {
    JSON.parse(await readFile(path, "utf8"));
    return true;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

async function waitForReplacementPid(path: string, previousPid: number): Promise<number> {
  let replacementPid: number | null = null;
  await waitFor(async () => {
    const candidate = await readPidIfExists(path);
    if (candidate === null || candidate === previousPid || !isPidAlive(candidate)) return false;
    replacementPid = candidate;
    return true;
  });
  if (replacementPid === null) throw new Error("replacement runner pid missing");
  return replacementPid;
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("runner cutover smoke wait timeout");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
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

function killIfAlive(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already exited.
  }
}

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from
  "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import pino from "pino";

import {
  createProductionOrchestrator,
  loadOrchServerEnvironment,
  type ProductionOrchestrator,
} from "../../../orch-server-ts/src/index.js";
import { loadAgentRegistry } from "../../src/agent_registry.js";
import { parseEnv } from "../../src/config.js";
import { McpConfigService } from "../../src/mcp_config_service.js";
import { ReleaseActivationState } from "../../src/release/release_activation_state.js";
import { buildReleaseManifest } from "../../src/release/release_manifest.js";
import { hashArtifactSet } from "../../src/runner/runner_release_materializer.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import { readRunnerRegistrationIdentity } from
  "../../src/runner/runner_registration_identity.js";
import { composeWorkerRuntime } from "../../src/runtime/worker_composition.js";
import { startWorkerRuntime } from "../../src/runtime/worker_startup.js";
import { startServer } from "../../src/server.js";
import type { FullSchemaPostgresHarness } from
  "../db/full_schema_postgres_harness.js";
import type {
  DeliveryObservation,
  EngineBoundaryProbeObservation,
  ExecuteFramesProbeObservation,
  FullSliceBackend,
  FullSliceObservation,
  FullSliceScenario,
  InterveneProbeObservation,
  PublicHttpAck,
  RunnerIdentityObservation,
} from "./s4_new_session_full_slice_types.js";

const AUTH_TOKEN = "full-slice-service-token";
const NODE_ID = "full-slice-production-node";
const AGENT_ID = "full-slice-agent";
const WORKER_ROLE = "--full-slice-worker-child";
const POLL_BUDGET_MS = 60_000;
const testDirectory = dirname(fileURLToPath(import.meta.url));
const childFixturePath = join(testDirectory, "fixtures/runner_process_e2e_child.ts");
const requireFromTest = createRequire(import.meta.url);
const tsxImportUrl = pathToFileURL(requireFromTest.resolve("tsx")).href;
const silentLogger = pino({ level: "silent" });

type NodeSnapshot = {
  nodeId: string;
  connectionId: string;
};

export class ProductionFullSliceHarness {
  private worker: ChildProcess | null = null;
  private unexpectedWorkerFailure: Error | null = null;
  private orch: ProductionOrchestrator | null = null;
  private orchAddress = "";
  private sessionId = "";
  private workerRecoveryReadyPath: string | null = null;
  private readonly runnerIdentities = new Map<string, RunnerIdentityObservation>();

  private constructor(
    private readonly postgres: FullSchemaPostgresHarness,
    private readonly scenario: FullSliceScenario,
    private readonly backend: FullSliceBackend,
    private readonly root: string,
    private readonly controlDirectory: string,
    private readonly stateDirectory: string,
    private readonly artifactDirectory: string,
    private readonly releasesDirectory: string,
    private readonly outboxDirectory: string,
    private readonly agentsConfigPath: string,
    private readonly modelCatalogPath: string,
  ) {}

  static async create(
    postgres: FullSchemaPostgresHarness,
    scenario: FullSliceScenario,
    backend: FullSliceBackend,
  ): Promise<ProductionFullSliceHarness> {
    const root = await mkdtemp(
      join(tmpdir(), `full-slice-${scenario.toLowerCase()}-${backend}-`),
    );
    const controlDirectory = join(root, "control");
    const stateDirectory = join(root, "runner-state");
    const artifactDirectory = join(root, "runner-artifact");
    const releasesDirectory = join(root, "runner-releases");
    const outboxDirectory = join(root, "event-outbox");
    const agentsConfigPath = join(root, "agents.yaml");
    const modelCatalogPath = join(root, "model-catalog.yaml");
    await Promise.all([
      mkdir(controlDirectory, { recursive: true }),
      mkdir(artifactDirectory, { recursive: true }),
    ]);
    await writeFile(join(artifactDirectory, "package.json"), "{\"type\":\"module\"}\n");
    await writeFile(
      join(artifactDirectory, "runner_entry.js"),
      `await import(${JSON.stringify(pathToFileURL(childFixturePath).href)});\n`,
    );
    await writeFile(
      agentsConfigPath,
      [
        "agents:",
        `  - id: ${AGENT_ID}`,
        "    name: Full Slice Agent",
        `    backend: ${backend}`,
        `    workspace_dir: ${controlDirectory}`,
        "",
      ].join("\n"),
    );
    await writeFile(modelCatalogPath, "presets: []\n");
    return new ProductionFullSliceHarness(
      postgres,
      scenario,
      backend,
      root,
      controlDirectory,
      stateDirectory,
      artifactDirectory,
      releasesDirectory,
      outboxDirectory,
      agentsConfigPath,
      modelCatalogPath,
    );
  }

  async run(): Promise<FullSliceObservation> {
    this.orch = await createProductionOrchestrator({
      config: loadOrchServerEnvironment({
        HOST: "127.0.0.1",
        PORT: "0",
        DATABASE_URL: this.postgres.databaseUrl,
        ENVIRONMENT: "production",
        CORS_ALLOWED_ORIGINS: "http://127.0.0.1",
        AUTH_BEARER_TOKEN: AUTH_TOKEN,
        GOOGLE_CLIENT_ID: "full-slice-google-client",
        JWT_SECRET: "full-slice-jwt-secret",
        CLAUDE_OAUTH_CLIENT_ID: "full-slice-claude-client",
        CLAUDE_OAUTH_CALLBACK_URL: "http://127.0.0.1/claude/callback",
      }),
      warn: () => undefined,
    });
    this.orchAddress = await this.orch.listen();

    await this.spawnWorker();
    const firstNode = await this.waitForNode();
    const publicAcks: PublicHttpAck[] = [];
    const createAck = await this.publicCommand("create", "/api/sessions", {
      prompt: this.initialPrompt,
      profile: AGENT_ID,
      nodeId: NODE_ID,
    });
    publicAcks.push(createAck);
    this.sessionId = requireString(createAck.body.agentSessionId, "create agentSessionId");

    await this.waitForExecuteProbe(false);
    const first = await this.waitForRunnerIdentity();
    let restart: FullSliceObservation["restart"] = null;
    let reattached: RunnerIdentityObservation | null = null;
    let successor: RunnerIdentityObservation | null = null;
    let firstAliveAfterInitialTerminal: boolean | null = null;
    let silentWindow: FullSliceObservation["silentWindow"] = null;
    let deliveryId: string | null = null;
    let ghostResumeFailed = false;

    if (this.requiresRestart) {
      await this.killWorker();
      await this.spawnWorker();
      const restartedNode = await this.waitForNode(
        (node) => node.connectionId !== firstNode.connectionId,
      );
      restart = {
        beforeConnectionId: firstNode.connectionId,
        afterConnectionId: restartedNode.connectionId,
      };
      await this.waitForWorkerRecoveryReady();
      reattached = await this.waitForRunnerIdentity(first.registrationId);
    }

    if (this.scenario === "S1") {
      await delay(35_000);
      this.throwIfWorkerFailed();
      const identityAfterSilence = await this.waitForRunnerIdentity(first.registrationId);
      const durableAfterSilence = await this.readDurableObservation();
      silentWindow = {
        runnerAlive: identityAfterSilence.alive,
        sessionEndedCount: durableAfterSilence.sessionEndedCount,
        errorEventCount: durableAfterSilence.errorEventCount,
      };
    }

    if (this.isActiveIntervention) {
      const interveneAck = await this.publicCommand(
        "intervene",
        `/api/sessions/${this.sessionId}/intervene`,
        { text: this.interventionPrompt, user: "full-slice-user" },
      );
      publicAcks.push(interveneAck);
      deliveryId = requireString(interveneAck.deliveryId, "intervene deliveryId");
      await this.waitForInterveneProbe();
    } else {
      await this.release("initial");
    }

    await this.waitForTerminalCount(1);

    if (this.isGhostRunningResume) {
      await this.waitForPidDeath(first.pid);
      firstAliveAfterInitialTerminal = isPidAlive(first.pid);
      await this.killWorker();
      await this.stageGhostRunning();
      await rm(
        runnerProcessPaths(this.stateDirectory, this.sessionId).sessionDirectory,
        { recursive: true, force: true },
      );

      await this.spawnWorker();
      const restartedNode = await this.waitForNode(
        (node) => node.connectionId !== firstNode.connectionId,
      );
      restart = {
        beforeConnectionId: firstNode.connectionId,
        afterConnectionId: restartedNode.connectionId,
      };
      await this.waitForWorkerRecoveryReady();
      const interveneAck = await this.publicCommand(
        "intervene",
        `/api/sessions/${this.sessionId}/intervene`,
        { text: this.interventionPrompt, user: "full-slice-user" },
      );
      publicAcks.push(interveneAck);
      deliveryId = interveneAck.deliveryId ?? await this.readLatestDeliveryId();
      if (
        interveneAck.status === 200
        && interveneAck.body.outcome === "auto_resumed"
      ) {
        await this.waitForExecuteProbe(true);
        successor = await this.waitForDifferentRunnerIdentity(first.registrationId);
        await this.release("resume");
        await this.waitForTerminalCount(2);
        await this.waitForConsumedDelivery(deliveryId);
      } else {
        ghostResumeFailed = true;
      }
    }

    if (this.isCompletedResume && !this.isGhostRunningResume) {
      await this.waitForPidDeath(first.pid);
      firstAliveAfterInitialTerminal = isPidAlive(first.pid);
      const interveneAck = await this.publicCommand(
        "intervene",
        `/api/sessions/${this.sessionId}/intervene`,
        { text: this.interventionPrompt, user: "full-slice-user" },
      );
      publicAcks.push(interveneAck);
      deliveryId = requireString(interveneAck.deliveryId, "intervene deliveryId");
      await this.waitForExecuteProbe(true);
      successor = await this.waitForDifferentRunnerIdentity(first.registrationId);
      await this.release("resume");
      await this.waitForTerminalCount(2);
    }

    const delivery = deliveryId
      ? ghostResumeFailed
        ? await this.readDeliveryObservation(deliveryId)
        : await this.waitForConsumedDelivery(deliveryId)
      : null;
    return {
      scenario: this.scenario,
      backend: this.backend,
      sessionId: this.sessionId,
      publicAcks,
      restart,
      runner: { first, reattached, successor, firstAliveAfterInitialTerminal },
      silentWindow,
      engineBoundaryProbes: await this.readEngineBoundaryProbes(),
      delivery,
      durable: await this.readDurableObservation(),
    };
  }

  async cleanup(): Promise<void> {
    await this.captureCurrentRunnerIdentity();
    await this.killWorker();
    this.unexpectedWorkerFailure = null;
    for (const identity of this.runnerIdentities.values()) {
      if (isPidAlive(identity.pid)) process.kill(identity.pid, "SIGKILL");
    }
    await this.poll("all observed runner processes to exit", async () =>
      [...this.runnerIdentities.values()].every((identity) => !isPidAlive(identity.pid))
        ? true
        : null
    );
    await this.orch?.close();
    try {
      const releases = await readdir(this.releasesDirectory, { withFileTypes: true });
      for (const release of releases) {
        if (release.isDirectory()) {
          await chmod(join(this.releasesDirectory, release.name), 0o755);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rm(this.root, { recursive: true, force: true });
  }

  private get initialPrompt(): string {
    return `${this.scenario} ${this.backend} initial prompt`;
  }

  private get interventionPrompt(): string {
    return this.isCompletedResume
      ? `${this.scenario} ${this.backend} completed resume`
      : `${this.scenario} ${this.backend} active intervention`;
  }

  private get requiresRestart(): boolean {
    return this.scenario === "S1" || this.scenario === "S2" || this.scenario === "S3";
  }

  private get isCompletedResume(): boolean {
    return this.scenario === "S2" || this.scenario === "S5" || this.scenario === "S7";
  }

  private get isGhostRunningResume(): boolean {
    return this.scenario === "S7";
  }

  private get isActiveIntervention(): boolean {
    return this.scenario === "S3" || this.scenario === "S6";
  }

  private async spawnWorker(): Promise<void> {
    const workerPort = await reservePort();
    const upstream = new URL(this.orchAddress);
    upstream.protocol = upstream.protocol === "https:" ? "wss:" : "ws:";
    upstream.pathname = "/ws/node";
    const child = spawn(
      process.execPath,
      ["--import", tsxImportUrl, fileURLToPath(import.meta.url), WORKER_ROLE],
      {
        env: withoutAnthropicApiKey({
          ...process.env,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import ${tsxImportUrl}`]
            .filter(Boolean).join(" "),
          SOULSTREAM_NODE_ID: NODE_ID,
          SOULSTREAM_UPSTREAM_URL: upstream.toString(),
          AUTH_BEARER_TOKEN: AUTH_TOKEN,
          HOST: "127.0.0.1",
          PORT: String(workerPort),
          ENVIRONMENT: "production",
          LOG_LEVEL: "error",
          EVENT_OUTBOX_DIR: this.outboxDirectory,
          SOUL_RUNNER_PROCESS_ENABLED: "true",
          SOUL_RUNNER_STATE_DIR: this.stateDirectory,
          SOUL_RUNNER_ARTIFACT_DIR: this.artifactDirectory,
          SOUL_RUNNER_RELEASES_DIR: this.releasesDirectory,
          AGENTS_CONFIG_PATH: this.agentsConfigPath,
          AGENT_PROFILE_CACHE_PATH: join(this.root, "agent-profile-cache.json"),
          MODEL_CATALOG_PATH: this.modelCatalogPath,
          INCOMING_FILE_DIR: join(this.root, "incoming"),
          MCP_ENABLED: "false",
          MCP_STATELESS_TRANSPORT_ENABLED: "false",
          RUNNER_E2E_CONTROL_DIR: this.controlDirectory,
          RUNNER_E2E_FULL_SLICE_SCENARIO: this.scenario,
          RUNNER_E2E_FULL_SLICE_BACKEND: this.backend,
        }),
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    this.worker = child;
    this.workerRecoveryReadyPath = join(
      this.controlDirectory,
      `worker-recovery-ready-${child.pid}`,
    );
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("exit", (code, signal) => {
      if (this.worker !== child) return;
      this.unexpectedWorkerFailure = new Error(
        `worker exited code=${code ?? "none"} signal=${signal ?? "none"}: ${stderr.trim()}`,
      );
    });
  }

  private async killWorker(): Promise<void> {
    const child = this.worker;
    this.worker = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }

  private async publicCommand(
    operation: PublicHttpAck["operation"],
    path: string,
    body: Record<string, unknown>,
  ): Promise<PublicHttpAck> {
    this.throwIfWorkerFailed();
    const response = await fetch(`${this.orchAddress}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const responseBody = await response.json() as Record<string, unknown>;
    this.throwIfWorkerFailed();
    return {
      operation,
      status: response.status,
      body: responseBody,
      deliveryId: optionalString(responseBody.deliveryId),
    };
  }

  private async waitForNode(
    predicate: (node: NodeSnapshot) => boolean = () => true,
  ): Promise<NodeSnapshot> {
    return await this.poll("production node registration", async () => {
      const response = await fetch(`${this.orchAddress}/api/nodes`, {
        headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      });
      if (!response.ok) return null;
      const body = await response.json() as { nodes?: NodeSnapshot[] };
      const node = body.nodes?.find((candidate) => candidate.nodeId === NODE_ID);
      return node && predicate(node) ? node : null;
    });
  }

  private async waitForWorkerRecoveryReady(): Promise<void> {
    const markerPath = this.workerRecoveryReadyPath;
    if (!markerPath) throw new Error("worker recovery readiness marker path missing");
    await this.poll("worker runner recovery readiness", async () =>
      await readFile(markerPath, "utf8").then(() => true).catch(() => null)
    );
  }

  private async waitForExecuteProbe(resumed: boolean): Promise<ExecuteFramesProbeObservation> {
    return await this.poll(
      resumed ? "resume executeFrames probe" : "initial executeFrames probe",
      async () => {
        const probe = (await this.readEngineBoundaryProbes()).find((candidate) =>
          candidate.call === "executeFrames"
          && (candidate.resumeSessionId !== null) === resumed
        );
        return probe?.call === "executeFrames" ? probe : null;
      },
    );
  }

  private async waitForInterveneProbe(): Promise<InterveneProbeObservation> {
    return await this.poll("intervene probe", async () => {
      const probe = (await this.readEngineBoundaryProbes()).find(
        (candidate) => candidate.call === "intervene",
      );
      return probe?.call === "intervene" ? probe : null;
    });
  }

  private async waitForRunnerIdentity(
    expectedRegistrationId?: string,
  ): Promise<RunnerIdentityObservation> {
    return await this.poll("runner registration identity", async () => {
      const identity = await readRunnerRegistrationIdentity(
        runnerProcessPaths(this.stateDirectory, this.sessionId).sessionDirectory,
      );
      if (!identity || (expectedRegistrationId && identity.registrationId !== expectedRegistrationId)) {
        return null;
      }
      const observed = { ...identity, alive: isPidAlive(identity.pid) };
      if (!observed.alive) return null;
      this.rememberRunner(observed);
      return observed;
    });
  }

  private async waitForDifferentRunnerIdentity(
    previousRegistrationId: string,
  ): Promise<RunnerIdentityObservation> {
    return await this.poll("successor runner identity", async () => {
      const identity = await readRunnerRegistrationIdentity(
        runnerProcessPaths(this.stateDirectory, this.sessionId).sessionDirectory,
      );
      if (!identity || identity.registrationId === previousRegistrationId || !isPidAlive(identity.pid)) {
        return null;
      }
      const observed = { ...identity, alive: true };
      this.rememberRunner(observed);
      return observed;
    });
  }

  private async waitForPidDeath(pid: number): Promise<void> {
    await this.poll(`runner pid ${pid} to exit`, async () => !isPidAlive(pid) ? true : null);
  }

  private async waitForTerminalCount(expected: number): Promise<void> {
    await this.poll(`session terminal count ${expected}`, async () => {
      const [row] = await this.postgres.sql<Array<{ status: string; count: number }>>`
        SELECT s.status,
          (SELECT COUNT(*)::int FROM events e
            WHERE e.session_id = s.session_id AND e.event_type = 'session_ended') AS count
        FROM sessions s WHERE s.session_id = ${this.sessionId}
      `;
      return row?.status === "completed" && Number(row.count) >= expected ? true : null;
    });
  }

  private async waitForConsumedDelivery(deliveryId: string): Promise<DeliveryObservation> {
    return await this.poll(`delivery ${deliveryId} consumed`, async () => {
      const rows = await this.postgres.sql<Array<{
        delivery_id: string;
        target_session_id: string;
        state: string;
        aggregate_state: string;
        consumed_at: string | null;
      }>>`
        SELECT delivery_id, target_session_id, state, aggregate_state,
          consumed_at::text AS consumed_at
        FROM session_deliveries
        WHERE delivery_id = ${deliveryId}
      `;
      const row = rows[0];
      if (
        rows.length !== 1
        || !row
        || row.state !== "consumed"
        || row.aggregate_state !== "consumed"
        || row.consumed_at === null
      ) return null;
      return {
        rowCount: rows.length,
        deliveryId: row.delivery_id,
        targetSessionId: row.target_session_id,
        state: row.state,
        aggregateState: row.aggregate_state,
        consumedAt: row.consumed_at,
      };
    });
  }

  private async readDeliveryObservation(deliveryId: string): Promise<DeliveryObservation> {
    const rows = await this.postgres.sql<Array<{
      delivery_id: string;
      target_session_id: string;
      state: string;
      aggregate_state: string;
      consumed_at: string | null;
    }>>`
      SELECT delivery_id, target_session_id, state, aggregate_state,
        consumed_at::text AS consumed_at
      FROM session_deliveries
      WHERE delivery_id = ${deliveryId}
    `;
    const row = rows[0];
    if (rows.length !== 1 || !row) {
      throw new Error(`Delivery ${deliveryId} disappeared from the full-slice database`);
    }
    return {
      rowCount: rows.length,
      deliveryId: row.delivery_id,
      targetSessionId: row.target_session_id,
      state: row.state,
      aggregateState: row.aggregate_state,
      consumedAt: row.consumed_at,
    };
  }

  private async stageGhostRunning(): Promise<void> {
    await this.postgres.sql`
      UPDATE sessions
      SET status = 'running', termination_reason = NULL, termination_detail = NULL,
        termination_event_id = NULL, updated_at = NOW()
      WHERE session_id = ${this.sessionId}
    `;
    const [shape] = await this.postgres.sql<Array<{
      status: string;
      active_owner_count: number;
    }>>`
      SELECT session.status,
        (SELECT COUNT(*)::int FROM session_execution_ownerships AS ownership
          WHERE ownership.session_id = session.session_id
            AND ownership.phase = 'active') AS active_owner_count
      FROM sessions AS session
      WHERE session.session_id = ${this.sessionId}
    `;
    if (shape?.status !== "running" || Number(shape.active_owner_count) !== 0) {
      throw new Error("S7 failed to stage a running session without durable execution evidence");
    }
  }

  private async readLatestDeliveryId(): Promise<string> {
    const [delivery] = await this.postgres.sql<Array<{ delivery_id: string }>>`
      SELECT delivery_id
      FROM session_deliveries
      WHERE target_session_id = ${this.sessionId}
      ORDER BY enqueue_sequence DESC
      LIMIT 1
    `;
    return requireString(delivery?.delivery_id, "latest intervention deliveryId");
  }

  private async readEngineBoundaryProbes(): Promise<EngineBoundaryProbeObservation[]> {
    const entries = await readdir(this.controlDirectory).catch(() => []);
    const probeEntries = entries
      .filter((entry) => entry.startsWith("engine-boundary-") && entry.endsWith(".json"))
      .sort();
    return await Promise.all(probeEntries.map(async (entry) => JSON.parse(
      await readFile(join(this.controlDirectory, entry), "utf8"),
    ) as EngineBoundaryProbeObservation));
  }

  private async readDurableObservation(): Promise<FullSliceObservation["durable"]> {
    const [session] = await this.postgres.sql<Array<{ status: string }>>`
      SELECT status FROM sessions WHERE session_id = ${this.sessionId}
    `;
    const events = await this.postgres.sql<Array<{
      event_type: string;
      payload: Record<string, unknown> | null;
    }>>`
      SELECT event_type, payload FROM events
      WHERE session_id = ${this.sessionId} ORDER BY id
    `;
    const [counts] = await this.postgres.sql<Array<{
      unfinished_delivery_count: number;
      ghost_running_count: number;
    }>>`
      SELECT
        (SELECT COUNT(*)::int FROM session_deliveries AS delivery
          WHERE delivery.target_session_id = ${this.sessionId}
            AND delivery.state NOT IN ('consumed', 'superseded')) AS unfinished_delivery_count,
        (SELECT COUNT(*)::int FROM sessions AS candidate
          WHERE candidate.session_id = ${this.sessionId}
            AND candidate.status = 'running'
            AND NOT EXISTS (
              SELECT 1 FROM session_execution_ownerships AS ownership
              WHERE ownership.session_id = candidate.session_id
                AND ownership.phase = 'active'
            )) AS ghost_running_count
    `;
    return {
      status: session?.status ?? "missing",
      assistantContents: events
        .filter((event) => event.event_type === "assistant_message")
        .map((event) => stringField(event.payload, "content"))
        .filter((value): value is string => value !== null),
      userMessageTexts: events
        .filter((event) => event.event_type === "user_message")
        .map((event) => stringField(event.payload, "content") ?? stringField(event.payload, "text"))
        .filter((value): value is string => value !== null),
      interventionSentTexts: events
        .filter((event) => event.event_type === "intervention_sent")
        .map((event) => stringField(event.payload, "text"))
        .filter((value): value is string => value !== null),
      sessionEndedCount: events.filter((event) => event.event_type === "session_ended").length,
      errorEventCount: events.filter((event) => event.event_type === "error").length,
      unfinishedDeliveryCount: Number(counts?.unfinished_delivery_count ?? 0),
      ghostRunningCount: Number(counts?.ghost_running_count ?? 0),
    };
  }

  private async release(phase: "initial" | "resume"): Promise<void> {
    await writeFile(
      join(this.controlDirectory, `${this.scenario}-${this.backend}-release-${phase}`),
      "release\n",
    );
  }

  private async captureCurrentRunnerIdentity(): Promise<void> {
    if (!this.sessionId) return;
    const identity = await readRunnerRegistrationIdentity(
      runnerProcessPaths(this.stateDirectory, this.sessionId).sessionDirectory,
    );
    if (identity) this.rememberRunner({ ...identity, alive: isPidAlive(identity.pid) });
  }

  private rememberRunner(identity: RunnerIdentityObservation): void {
    this.runnerIdentities.set(
      `${identity.registrationId}:${identity.pid}:${identity.startIdentity}`,
      identity,
    );
  }

  private throwIfWorkerFailed(): void {
    if (this.unexpectedWorkerFailure) throw this.unexpectedWorkerFailure;
  }

  private async poll<T>(label: string, read: () => Promise<T | null>): Promise<T> {
    const deadline = Date.now() + POLL_BUDGET_MS;
    while (Date.now() < deadline) {
      this.throwIfWorkerFailed();
      const value = await read();
      if (value !== null) return value;
      await delay(25);
    }
    this.throwIfWorkerFailed();
    throw new Error(`Timed out waiting for ${label}`);
  }
}

async function runWorkerChild(): Promise<void> {
  const env = parseEnv(process.env);
  const mcpConfigService = new McpConfigService({
    agentsConfigPath: env.AGENTS_CONFIG_PATH,
    processEnv: process.env,
  });
  const agentRegistry = loadAgentRegistry(env.AGENTS_CONFIG_PATH, {
    profileResolver: (profiles) => mcpConfigService.resolveProfiles(profiles),
  });
  const runnerArtifactHash = await hashArtifactSet(env.SOUL_RUNNER_ARTIFACT_DIR!);
  const sourceCommit = createHash("sha1").update(runnerArtifactHash).digest("hex");
  const releaseActivationState = new ReleaseActivationState(buildReleaseManifest({
    sourceCommit,
    hostBundleHash: "full-slice-test-host-bundle",
    runnerReleaseId: runnerArtifactHash,
    runnerArtifactHash,
    schemaGeneration: "full-schema-test",
    wireGeneration: "full-slice-test",
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    deploymentEnvIdentity: "full-slice-test-env",
    claudeExecutable: { kind: "claude", path: null, identity: null },
    codexExecutable: { kind: "codex", path: null, identity: null },
  }));
  const recoveryReadyPath = join(
    requireString(process.env.RUNNER_E2E_CONTROL_DIR, "RUNNER_E2E_CONTROL_DIR"),
    `worker-recovery-ready-${process.pid}`,
  );
  await startWorkerRuntime({
    compose: async () => await composeWorkerRuntime({
      env,
      logger: silentLogger,
      agentRegistry,
      mcpConfigService,
      releaseActivationState,
    }),
    listen: async (runtime) => {
      await startServer(runtime.server, env.HOST, env.PORT);
    },
    logger: {
      info: ((message: unknown) => {
        if (message === "Runner recovery initial scan completed") {
          void writeFile(recoveryReadyPath, "ready\n");
        }
      }) as typeof silentLogger.info,
    },
    onUpstreamFailure: (error) => {
      console.error(error);
      process.exit(1);
    },
    onRunnerRecoveryFailure: (error) => {
      console.error(error);
      process.exit(1);
    },
  });
  await new Promise<never>(() => undefined);
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("ephemeral port unavailable");
  await new Promise<void>((resolve, reject) => server.close((error) =>
    error ? reject(error) : resolve()
  ));
  return address.port;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} missing`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringField(value: Record<string, unknown> | null, key: string): string | null {
  return value && typeof value[key] === "string" ? value[key] : null;
}

function withoutAnthropicApiKey(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { ANTHROPIC_API_KEY: _forbidden, ...rest } = env;
  return rest;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (process.argv.includes(WORKER_ROLE)) {
  await runWorkerChild();
}

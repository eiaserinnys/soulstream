import type {
  SessionKey,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, chmod, mkdir, mkdtemp, open, readFile, readdir, rm, watch, writeFile } from
  "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import { parseEnv } from "../../src/config.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { IdempotentClaudeSessionStore } from
  "../../src/engine/claude_session_store.js";
import type { ClaudeClientEvent } from "../../src/engine/claude_event_mapper.js";
import type { EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import { McpConfigService } from "../../src/mcp_config_service.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import { RunnerProcessSpawner } from "../../src/runner/runner_process_spawn.js";
import { readRunnerRegistrationSummary } from
  "../../src/runner/runner_process_registry.js";
import { composeRunnerProcessRuntime } from
  "../../src/runtime/runner_process_composition.js";
import { ClaudeBackgroundTaskLifecycle } from
  "../../src/task/claude_background_task_lifecycle.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import {
  CLAUDE_RUNTIME_FOLLOWUP_RETRY_DELAY_MS,
  MAX_CLAUDE_RUNTIME_FOLLOWUP_ATTEMPT,
} from "../../src/task/claude_runtime_followup_fallback.js";
import type { Task } from "../../src/task/task_models.js";
import { EventOutboxPump, type EventOutboxPumpStore } from
  "../../src/upstream/event_outbox_pump.js";
import { EventOutboxPumpMux } from "../../src/upstream/event_outbox_pump_mux.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import { makeEventPersistenceTestDouble } from
  "../task/event_persistence_test_double.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(testDirectory, "../..");
const runnerEntryPath = resolve(packageDirectory, "src/runner/runner_entry.ts");
const requireFromTest = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const liveEnabled = process.env.SOULSTREAM_CLAUDE_BACKGROUND_LIVE_E2E === "1";
const oracleMutation = process.env.SOULSTREAM_A_ORACLE_MUTATION;
const diagnosticTerminationMode = process.env.SOULSTREAM_A_TERMINATION_MODE === "direct_sigkill"
  ? "direct_sigkill"
  : "graceful_terminate";

type TerminationMode = "graceful_terminate" | "direct_sigkill";
type TerminalEvent = Extract<
  ClaudeClientEvent,
  { type: "claude_runtime_task_notification" }
>;

interface SpawnIdentity {
  pid: number;
  pgid: number;
}

interface LifetimeEvidence {
  terminationMode: TerminationMode;
  firstRunnerPid: number;
  replacementRunnerPid: number;
  originalTaskId: string;
  originalToolUseId: string;
  originalOutputFile: string;
  originalProcessSurvived: boolean;
  originalProgressContinued: boolean;
  originalProgressMarkers: string[];
  spawnIdentities: SpawnIdentity[];
  originalTerminalMarkers: string[];
  originalTerminals: TerminalEvent[];
  originalNotificationCandidates: TerminalEvent[];
  restartTerminalizations: Array<{
    status: string;
    closeReason: string;
    taskId: string;
  }>;
  retryHorizonMs: number;
  retryHorizonBefore: RetryHorizonSnapshot;
  retryHorizonAfter: RetryHorizonSnapshot;
}

interface RetryHorizonSnapshot {
  spawns: number;
  originalTerminals: number;
  originalNotificationCandidates: number;
}

interface LifetimeMatrixEvidence {
  graceful: LifetimeEvidence;
  ungraceful: LifetimeEvidence;
}

describe.runIf(liveEnabled)("Claude background task runner lifetime contract", () => {
  let evidence: LifetimeMatrixEvidence;
  const cleanupRoots: string[] = [];
  const cleanupPids = new Set<number>();
  const releaseHostOwnership: Array<() => Promise<void>> = [];
  const closeMarkerChannels: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    const options = {
      cleanupRoots,
      cleanupPids,
      setReleaseHostOwnership(release) {
        releaseHostOwnership.push(release);
      },
      setCloseMarkerChannel(close) {
        closeMarkerChannels.push(close);
      },
    };
    if (process.env.SOULSTREAM_A_DIAG_ONLY === "1") {
      await runLifetimeScenario(options, diagnosticTerminationMode);
      throw new Error("A diagnostic scenario returned without its process table");
    }
    evidence = {
      graceful: await runLifetimeScenario(options, "graceful_terminate"),
      ungraceful: await runLifetimeScenario(options, "direct_sigkill"),
    };
  }, 180_000);

  afterAll(async () => {
    const ownedPids = [...cleanupPids];
    const ownedRoots = [...cleanupRoots];
    for (const pid of ownedPids) killIfAlive(pid);
    await Promise.all(ownedPids.map(async (pid) => {
      await waitForProcessExit(pid).catch(() => undefined);
    }));
    await Promise.all(closeMarkerChannels.map(async (close) => {
      await close().catch(() => undefined);
    }));
    await Promise.all(releaseHostOwnership.map(async (release) => {
      await release().catch(() => undefined);
    }));
    await Promise.all(cleanupRoots.splice(0).map(
      async (root) => {
        await makeReleaseTreeRemovable(root);
        await rm(root, { recursive: true, force: true });
      },
    ));
    expect(
      ownedPids.filter(isPidAlive),
      "harness-owned runner/background processes survived cleanup",
    ).toEqual([]);
    const survivingRoots: string[] = [];
    for (const root of ownedRoots) {
      try {
        await access(root);
        survivingRoots.push(root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    expect(survivingRoots, "harness-created temporary roots survived cleanup").toEqual([]);
  });

  it("keeps a graceful runner shutdown from killing its background process", () => {
    const graceful = evidence.graceful;
    const survived = oracleMutation === "hide_process_death"
      ? true
      : graceful.originalProcessSurvived;
    const progressed = oracleMutation === "hide_process_death"
      ? true
      : graceful.originalProgressContinued;
    const progressMarkers = oracleMutation === "hide_process_death"
      ? Array.from(
          { length: 8 },
          (_, index) => `${graceful.spawnIdentities[0]?.pid}:step-${index + 1}`,
        )
      : graceful.originalProgressMarkers;

    expect(graceful.firstRunnerPid).toBeGreaterThan(0);
    expect(graceful.replacementRunnerPid).not.toBe(graceful.firstRunnerPid);
    expect(graceful.spawnIdentities[0]?.pgid).toBeGreaterThan(0);
    expect(graceful.originalOutputFile).not.toBe("");
    expect(
      survived,
      "the original PID died with its ephemeral runner generation",
    ).toBe(true);
    expect(
      progressed,
      "the original PID stopped advancing its side-effect sequence",
    ).toBe(true);
    expect(progressMarkers).toEqual(Array.from(
      { length: 8 },
      (_, index) => `${graceful.spawnIdentities[0]?.pid}:step-${index + 1}`,
    ));
  });

  it("does not report a surviving ungraceful background process as killed", () => {
    const ungraceful = evidence.ungraceful;
    expect(ungraceful.originalProcessSurvived).toBe(true);
    expect(ungraceful.originalProgressContinued).toBe(true);
    const terminalizations = oracleMutation === "hide_process_death"
      ? []
      : ungraceful.restartTerminalizations;
    expect(
      terminalizations,
      "restart policy reported killed while the background PID was still alive",
    ).toEqual([]);
  });

  it("does not replay either semantic task in a replacement runner", () => {
    const identities = Object.fromEntries(
      Object.entries(evidence).map(([mode, observed]) => [
        mode,
        oracleMutation === "hide_duplicate_spawn"
          ? observed.spawnIdentities.slice(0, 1)
          : observed.spawnIdentities,
      ]),
    );

    expect(
      identities,
      "runner recovery replayed an externally visible background command",
    ).toEqual({
      graceful: [evidence.graceful.spawnIdentities[0]],
      ungraceful: [evidence.ungraceful.spawnIdentities[0]],
    });
  });

  it("emits one completed terminal and one notification candidate per original task", () => {
    const expected = Object.fromEntries(Object.entries(evidence).map(([mode, observed]) => {
      const terminal = {
        type: "claude_runtime_task_notification",
        taskId: observed.originalTaskId,
        toolUseId: observed.originalToolUseId,
        status: "completed",
        outputFile: observed.originalOutputFile,
      };
      return [mode, {
        terminals: [terminal],
        notifications: [terminal],
        markers: [`${observed.spawnIdentities[0]?.pid}:terminal-ok`],
      }];
    }));
    const actual = oracleMutation === "hide_missing_terminal"
      ? expected
      : Object.fromEntries(Object.entries(evidence).map(([mode, observed]) => [
          mode,
          {
            terminals: observed.originalTerminals
              .filter((event) => event.status === "completed")
              .map(terminalIdentity),
            notifications: observed.originalNotificationCandidates
              .filter((event) => event.status === "completed")
              .map(terminalIdentity),
            markers: observed.originalTerminalMarkers,
          },
        ]));
    expect(actual).toEqual(expected);
  });

  it("still reports killed when the graceful background process is proven dead", () => {
    const graceful = evidence.graceful;
    expect(graceful.originalProcessSurvived).toBe(false);
    expect(graceful.restartTerminalizations).toEqual([
      expect.objectContaining({
      status: "killed",
      closeReason: "worker_restart",
        taskId: graceful.originalTaskId,
      }),
    ]);
  });

  it("does not add another spawn, terminal, or notification through the retry horizon", () => {
    const configuredHorizonMs = Object.values(CLAUDE_RUNTIME_FOLLOWUP_RETRY_DELAY_MS)
      .reduce((total, delayMs) => total + delayMs, 0);
    expect(MAX_CLAUDE_RUNTIME_FOLLOWUP_ATTEMPT).toBe(3);
    for (const observed of Object.values(evidence)) {
      expect(observed.retryHorizonMs, observed.terminationMode).toBe(configuredHorizonMs);
      expect(observed.retryHorizonAfter, observed.terminationMode).toEqual(
        observed.retryHorizonBefore,
      );
    }
  });
});

async function runLifetimeScenario(options: {
  cleanupRoots: string[];
  cleanupPids: Set<number>;
  setReleaseHostOwnership(release: () => Promise<void>): void;
  setCloseMarkerChannel(close: () => Promise<void>): void;
}, terminationMode: TerminationMode): Promise<LifetimeEvidence> {
  const stage = (name: string) => {
    if (process.env.SOULSTREAM_A_DEBUG === "1") console.error(`[A-RED-STAGE] ${name}`);
  };
  stage("create-root");
  const root = await mkdtemp(join(tmpdir(), "claude-background-runner-lifetime-"));
  options.cleanupRoots.push(root);
  const stateDirectory = join(root, "state");
  const artifactDirectory = join(root, "artifacts");
  const releasesDirectory = join(root, "runner-releases");
  const workspaceDirectory = join(root, "workspace");
  await mkdir(artifactDirectory, { recursive: true });
  await mkdir(workspaceDirectory, { recursive: true });
  const eventFifo = join(workspaceDirectory, "marker-events.fifo");
  const gateFifo = join(workspaceDirectory, "marker-gate.fifo");
  await execFileAsync("mkfifo", [eventFifo, gateFifo]);
  const markerChannel = await MarkerChannel.open(eventFifo);
  stage("marker-channel-open");
  let gateWriter: Awaited<ReturnType<typeof open>> | undefined;
  options.setCloseMarkerChannel(async () => {
    await gateWriter?.close().catch(() => undefined);
    await markerChannel.close();
  });
  await writeFile(join(artifactDirectory, "package.json"), '{"type":"module"}\n');
  await writeFile(
    join(artifactDirectory, "runner_entry.js"),
    `await import(${JSON.stringify(pathToFileURL(requireFromTest.resolve("tsx")).href)});\n`
      + `await import(${JSON.stringify(pathToFileURL(runnerEntryPath).href)});\n`,
  );
  const agentsConfigPath = join(root, "agents.yaml");
  const registryPath = join(root, "mcp-registry.yaml");
  const profilesPath = join(root, "mcp-profiles.yaml");
  await writeFile(agentsConfigPath, "agents: []\n");
  await writeFile(registryPath, "servers: []\n");
  await writeFile(profilesPath, "profiles:\n  - id: a-red\n    mcp_servers: []\n");
  const mcpConfigService = new McpConfigService({
    agentsConfigPath,
    registryPath,
    profilesPath,
  });
  const env = parseEnv({
    SOULSTREAM_NODE_ID: "a-red-node",
    SOULSTREAM_UPSTREAM_URL: "ws://127.0.0.1:1/ws/node",
    EVENT_OUTBOX_DIR: join(root, "legacy-outbox"),
    SOUL_RUNNER_PROCESS_ENABLED: "true",
    SOUL_RUNNER_STATE_DIR: stateDirectory,
    SOUL_RUNNER_ARTIFACT_DIR: artifactDirectory,
    SOUL_RUNNER_RELEASES_DIR: releasesDirectory,
    SOUL_RUNNER_LEASE_TIMEOUT_MS: "90000",
    CLAUDE_SESSION_RUNTIME_V2_ENABLED: "true",
    CLAUDE_SESSION_RUNTIME_IDLE_TTL_MS: "60000",
    MCP_ENABLED: "false",
  });
  const observed: ClaudeClientEvent[] = [];
  const detached: ClaudeClientEvent[] = [];
  const persisted: SSEEventPayload[] = [];
  const observedProbe = new EvidenceProbe<ClaudeClientEvent>();
  const persistedProbe = new EvidenceProbe<SSEEventPayload>();
  const mux = acceptingPumpMux();
  const sessionStore = memorySessionStore();
  const composition = await composeRunnerProcessRuntime(true, {
    env,
    logger: pino({ level: "silent" }),
    pumpMux: mux,
    sessionStore,
    mcpConfigService,
    observeClaudeRuntime: async (_sessionId, event) => {
      const copy = structuredClone(event);
      observed.push(copy);
      observedProbe.push(copy);
      return true;
    },
    publishDetachedClaudeEvent: async (_sessionId, event) => {
      const copy = structuredClone(event);
      detached.push(copy);
    },
    buildChildProcessEnv: () => ({
      ...process.env,
      NODE_OPTIONS: `--import ${pathToFileURL(requireFromTest.resolve("tsx")).href}`,
    }),
  });
  if (!composition) throw new Error("runner process composition unexpectedly disabled");
  stage("runner-composed");
  options.setReleaseHostOwnership(async () => await composition.hostOwnership.release());

  const sessionId = "session-a-background-lifetime";
  const task = makeTask(sessionId, markerPrompt(workspaceDirectory, eventFifo, gateFifo));
  const agent = makeAgent(workspaceDirectory);
  const firstHost = makeExecutor(composition.runtimeFactory, persisted, persistedProbe);
  firstHost.startExecution(task, agent);
  stage("initial-execution-started");
  const firstExecution = task.executionPromise;
  if (!firstExecution) throw new Error("initial runner execution was not created");
  void firstExecution.catch(() => undefined);
  const paths = runnerProcessPaths(stateDirectory, sessionId);
  await mkdir(paths.sessionDirectory, { recursive: true });
  await waitForPath(paths.pidPath);
  stage("initial-runner-pid");
  const firstRunnerPid = Number.parseInt((await readFile(paths.pidPath, "utf8")).trim(), 10);
  const firstRunnerPgid = await readProcessGroupId(firstRunnerPid);
  options.cleanupPids.add(firstRunnerPid);
  const started = await observedProbe.next(isStarted);
  stage("initial-task-started");
  const firstSpawn = await markerChannel.next((event) => event.kind === "spawn");
  stage("initial-process-spawned");
  const firstIdentity = firstSpawn.identity;
  if (!firstIdentity) throw new Error("background marker did not publish process identity");
  options.cleanupPids.add(firstIdentity.pid);
  gateWriter = await withTimeout(open(gateFifo, "w"), 5_000);
  stage("gate-writer-open");
  const toolResult = await persistedProbe.next((event) =>
    event.type === "tool_result" && JSON.stringify(event).includes(started.taskId)
  );
  const originalOutputFile = outputFileFromPersisted([toolResult], started.taskId);
  stage("initial-output-fixed");

  await releaseGate(gateWriter);
  await markerChannel.next(isStep(firstIdentity.pid, 1));
  await releaseGate(gateWriter);
  await markerChannel.next(isStep(firstIdentity.pid, 2));
  stage("checkpoint-two");

  const runningRegistration = await readRunnerRegistrationSummary(paths.sessionDirectory);
  if (!runningRegistration.pidStartIdentity) {
    throw new Error("running registration omitted its process start identity");
  }
  if (terminationMode === "direct_sigkill") {
    process.kill(firstRunnerPid, "SIGKILL");
    await waitForProcessExit(firstRunnerPid);
  } else {
    await new RunnerProcessSpawner().terminate(paths, {
      pid: firstRunnerPid,
      startIdentity: runningRegistration.pidStartIdentity,
    });
  }
  stage("runner-killed");
  const backgroundExitedAfterRunner = terminationMode === "graceful_terminate"
    ? await withTimeout(waitForProcessExit(firstIdentity.pid), 5_000)
      .then(() => true)
      .catch(() => false)
    : !isPidAlive(firstIdentity.pid);
  const gateThreeReleased = await releaseGate(gateWriter);
  const stepThree = gateThreeReleased
    ? await markerChannel.next(isStep(firstIdentity.pid, 3), 2_000).catch(() => null)
    : null;
  const originalProcessSurvived =
    !backgroundExitedAfterRunner && gateThreeReleased && isPidAlive(firstIdentity.pid);
  const originalProgressContinued = stepThree !== null;
  stage(`post-kill-step:${originalProgressContinued}`);
  if (process.env.SOULSTREAM_A_DIAG_ONLY === "1") {
    const table = {
      runner: {
        pid: firstRunnerPid,
        pgid: firstRunnerPgid,
        killTarget: firstRunnerPid,
        signalSent: terminationMode === "direct_sigkill"
          ? "SIGKILL via process.kill(runnerPid)"
          : "SIGTERM via RunnerProcessSpawner.terminate",
        shutdownHandlerExpected: terminationMode === "graceful_terminate",
        observedExited: !isPidAlive(firstRunnerPid),
      },
      background: {
        pid: firstIdentity.pid,
        pgid: firstIdentity.pgid,
        killTarget: null,
        signalSent: "none directly; runner shutdown closed the Claude Query",
        observedExited: !isPidAlive(firstIdentity.pid),
        gate3Accepted: gateThreeReleased,
        markerAdvancedAfterRunnerExit: originalProgressContinued,
      },
    };
    throw new Error(`[A-PROCESS-TABLE] ${JSON.stringify(table)}`);
  }
  const restartTerminalizations = await observeRestartTerminalizations({
    sessionId,
    taskId: started.taskId,
    toolUseId: started.toolUseId ?? "",
    outputFile: originalOutputFile,
    processId: firstIdentity.pid,
    processAlive: originalProcessSurvived,
  });
  if (originalProcessSurvived && originalProgressContinued) {
    for (let index = 3; index < 8; index += 1) {
      await releaseGate(gateWriter);
      await markerChannel.next(isStep(firstIdentity.pid, index + 1));
    }
    await markerChannel.next((event) =>
      event.kind === "terminal" && event.identity.pid === firstIdentity.pid
    );
  }

  await task.runner?.dispatcher.detachHost().catch(() => undefined);
  await withTimeout(firstExecution.catch(() => undefined), 1_000).catch(() => undefined);
  stage("registration-read");
  const recoveredTask = makeTask(sessionId, task.prompt);
  recoveredTask.codexThreadId = task.codexThreadId;
  const replacementHost = makeExecutor(composition.runtimeFactory, persisted, persistedProbe);
  replacementHost.restartRegisteredRunner(recoveredTask, runningRegistration.config);
  stage("replacement-started");
  const replacementExecution = recoveredTask.executionPromise;
  if (!replacementExecution) throw new Error("replacement runner execution was not created");
  void replacementExecution.catch(() => undefined);
  const replacementRunnerPid = await waitForDifferentPid(paths.pidPath, firstRunnerPid);
  stage("replacement-runner-pid");
  options.cleanupPids.add(replacementRunnerPid);
  const replacementSpawn = await markerChannel.next((event) =>
    event.kind === "spawn" && event.identity.pid !== firstIdentity.pid
  );
  stage("replacement-process-spawned");
  options.cleanupPids.add(replacementSpawn.identity.pid);
  await markerChannel.next((event) =>
    event.kind === "duplicate" && event.identity.pid === replacementSpawn.identity.pid
  );
  await markerChannel.next((event) =>
    event.kind === "terminal" && event.identity.pid === replacementSpawn.identity.pid
  );
  await observedProbe.next((event) =>
    isTerminal(event) && event.taskId !== started.taskId
  );
  stage("replacement-terminal-observed");
  await withTimeout(replacementExecution.catch(() => undefined), 20_000);
  await recoveredTask.runner?.dispatcher.close().catch(() => undefined);
  stage("replacement-closed");

  const retryHorizonBefore = {
    spawns: (await readSpawnIdentities(workspaceDirectory)).length,
    originalTerminals: observed.filter((event) =>
      isTerminal(event) && event.taskId === started.taskId
    ).length,
    originalNotificationCandidates: detached.filter((event) =>
      isTerminal(event) && event.taskId === started.taskId
    ).length,
  };
  let retryHorizonMs = 0;
  for (
    let attempt = 2;
    attempt <= MAX_CLAUDE_RUNTIME_FOLLOWUP_ATTEMPT;
    attempt += 1
  ) {
    const delayMs = CLAUDE_RUNTIME_FOLLOWUP_RETRY_DELAY_MS[attempt];
    if (delayMs === undefined) {
      throw new Error(`missing retry horizon delay for attempt ${attempt}`);
    }
    retryHorizonMs += delayMs;
    await drainEventLoop();
  }
  stage("retry-horizon-drained");
  const retryHorizonAfter = {
    spawns: (await readSpawnIdentities(workspaceDirectory)).length,
    originalTerminals: observed.filter((event) =>
      isTerminal(event) && event.taskId === started.taskId
    ).length,
    originalNotificationCandidates: detached.filter((event) =>
      isTerminal(event) && event.taskId === started.taskId
    ).length,
  };

  const originalTerminals = observed.filter((event) =>
    isTerminal(event) && event.taskId === started.taskId
  );
  const originalNotificationCandidates = detached.filter((event) =>
    isTerminal(event) && event.taskId === started.taskId
  );
  const spawnIdentities = await readSpawnIdentities(workspaceDirectory);
  const originalProgressMarkers = (await readLines(join(workspaceDirectory, "progress.log")))
    .filter((line) => line.startsWith(`${firstIdentity.pid}:step-`));
  const originalTerminalMarkers = (await readLines(join(workspaceDirectory, "terminal.log")))
    .filter((line) => line.startsWith(`${firstIdentity.pid}:`));

  return {
    terminationMode,
    firstRunnerPid,
    replacementRunnerPid,
    originalTaskId: started.taskId,
    originalToolUseId: started.toolUseId ?? "",
    originalOutputFile,
    originalProcessSurvived,
    originalProgressContinued,
    originalProgressMarkers,
    spawnIdentities,
    originalTerminalMarkers,
    originalTerminals,
    originalNotificationCandidates,
    restartTerminalizations,
    retryHorizonMs,
    retryHorizonBefore,
    retryHorizonAfter,
  };
}

async function observeRestartTerminalizations(input: {
  sessionId: string;
  taskId: string;
  toolUseId: string;
  outputFile: string;
  processId: number;
  processAlive: boolean;
}): Promise<LifetimeEvidence["restartTerminalizations"]> {
  const terminalizations: LifetimeEvidence["restartTerminalizations"] = [];
  const terminalize = vi.fn(async (terminalization: {
    status: string;
    closeReason: string;
    taskId: string;
    terminalRevision: string;
  }) => {
    terminalizations.push({
      status: terminalization.status,
      closeReason: terminalization.closeReason,
      taskId: terminalization.taskId,
    });
    return {
      accepted: true,
      delivery: {
        delivery_id: `delivery:${input.taskId}`,
        completion_id: `completion:${input.taskId}`,
        relation_key: `claude_runtime:${input.sessionId}:${input.taskId}`,
        producer_terminal_revision: terminalization.terminalRevision,
        created_at: new Date("2026-08-25T00:00:00.000Z"),
        source: "claude_runtime_task_followup",
        payload: { text: "killed", user: "system" },
        payload_hash: `hash:${input.taskId}`,
      },
    };
  });
  const lifecycle = new ClaudeBackgroundTaskLifecycle({
    repository: {
      activeForNode: vi.fn()
        .mockResolvedValueOnce([{
          source_node: "a-red-node",
          session_id: input.sessionId,
          task_id: input.taskId,
          sdk_session_id: "sdk-a-red",
          status: "running",
          description: `process ${input.processId} alive=${input.processAlive}`,
          summary: null,
          output_file: input.outputFile,
          tool_use_id: input.toolUseId,
        }])
        .mockResolvedValueOnce([]),
      terminalize,
    } as never,
    sourceNode: "a-red-node",
    now: () => new Date("2026-08-25T00:00:00.000Z"),
  });
  await lifecycle.recoverAfterRestart();
  return terminalizations;
}

function markerPrompt(
  workspaceDirectory: string,
  eventFifo: string,
  gateFifo: string,
): string {
  const spawn = join(workspaceDirectory, "spawn.log");
  const progress = join(workspaceDirectory, "progress.log");
  const terminal = join(workspaceDirectory, "terminal.log");
  return [
    "On every turn that receives this instruction, use the Bash tool exactly once with run_in_background=true.",
    "Do so in this turn even if the resumed transcript shows a Bash call from an earlier runner generation; never answer before starting this turn's Bash call.",
    "The Bash command must invoke python3 and implement this exact finite marker protocol:",
    `open ${eventFifo} once for line-buffered writes;`,
    `read any existing non-empty lines from ${spawn}, then append one line PID|PGID for itself and emit spawn|PID|PGID;`,
    `if a prior spawn line existed, append PID:duplicate to ${progress}, emit duplicate|PID|PGID, append PID:terminal-ok to ${terminal}, emit terminal|PID|PGID, and exit 0;`,
    `otherwise open ${gateFifo} once for line-buffered reads, then for N=1 through 8 block on one input line, append PID:step-N to ${progress}, and emit step|PID|PGID|N;`,
    `after gate 8 append PID:terminal-ok to ${terminal}, emit terminal|PID|PGID, and exit 0.`,
    "Flush the event FIFO after every emitted line. Do not use sleep, timeout, or a polling loop.",
    "Do not use another tool and do not call TaskOutput.",
    "As soon as Bash returns the background task ID, answer exactly STARTED followed by that ID.",
  ].join(" ");
}

function makeTask(agentSessionId: string, prompt: string): Task {
  return {
    agentSessionId,
    prompt,
    status: "running",
    profileId: "a-red-agent",
    model: "fable",
    reasoningEffort: "low",
    allowedTools: ["Bash"],
    claudePermissionMode: "bypassPermissions",
    createdAt: new Date(),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

function makeAgent(workspaceDirectory: string): AgentProfile {
  return {
    id: "a-red-agent",
    name: "A RED Agent",
    backend: "claude",
    workspace_dir: workspaceDirectory,
    mcp_profile: "a-red",
  };
}

function makeExecutor(
  runtimeFactory: NonNullable<Awaited<ReturnType<typeof composeRunnerProcessRuntime>>>["runtimeFactory"],
  persisted: SSEEventPayload[],
  persistedProbe: EvidenceProbe<SSEEventPayload>,
): TaskExecutor {
  const persistence = makeEventPersistenceTestDouble(async (_sessionId, event, task) => {
    const copy = structuredClone(event);
    persisted.push(copy);
    persistedProbe.push(copy);
    if (event.type === "assistant_message" && typeof event.content === "string") {
      task.lastAssistantText = event.content;
    }
  });
  const db = {
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
  return new TaskExecutor(
    unusedEngine,
    db,
    persistence.persistence,
    broadcaster,
    pino({ level: "silent" }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    runtimeFactory,
  );
}

function memorySessionStore(): IdempotentClaudeSessionStore {
  const entries = new Map<string, SessionStoreEntry[]>();
  const key = (value: SessionKey) => JSON.stringify(value);
  return {
    async append(value, appended) {
      entries.set(key(value), [...(entries.get(key(value)) ?? []), ...appended]);
    },
    async appendIdempotent(value, appended) {
      entries.set(key(value), [...(entries.get(key(value)) ?? []), ...appended]);
    },
    async load(value) {
      return entries.get(key(value)) ?? null;
    },
    async listSessions() {
      return [];
    },
    async delete(value) {
      entries.delete(key(value));
    },
    async deleteIdempotent(value) {
      entries.delete(key(value));
    },
    async listSubkeys() {
      return [];
    },
  };
}

function acceptingPumpMux(): EventOutboxPumpMux {
  const mux = new EventOutboxPumpMux(new EventOutboxPump(emptyPumpStore(), vi.fn()));
  mux.connect(async (batch) => {
    await mux.handleAck({
      type: "event_append_ack",
      stream_id: batch.stream_id,
      acked_through: batch.events.at(-1)!.source_seq,
      events: batch.events.map((event) => ({
        source_seq: event.source_seq,
        event_id: 30_000 + event.source_seq,
      })),
    });
  });
  return mux;
}

function emptyPumpStore(): EventOutboxPumpStore {
  return {
    streamId: "a-red-primary",
    ackedSeq: 0,
    onAppend: () => () => {},
    readBatch: async () => null,
    acknowledge: async () => {},
  };
}

function isStarted(event: ClaudeClientEvent): event is Extract<
  ClaudeClientEvent,
  { type: "claude_runtime_task_started" }
> {
  return event.type === "claude_runtime_task_started";
}

function isTerminal(event: ClaudeClientEvent): event is Extract<
  ClaudeClientEvent,
  { type: "claude_runtime_task_notification" }
> {
  return event.type === "claude_runtime_task_notification";
}

function terminalIdentity(event: TerminalEvent): {
  type: TerminalEvent["type"];
  taskId: string;
  toolUseId: string | undefined;
  status: string;
  outputFile: string | undefined;
} {
  return {
    type: event.type,
    taskId: event.taskId,
    toolUseId: event.toolUseId,
    status: event.status,
    outputFile: event.outputFile,
  };
}

function outputFileFromPersisted(events: SSEEventPayload[], taskId: string): string {
  for (const event of events) {
    if (event.type !== "tool_result") continue;
    const serialized = JSON.stringify(event);
    if (!serialized.includes(taskId)) continue;
    const match = serialized.match(/Output is being written to: ([^\\s"\\]+)/);
    if (match?.[1]) return match[1];
  }
  throw new Error(`background output path was not persisted for ${taskId}`);
}

async function readSpawnIdentities(workspaceDirectory: string): Promise<SpawnIdentity[]> {
  return (await readLines(join(workspaceDirectory, "spawn.log"))).map((line) => {
    const [pid, pgid] = line.split("|").map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(pgid)) {
      throw new Error(`invalid spawn identity: ${line}`);
    }
    return { pid, pgid };
  });
}

async function readLines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function makeReleaseTreeRemovable(root: string): Promise<void> {
  const releases = join(root, "runner-releases");
  await chmod(releases, 0o755).catch(() => undefined);
  const entries = await readdir(releases).catch(() => [] as string[]);
  await Promise.all(entries.map(async (entry) => {
    await chmod(join(releases, entry), 0o755).catch(() => undefined);
  }));
}

async function readPidIfExists(path: string): Promise<number | null> {
  try {
    return Number.parseInt((await readFile(path, "utf8")).trim(), 10);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function waitForPath(path: string): Promise<void> {
  try {
    await access(path);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const controller = new AbortController();
  const watcher = watch(dirname(path), { signal: controller.signal });
  try {
    try {
      await access(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for await (const event of watcher) {
      if (event.filename !== null && event.filename !== basename(path)) continue;
      try {
        await access(path);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } finally {
    controller.abort();
  }
  throw new Error(`file watch ended before path appeared: ${path}`);
}

async function waitForDifferentPid(path: string, previousPid: number): Promise<number> {
  const current = await readPidIfExists(path);
  if (current !== null && current !== previousPid) return current;
  const controller = new AbortController();
  const watcher = watch(dirname(path), { signal: controller.signal });
  try {
    const afterWatch = await readPidIfExists(path);
    if (afterWatch !== null && afterWatch !== previousPid) return afterWatch;
    for await (const event of watcher) {
      if (event.filename !== null && event.filename !== basename(path)) continue;
      const candidate = await readPidIfExists(path);
      if (candidate !== null && candidate !== previousPid) return candidate;
    }
  } finally {
    controller.abort();
  }
  throw new Error(`runner pid watch ended without replacement: ${path}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  if (!isPidAlive(pid)) return;
  await withTimeout(execFileAsync("tail", ["--pid", String(pid), "-f", "/dev/null"]), 5_000);
}

async function readProcessGroupId(pid: number): Promise<number> {
  const { stdout } = await execFileAsync("ps", ["-o", "pgid=", "-p", String(pid)]);
  const pgid = Number(stdout.trim());
  if (!Number.isInteger(pgid) || pgid <= 0) {
    throw new Error(`runner process group unavailable: ${pid}`);
  }
  return pgid;
}

async function releaseGate(
  writer: Awaited<ReturnType<typeof open>>,
): Promise<boolean> {
  try {
    await writer.write("next\n");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPIPE") return false;
    throw error;
  }
}

function isStep(pid: number, step: number): (event: MarkerEvent) => boolean {
  return (event) =>
    event.kind === "step" && event.identity.pid === pid && event.step === step;
}

async function drainEventLoop(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
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
    // Process already exited.
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`evidence timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface MarkerEvent {
  kind: "spawn" | "step" | "duplicate" | "terminal";
  identity: SpawnIdentity;
  step?: number;
}

class MarkerChannel {
  private readonly probe = new EvidenceProbe<MarkerEvent>();

  private constructor(
    private readonly anchor: Awaited<ReturnType<typeof open>>,
    private readonly stream: ReturnType<typeof createReadStream>,
    private readonly lines: ReturnType<typeof createInterface>,
  ) {
    this.lines.on("line", (line) => this.probe.push(parseMarkerEvent(line)));
  }

  static async open(path: string): Promise<MarkerChannel> {
    const anchor = await open(path, "r+");
    const stream = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    return new MarkerChannel(anchor, stream, lines);
  }

  async next(
    predicate: (event: MarkerEvent) => boolean,
    timeoutMs = 30_000,
  ): Promise<MarkerEvent> {
    return await this.probe.next(predicate, timeoutMs);
  }

  async close(): Promise<void> {
    this.lines.close();
    this.stream.destroy();
    await this.anchor.close();
  }
}

class EvidenceProbe<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    predicate(value: T): boolean;
    resolve(value: T): void;
  }> = [];

  push(value: T): void {
    const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(value));
    if (waiterIndex < 0) {
      this.values.push(value);
      return;
    }
    const [waiter] = this.waiters.splice(waiterIndex, 1);
    waiter!.resolve(value);
  }

  async next(predicate: (value: T) => boolean, timeoutMs = 45_000): Promise<T> {
    const valueIndex = this.values.findIndex(predicate);
    if (valueIndex >= 0) return this.values.splice(valueIndex, 1)[0]!;
    return await withTimeout(new Promise<T>((resolveValue) => {
      this.waiters.push({ predicate, resolve: resolveValue });
    }), timeoutMs);
  }
}

function parseMarkerEvent(line: string): MarkerEvent {
  const [kind, rawPid, rawPgid, rawStep] = line.split("|");
  const pid = Number(rawPid);
  const pgid = Number(rawPgid);
  if (
    (kind !== "spawn" && kind !== "step" && kind !== "duplicate" && kind !== "terminal")
    || !Number.isInteger(pid)
    || !Number.isInteger(pgid)
  ) {
    throw new Error(`invalid marker event: ${line}`);
  }
  const step = rawStep === undefined ? undefined : Number(rawStep);
  if (kind === "step" && !Number.isInteger(step)) {
    throw new Error(`invalid marker step: ${line}`);
  }
  return {
    kind,
    identity: { pid, pgid },
    ...(step === undefined ? {} : { step }),
  };
}

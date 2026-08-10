import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import { parseEnv } from "../../src/config.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { EnginePort } from "../../src/engine/protocol.js";
import { RunnerProcessDispatcher } from "../../src/runner/runner_process_dispatcher.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import { parseRunnerChildConfig } from "../../src/runner/runner_process_spawn.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import { composeRunnerProcessRuntime } from "../../src/runtime/runner_process_composition.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { Task } from "../../src/task/task_models.js";
import type { EventOutboxBatch } from "../../src/upstream/event_outbox.js";
import {
  EventOutboxPump,
  type EventOutboxPumpStore,
} from "../../src/upstream/event_outbox_pump.js";
import { EventOutboxPumpMux } from "../../src/upstream/event_outbox_pump_mux.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import { makeEventPersistenceTestDouble } from "../task/event_persistence_test_double.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(testDirectory, "../..");
const childFixturePath = join(testDirectory, "fixtures/runner_process_e2e_child.ts");
const requireFromTest = createRequire(import.meta.url);
const temporaryRoots: string[] = [];
const readOnlyReleases: string[] = [];
const childPids = new Set<number>();

afterEach(async () => {
  for (const pid of childPids) killIfAlive(pid);
  childPids.clear();
  for (const release of readOnlyReleases.splice(0)) {
    await chmod(release, 0o755).catch(() => undefined);
  }
  await Promise.all(temporaryRoots.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("runner cutover all-flags-on integration", () => {
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
      mcpConfigService: { resolveMcpProfile: () => undefined } as never,
      buildChildProcessEnv: () => ({
        ...process.env,
        NODE_OPTIONS: `--import ${pathToFileURL(requireFromTest.resolve("tsx")).href}`,
        RUNNER_E2E_CONTROL_DIR: controlDirectory,
      }),
    });
    if (!composition) throw new Error("runner composition unexpectedly disabled");
    const releaseEntries = await import("node:fs/promises")
      .then(({ readdir }) => readdir(releasesDirectory));
    const releaseId = releaseEntries.find((entry) => entry.startsWith("sha256-"));
    if (!releaseId) throw new Error("runner release was not prewarmed");
    const releaseRoot = join(releasesDirectory, releaseId);
    readOnlyReleases.push(releaseRoot);

    const task = makeTask();
    const agent = makeAgent(controlDirectory);
    const firstHost = taskExecutor(composition.runtimeFactory);
    firstHost.startExecution(task, agent);
    const paths = runnerProcessPaths(stateDirectory, task.agentSessionId);
    await waitFor(async () => await pathExists(paths.pidPath));
    const pid = Number.parseInt((await readFile(paths.pidPath, "utf8")).trim(), 10);
    childPids.add(pid);
    const childErrorPath = join(controlDirectory, "child-error");
    await waitFor(async () =>
      await pathExists(join(controlDirectory, "execute-started"))
      || await pathExists(childErrorPath));
    if (await pathExists(childErrorPath)) {
      throw new Error(await readFile(childErrorPath, "utf8"));
    }

    await writeFile(join(controlDirectory, "emit-first"), "go\n");
    await waitFor(async () => batches.length === 1 && await pendingFrameCount(paths.databasePath) === 0);
    expect(batches[0]?.events[0]).toMatchObject({
      stream_id: expect.any(String),
      source_seq: 2,
      payload: { content: "before-detach" },
    });
    expect((await readRunnerBootstrap(paths.databasePath)).payload).toMatchObject({
      code_sha: releaseId,
      snapshot_path: releaseRoot,
      cwd: controlDirectory,
    });

    const oldExecution = task.executionPromise;
    await (task.runner!.dispatcher as RunnerProcessDispatcher).detachHost();
    task.runner = undefined;
    task.executionPromise = undefined;
    await writeFile(join(controlDirectory, "emit-after-detach"), "go\n");
    await waitFor(async () => await hasDurableEvent(paths.databasePath, 3));
    expect(isPidAlive(pid)).toBe(true);

    const config = parseRunnerChildConfig(JSON.parse(await readFile(paths.configPath, "utf8")));
    const restartedHost = taskExecutor(composition.runtimeFactory);
    const recovery = restartedHost.recoverRegisteredRunner(task, config, undefined, "adopt");
    await waitFor(async () => batches.length === 2);
    await writeFile(join(controlDirectory, "finish"), "go\n");
    await recovery;

    expect(task.status).toBe("completed");
    expect(task.lastAssistantText).toBe("after-detach");
    expect(batches.flatMap((batch) => batch.events.map(
      (event) => (event.payload as { content?: string }).content,
    ))).toEqual(["before-detach", "after-detach"]);
    expect(await pendingFrameCount(paths.databasePath)).toBe(0);
    await waitFor(async () => !isPidAlive(pid));
    childPids.delete(pid);
    void oldExecution;
  }, 30_000);
});

function taskExecutor(
  runnerProcessFactory: NonNullable<Awaited<ReturnType<typeof composeRunnerProcessRuntime>>>["runtimeFactory"],
): TaskExecutor {
  const persistence = makeEventPersistenceTestDouble(async (_sessionId, event, task) => {
    if (event.type === "assistant_message" && typeof event.content === "string") {
      task.lastAssistantText = event.content;
    }
  }).persistence;
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
    persistence,
    broadcaster,
    pino({ level: "silent" }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    runnerProcessFactory,
  );
}

function makeTask(): Task {
  return {
    agentSessionId: "session-cutover-smoke",
    prompt: "exercise runner cutover",
    status: "running",
    profileId: "cutover-agent",
    createdAt: new Date(),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

function makeAgent(workspaceDirectory: string): AgentProfile {
  return {
    id: "cutover-agent",
    name: "Cutover Agent",
    backend: "openai-agents",
    workspace_dir: workspaceDirectory,
    agents_sdk: {
      entry_agent: "root",
      agents: [{ id: "root", name: "Root", instructions: "cutover smoke" }],
    },
  };
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
  const outbox = await RunnerSqliteEventOutbox.open(path);
  try {
    const bootstrap = await outbox.readBootstrap();
    if (!bootstrap) throw new Error("runner bootstrap missing");
    return bootstrap;
  } finally {
    outbox.close();
  }
}

async function pendingFrameCount(path: string): Promise<number> {
  const outbox = await RunnerSqliteEventOutbox.open(path);
  try {
    return (await outbox.readPendingIpcFrames()).length;
  } finally {
    outbox.close();
  }
}

async function hasDurableEvent(path: string, sourceSeq: number): Promise<boolean> {
  const outbox = await RunnerSqliteEventOutbox.open(path);
  try {
    return await outbox.readRecord(sourceSeq) !== null;
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

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
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

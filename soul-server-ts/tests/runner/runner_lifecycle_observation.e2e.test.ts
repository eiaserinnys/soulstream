import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunnerProcessDispatcher } from
  "../../src/runner/runner_process_dispatcher.js";
import { scanRunnerRegistrations } from "../../src/runner/runner_process_registry.js";
import { RunnerProcessSpawner } from "../../src/runner/runner_process_spawn.js";
import { RunnerSqliteLifecycle } from "../../src/runner/sqlite_runner_lifecycle.js";
import type { EventOutboxBatch } from "../../src/upstream/event_outbox.js";
import {
  EventOutboxPump,
  type EventOutboxPumpStore,
} from "../../src/upstream/event_outbox_pump.js";
import { EventOutboxPumpMux } from "../../src/upstream/event_outbox_pump_mux.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const requireFromTest = createRequire(import.meta.url);
const childFixturePath = join(testDirectory, "fixtures/runner_process_e2e_child.ts");
const directories: string[] = [];
const childPids = new Set<number>();

afterEach(async () => {
  for (const pid of childPids) killIfAlive(pid);
  childPids.clear();
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("runner lifecycle observations", () => {
  it("ignores typed lifecycle observation mismatches and completes the turn", async () => {
    const scenario = await spawnScenario("mismatch");
    const iterator = scenario.host.executeFrames({
      agentSessionId: "session-e2e",
      prompt: "ignore stale lifecycle observations",
    })[Symbol.asyncIterator]();

    await expect(withTimeout(iterator.next())).resolves.toMatchObject({
      done: false,
      value: {
        kind: "engine_event",
        payload: { type: "session", session_id: "backend-session-e2e" },
      },
    });
    await waitFor(async () => await pathExists(join(scenario.controlDirectory, "execute-started")));

    const lifecycle = RunnerSqliteLifecycle.open(scenario.spawned.paths.databasePath);
    const active = lifecycle.read();
    expect(active).toMatchObject({ execution_state: "running" });
    const activeCommandId = active!.execution_command_id;
    lifecycle.begin({
      pid: scenario.spawned.pid,
      commandId: "execute-newer",
      progressedAt: "2026-09-05T08:00:00.000Z",
    });
    const newerLifecycle = lifecycle.read();
    await waitFor(async () => (await readFile(scenario.spawned.paths.logPath, "utf8"))
      .includes('"observation":"liveness"'));

    const remaining = collectRemaining(iterator);
    await writeFile(join(scenario.controlDirectory, "emit-lifecycle-observation"), "go\n");
    await waitForPathWhile(
      join(scenario.controlDirectory, "lifecycle-observations-emitted"),
      remaining,
    );

    expect(lifecycle.read()).toEqual(newerLifecycle);
    expect(await pathExists(
      join(scenario.controlDirectory, "lifecycle-observation-interrupt-count"),
    )).toBe(false);
    expect(isPidAlive(scenario.spawned.pid)).toBe(true);
    await waitFor(async () => (await readFile(scenario.spawned.paths.logPath, "utf8"))
      .includes("Stale runner lifecycle observation ignored"));
    const runnerLog = await readFile(scenario.spawned.paths.logPath, "utf8");
    expect(runnerLog).toContain(`runner lifecycle command mismatch: ${activeCommandId}`);
    expect(runnerLog).toContain('"observation":"progress"');
    expect(runnerLog).toContain('"observation":"tool_started"');
    expect(runnerLog).toContain('"observation":"engine_progress"');

    lifecycle.begin({
      pid: scenario.spawned.pid,
      commandId: activeCommandId,
      progressedAt: "2026-09-05T08:00:01.000Z",
    });
    await writeFile(join(scenario.controlDirectory, "finish-lifecycle-observation"), "go\n");
    const frames = await withTimeout(remaining);

    expect(frames.some((frame) =>
      frame.kind === "engine_event"
      && frame.payload.type === "assistant_message"
      && frame.payload.content === "after-lifecycle-mismatch"
    )).toBe(true);
    expect(scenario.batches.flatMap((batch) => batch.events).some((event) =>
      event.event_type === "assistant_message"
      && (event.payload as { content?: unknown }).content === "after-lifecycle-mismatch"
    )).toBe(true);
    expect(lifecycle.read()).toMatchObject({
      execution_command_id: activeCommandId,
      execution_state: "completed",
      terminal_error: null,
    });

    lifecycle.close();
    await scenario.host.close();
    await waitFor(async () => !isPidAlive(scenario.spawned.pid));
    childPids.delete(scenario.spawned.pid);
  }, 30_000);

  it("keeps non-mismatch lifecycle storage failures fatal", async () => {
    const scenario = await spawnScenario("storage-failure");
    const iterator = scenario.host.executeFrames({
      agentSessionId: "session-e2e",
      prompt: "surface lifecycle storage failure",
    })[Symbol.asyncIterator]();

    await expect(withTimeout(iterator.next())).resolves.toMatchObject({
      done: false,
      value: { kind: "engine_event", payload: { type: "session" } },
    });
    await waitFor(async () => await pathExists(join(scenario.controlDirectory, "execute-started")));
    const { DatabaseSync } = requireFromTest("node:sqlite") as typeof import("node:sqlite");
    const fault = new DatabaseSync(scenario.spawned.paths.databasePath);
    fault.exec(`
      CREATE TRIGGER fail_lifecycle_observation_storage
      BEFORE UPDATE OF progress_seq ON runner_event_outbox
      WHEN OLD.execution_state = 'running' AND NEW.execution_state = 'running'
      BEGIN
        SELECT RAISE(ABORT, 'forced lifecycle observation storage failure');
      END;
    `);
    fault.close();

    const remaining = collectRemaining(iterator);
    await writeFile(join(scenario.controlDirectory, "emit-lifecycle-observation"), "go\n");
    await expect(withTimeout(remaining)).rejects.toThrow(
      "forced lifecycle observation storage failure",
    );
    await waitFor(async () => await pathExists(
      join(scenario.controlDirectory, "lifecycle-observation-interrupt-count"),
    ));
    expect(await readFile(
      join(scenario.controlDirectory, "lifecycle-observation-interrupt-count"),
      "utf8",
    )).toBe("1\n");
    const lifecycle = RunnerSqliteLifecycle.open(scenario.spawned.paths.databasePath);
    expect(lifecycle.read()).toMatchObject({
      execution_state: "failed",
      terminal_error: {
        code: "execution_failed",
        message: "forced lifecycle observation storage failure",
      },
    });
    lifecycle.close();

    killIfAlive(scenario.spawned.pid);
    childPids.delete(scenario.spawned.pid);
  }, 30_000);
});

async function spawnScenario(scenario: "mismatch" | "storage-failure") {
  const root = await mkdtemp(join(tmpdir(), `runner-lifecycle-observation-${scenario}-`));
  directories.push(root);
  const stateDirectory = join(root, "state");
  const snapshotPath = join(root, "snapshot");
  const controlDirectory = join(root, "control");
  await mkdir(snapshotPath, { recursive: true });
  await mkdir(controlDirectory, { recursive: true });
  await writeFile(join(snapshotPath, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(
    join(snapshotPath, "runner_entry.js"),
    `await import(${JSON.stringify(pathToFileURL(childFixturePath).href)});\n`,
  );
  const input = spawnInput(stateDirectory, snapshotPath, controlDirectory, scenario);
  const spawned = await new RunnerProcessSpawner().spawn(input);
  childPids.add(spawned.pid);
  const { mux, batches } = autoAcknowledgingMux();
  return {
    spawned,
    controlDirectory,
    batches,
    host: processDispatcher(input, mux),
  };
}

function processDispatcher(
  input: ReturnType<typeof spawnInput>,
  pumpMux: EventOutboxPumpMux,
): RunnerProcessDispatcher {
  const spawner = new RunnerProcessSpawner();
  const runnerProcess = scanRunnerRegistrations(input.stateDirectory).then(async (scan) => {
    const registration = scan.registrations.find(
      (candidate) => candidate.config.sessionId === input.sessionId,
    );
    if (!registration) throw new Error(`runner registration missing: ${input.sessionId}`);
    const adopted = await spawner.adopt(registration);
    if (!adopted) throw new Error(`registered runner is not alive: ${input.sessionId}`);
    return adopted;
  });
  return new RunnerProcessDispatcher({
    spawn: input,
    runnerProcess,
    pumpMux,
    logger: pino({ level: "silent" }),
    handleHostCall: async () => null,
  });
}

function autoAcknowledgingMux(): { mux: EventOutboxPumpMux; batches: EventOutboxBatch[] } {
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
        event_id: 10_000 + event.source_seq,
      })),
    });
  });
  return { mux, batches };
}

function emptyStore(): EventOutboxPumpStore {
  return {
    streamId: "node-primary",
    ackedSeq: 0,
    onAppend: () => () => {},
    readBatch: async () => null,
    acknowledge: async () => {},
  };
}

function spawnInput(
  stateDirectory: string,
  snapshotPath: string,
  controlDirectory: string,
  scenario: "mismatch" | "storage-failure",
) {
  return {
    stateDirectory,
    sessionId: "session-e2e",
    backend: "openai-agents" as const,
    agent: {
      id: "agent-e2e",
      name: "Agent E2E",
      backend: "openai-agents" as const,
      workspace_dir: controlDirectory,
      agents_sdk: {
        entry_agent: "root",
        agents: [{ id: "root", name: "Root", instructions: "Runner process E2E fixture" }],
      },
    },
    codeSha: "e2e-sha",
    snapshotPath,
    codexAdapterMode: "sdk" as const,
    claudeRuntimeV2Enabled: true,
    claudeRuntimeIdleTtlMs: 300_000,
    claudeRuntimeMaxEntries: 16,
    claudeRuntimeTurnTimeoutMs: 1_800_000,
    ...(scenario === "mismatch" ? { runnerLeaseTimeoutMs: 90 } : {}),
    internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
    codexHome: null,
    rolloutRoot: null,
    childProcessEnv: {
      ...process.env,
      NODE_OPTIONS: `--import ${pathToFileURL(requireFromTest.resolve("tsx")).href}`,
      RUNNER_E2E_CONTROL_DIR: controlDirectory,
      RUNNER_E2E_CAPTURE_WARNINGS: "1",
      RUNNER_E2E_LIFECYCLE_OBSERVATION_SCENARIO: scenario,
    },
  };
}

async function collectRemaining(
  iterator: AsyncIterator<import("../../src/runner/frame_protocol.js").RunnerEventFrame>,
) {
  const frames = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) return frames;
    frames.push(next.value);
  }
}

async function waitForPathWhile(path: string, operation: Promise<unknown>): Promise<void> {
  await Promise.race([
    waitFor(async () => await pathExists(path)),
    operation.then(
      () => { throw new Error(`runner operation ended before marker: ${path}`); },
      (error: unknown) => { throw error; },
    ),
  ]);
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("runner E2E wait timeout");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("runner E2E operation timed out")),
      10_000,
    )),
  ]);
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

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killIfAlive(pid: number): void {
  if (!isPidAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

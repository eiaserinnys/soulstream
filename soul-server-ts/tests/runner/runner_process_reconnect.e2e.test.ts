import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunnerProcessDispatcher } from
  "../../src/runner/runner_process_dispatcher.js";
import {
  classifyRunnerRegistration,
  scanRunnerRegistrations,
} from "../../src/runner/runner_process_registry.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import { RunnerProcessSpawner } from "../../src/runner/runner_process_spawn.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import { RunnerSqliteLifecycle } from "../../src/runner/sqlite_runner_lifecycle.js";
import type { EventOutboxBatch } from "../../src/upstream/event_outbox.js";
import {
  EventOutboxPump,
  type EventOutboxPumpStore,
} from "../../src/upstream/event_outbox_pump.js";
import { EventOutboxPumpMux } from "../../src/upstream/event_outbox_pump_mux.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const requireFromTest = createRequire(import.meta.url);
const packageDirectory = resolve(testDirectory, "../..");
const launcherPath = join(testDirectory, "fixtures/runner_process_e2e_launcher.ts");
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

describe("runner process detach/reconnect E2E", () => {
  it.each([
    ["initial-crash", "fixture crashed before backend session ID"],
    ["frame-count-overflow", "exceeded 1024 events before its backend session ID"],
    ["byte-overflow", "exceeded 8388608 bytes before its backend session ID"],
  ])("isolates %s pre-bootstrap failure from the next actual child execution", async (
    scenario,
    expectedError,
  ) => {
    const root = await mkdtemp(join(tmpdir(), `runner-prebootstrap-${scenario}-`));
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
    const baseInput = spawnInput(stateDirectory, snapshotPath, controlDirectory);
    const input = {
      ...baseInput,
      backend: "claude" as const,
      agent: { ...baseInput.agent, backend: "claude" as const },
      childProcessEnv: {
        ...baseInput.childProcessEnv,
        RUNNER_E2E_PRE_BOOTSTRAP_SCENARIO: scenario,
      },
    };
    const spawned = await new RunnerProcessSpawner().spawn(input);
    childPids.add(spawned.pid);
    const { mux, batches } = autoAcknowledgingMux();
    const host = processDispatcher(input, mux);

    await expect(collectFrames(host.executeFrames({
      agentSessionId: "session-e2e",
      prompt: "fail before ID",
    }))).rejects.toThrow(expectedError);

    const outbox = await RunnerSqliteEventOutbox.create(spawned.paths.databasePath);
    expect(await outbox.readBootstrap()).toBeNull();
    outbox.close();
    const lifecycle = RunnerSqliteLifecycle.open(spawned.paths.databasePath);
    expect(lifecycle.read()).toMatchObject({ execution_state: "failed" });
    lifecycle.close();

    const second = await collectFrames(host.executeFrames({
      agentSessionId: "session-e2e",
      prompt: "succeed with ID",
    }));
    expect(second.map((frame) => frame.payload)).toEqual([
      { type: "session", session_id: "backend-session-e2e" },
      { type: "assistant_message", content: "execution-2", timestamp: 3 },
    ]);
    expect(batches.flatMap((batch) => batch.events).some((event) =>
      event.event_type === "claude_runtime_hook_event"
    )).toBe(false);

    await host.close();
    await waitFor(async () => !isPidAlive(spawned.pid));
    childPids.delete(spawned.pid);
  }, 30_000);

  it("buffers ID-bearing events until bootstrap and accepts a resumed second turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-bootstrap-e2e-"));
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
    const input = {
      ...spawnInput(stateDirectory, snapshotPath, controlDirectory),
      backend: "claude" as const,
      agent: {
        id: "agent-e2e",
        name: "Agent E2E",
        backend: "claude" as const,
        workspace_dir: controlDirectory,
      },
      childProcessEnv: {
        ...spawnInput(stateDirectory, snapshotPath, controlDirectory).childProcessEnv,
        RUNNER_E2E_ID_BOOTSTRAP: "1",
      },
    };
    const spawned = await new RunnerProcessSpawner().spawn(input);
    childPids.add(spawned.pid);
    const { mux, batches } = autoAcknowledgingMux();
    const host = processDispatcher(input, mux);

    const first = await collectFrames(host.executeFrames({
      agentSessionId: "session-e2e",
      prompt: "first",
    }));
    expect(first.map((frame) => frame.payload.type)).toEqual([
      "claude_runtime_hook_event",
      "session",
      "assistant_message",
    ]);
    const outbox = await RunnerSqliteEventOutbox.create(spawned.paths.databasePath);
    expect((await outbox.readBootstrap())?.payload.backend_session_id)
      .toBe("backend-session-e2e");
    outbox.close();

    const second = await collectFrames(host.executeFrames({
      agentSessionId: "session-e2e",
      prompt: "second",
      resumeSessionId: "backend-session-e2e",
    }));
    expect(second).toHaveLength(1);
    expect(second[0]?.payload).toMatchObject({ content: "execution-2" });
    expect(isPidAlive(spawned.pid)).toBe(true);
    expect(batches.flatMap((batch) => batch.events.map((event) => event.event_type)))
      .toEqual([
        "claude_runtime_hook_event",
        "session",
        "assistant_message",
        "assistant_message",
      ]);

    await host.close();
    await waitFor(async () => !isPidAlive(spawned.pid));
    childPids.delete(spawned.pid);
  }, 30_000);

  it("survives its spawning parent and replays only events after the last host ACK", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-reconnect-e2e-"));
    directories.push(root);
    const stateDirectory = join(root, "state");
    const snapshotPath = join(root, "snapshot");
    const controlDirectory = join(root, "control");
    await mkdir(snapshotPath, { recursive: true });
    await mkdir(controlDirectory, { recursive: true });
    await writeFile(join(snapshotPath, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(
      join(snapshotPath, "runner_entry.js"),
      `try {\n  await import(${JSON.stringify(pathToFileURL(childFixturePath).href)});\n}`
        + ` catch (error) {\n  const { writeFile } = await import("node:fs/promises");\n`
        + `  await writeFile(process.env.RUNNER_E2E_CONTROL_DIR + "/child-error", String(error?.stack ?? error));\n`
        + `  throw error;\n}\n`,
    );
    const input = spawnInput(stateDirectory, snapshotPath, controlDirectory);
    const inputPath = join(root, "spawn-input.json");
    await writeFile(inputPath, JSON.stringify(input));

    const launcher = spawn(process.execPath, ["--import", "tsx", launcherPath, inputPath], {
      cwd: packageDirectory,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const launcherResult = await collectExit(launcher);
    expect(launcherResult.code, launcherResult.stderr).toBe(0);

    const paths = runnerProcessPaths(stateDirectory, "session-e2e");
    const pid = Number.parseInt((await readFile(paths.pidPath, "utf8")).trim(), 10);
    childPids.add(pid);
    expect(isPidAlive(pid)).toBe(true);
    const childErrorPath = join(controlDirectory, "child-error");
    await waitFor(async () => await pathExists(paths.socketPath) || await pathExists(childErrorPath));
    if (await pathExists(childErrorPath)) {
      throw new Error(await readFile(childErrorPath, "utf8"));
    }

    const { mux, batches } = autoAcknowledgingMux();
    const firstHost = processDispatcher(input, mux);
    const firstIterator = firstHost.executeFrames({
      agentSessionId: "session-e2e",
      prompt: "continue",
    })[Symbol.asyncIterator]();
    const firstHostSession = firstIterator.next();
    await waitFor(async () => await pathExists(join(controlDirectory, "execute-started")));
    await expect(withTimeout(firstHostSession)).resolves.toMatchObject({
      done: false,
      value: {
        kind: "engine_event",
        payload: { type: "session", session_id: "backend-session-e2e" },
      },
    });
    void firstIterator.next().catch(() => {});
    await waitFor(async () => await pendingFrameCount(paths.databasePath) === 0);
    const scan = await scanRunnerRegistrations(stateDirectory);
    expect(scan.errors).toEqual([]);
    expect(scan.registrations).toHaveLength(1);
    expect(classifyRunnerRegistration(
      scan.registrations[0]!,
      Date.now(),
      120_000,
    )).toBe("adopt_running");
    await firstHost.detachHost();

    const secondHost = processDispatcher(input, mux);
    const secondIterator = secondHost.recoverFrames()[Symbol.asyncIterator]();
    const firstEvent = secondIterator.next();
    await writeFile(join(controlDirectory, "emit-first"), "go\n");
    const first = await withTimeout(firstEvent);
    expect(first).toMatchObject({
      done: false,
      value: { kind: "engine_event", payload: { content: "before-detach" } },
    });

    void secondIterator.next().catch(() => {});
    await waitFor(async () => await pendingFrameCount(paths.databasePath) === 0);
    await secondHost.detachHost();
    await writeFile(join(controlDirectory, "emit-after-detach"), "go\n");
    await waitFor(async () => await hasDurableEvent(paths.databasePath, 4));
    expect(isPidAlive(pid)).toBe(true);

    const thirdHost = processDispatcher(input, mux);
    const thirdIterator = thirdHost.recoverFrames()[Symbol.asyncIterator]();
    const second = await withTimeout(thirdIterator.next());
    expect(second).toMatchObject({
      done: false,
      value: { kind: "engine_event", payload: { content: "after-detach" } },
    });
    const finished = thirdIterator.next();
    await writeFile(join(controlDirectory, "finish"), "go\n");
    await expect(withTimeout(finished)).resolves.toEqual({ done: true, value: undefined });
    await waitFor(async () => await pendingFrameCount(paths.databasePath) === 0);

    expect(batches.flatMap((batch) => batch.events.flatMap((event) => {
      const content = (event.payload as { content?: unknown }).content;
      return typeof content === "string" ? [content] : [];
    }))).toEqual(["before-detach", "after-detach"]);
    await thirdHost.close();
    await waitFor(async () => !isPidAlive(pid));
    childPids.delete(pid);
  }, 30_000);
});

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

function spawnInput(stateDirectory: string, snapshotPath: string, controlDirectory: string) {
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
        agents: [{
          id: "root",
          name: "Root",
          instructions: "Runner process E2E fixture",
        }],
      },
    },
    codeSha: "e2e-sha",
    snapshotPath,
    codexAdapterMode: "sdk" as const,
    claudeRuntimeV2Enabled: true,
    claudeRuntimeIdleTtlMs: 300_000,
    claudeRuntimeMaxEntries: 16,
    claudeRuntimeTurnTimeoutMs: 1_800_000,
    internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
    codexHome: null,
    rolloutRoot: null,
    childProcessEnv: {
      ...process.env,
      // The fixture imports TypeScript test support intentionally. Resolve the
      // loader now because the production spawn cwd is the isolated snapshot,
      // where package-name lookup must not reach the live checkout.
      NODE_OPTIONS: `--import ${pathToFileURL(requireFromTest.resolve("tsx")).href}`,
      RUNNER_E2E_CONTROL_DIR: controlDirectory,
    },
  };
}

async function collectExit(child: ReturnType<typeof spawn>): Promise<{
  code: number | null;
  stderr: string;
}> {
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, stderr };
}

async function collectFrames(
  stream: AsyncIterable<import("../../src/runner/frame_protocol.js").RunnerEventFrame>,
) {
  const frames = [];
  for await (const frame of stream) frames.push(frame);
  return frames;
}

async function pendingFrameCount(path: string): Promise<number> {
  const outbox = await RunnerSqliteEventOutbox.create(path);
  try {
    return (await outbox.readPendingIpcFrames()).length;
  } finally {
    outbox.close();
  }
}

async function hasDurableEvent(path: string, sourceSeq: number): Promise<boolean> {
  const outbox = await RunnerSqliteEventOutbox.create(path);
  try {
    return await outbox.readRecord(sourceSeq) !== null;
  } finally {
    outbox.close();
  }
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("runner E2E wait timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

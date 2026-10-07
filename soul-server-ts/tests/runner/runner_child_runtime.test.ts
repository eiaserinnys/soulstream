import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import {
  engineEventFrame,
  executeCommandFrame,
  type RunnerCommandFrame,
  type RunnerEventFrame,
} from "../../src/runner/frame_protocol.js";
import { RunnerChildRuntime } from "../../src/runner/runner_child_runtime.js";
import {
  backendSessionRotationEffect,
  buildDurableRunnerEvent,
  isSqliteFullError,
  requiresBackendSessionId,
  runnerLivenessIntervalMs,
  runnerToolLeaseTransition,
  setRunnerOomScore,
} from "../../src/runner/runner_child_runtime_helpers.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import type { RunnerChildConfig } from "../../src/runner/runner_process_spawn.js";
import { readRunnerRegistrationIdentity } from
  "../../src/runner/runner_registration_identity.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";

const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("buildDurableRunnerEvent", () => {
  it("derives liveness cadence from the lease instead of the turn timeout", () => {
    expect(runnerLivenessIntervalMs(120_000)).toBe(30_000);
    expect(runnerLivenessIntervalMs(9_000)).toBe(3_000);
  });
  it("derives explicit tool lease transitions only from paired tool events", () => {
    expect(runnerToolLeaseTransition({
      type: "tool_start",
      tool_name: "Bash",
      tool_input: {},
      tool_use_id: "tool-long",
      timestamp: 1,
    } as SSEEventPayload)).toEqual({ kind: "start", toolUseId: "tool-long" });
    expect(runnerToolLeaseTransition({
      type: "tool_result",
      tool_name: "Bash",
      result: "done",
      is_error: false,
      tool_use_id: "tool-long",
      timestamp: 2,
    } as SSEEventPayload)).toEqual({ kind: "finish", toolUseId: "tool-long" });
    expect(runnerToolLeaseTransition({
      type: "assistant_message",
      content: "still working",
      timestamp: 3,
    } as SSEEventPayload)).toBeNull();
  });
  it("waits for resume material only on ID-bearing backends", () => {
    expect(requiresBackendSessionId("claude")).toBe(true);
    expect(requiresBackendSessionId("codex")).toBe(true);
    expect(requiresBackendSessionId("openai-agents")).toBe(false);
  });
  it("removes internal dedupe metadata before the durable frame crosses IPC", () => {
    const event = {
      type: "assistant_message",
      content: "durable",
      timestamp: 1,
      _dedupe_key: "delivery:1",
    } as SSEEventPayload;

    const durable = buildDurableRunnerEvent("session-a", event);

    expect(durable.appendInput.semantic_dedupe_key).toBe("delivery:1");
    expect(durable.appendInput.payload).not.toHaveProperty("_dedupe_key");
    expect(durable.frame.payload).toEqual(durable.appendInput.payload);
  });

  it("raises the Linux runner OOM kill preference without affecting other platforms", async () => {
    const directory = await mkdtemp(join(tmpdir(), "soulstream-runner-oom-"));
    directories.push(directory);
    const scorePath = join(directory, "oom_score_adj");
    await writeFile(scorePath, "0\n");

    await setRunnerOomScore("win32", scorePath);
    expect(await readFile(scorePath, "utf8")).toBe("0\n");
    await setRunnerOomScore("linux", scorePath);
    expect(await readFile(scorePath, "utf8")).toBe("500\n");
  });

  it("classifies SQLite full as an immediate loud runner storage failure", () => {
    expect(isSqliteFullError(Object.assign(
      new Error("database or disk is full"),
      { code: "SQLITE_FULL" },
    ))).toBe(true);
    expect(isSqliteFullError(new Error("engine exited"))).toBe(false);
  });
});

describe("RunnerChildRuntime startup", () => {
  it("publishes its own identity when a standalone start has no pending sidecar", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "soulstream-runner-standalone-"));
    directories.push(stateDirectory);
    const sessionId = "standalone-child";
    const paths = runnerProcessPaths(stateDirectory, sessionId);
    await mkdir(paths.sessionDirectory, { recursive: true });
    const outbox = await RunnerSqliteEventOutbox.create(paths.databasePath);
    outbox.close();
    const config: RunnerChildConfig = {
      schemaVersion: 1,
      sessionId,
      backend: "codex",
      agent: {
        id: "standalone-agent",
        name: "Standalone Agent",
        backend: "codex",
        workspace_dir: stateDirectory,
      },
      paths,
      codeSha: "sha-standalone",
      snapshotPath: stateDirectory,
      codexAdapterMode: "sdk",
      codexCliPath: process.execPath,
      claudeRuntimeV2Enabled: true,
      claudeRuntimeIdleTtlMs: 300_000,
      claudeRuntimeMaxEntries: 16,
      claudeRuntimeTurnTimeoutMs: 1_800_000,
      internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
      codexHome: null,
      rolloutRoot: null,
    };
    const runtime = new RunnerChildRuntime(config, pino({ level: "silent" }), {
      createEngine: () => standaloneEngine(stateDirectory),
    });

    await expect(readRunnerRegistrationIdentity(paths.sessionDirectory)).resolves.toBeNull();
    try {
      await runtime.start();
      await expect(readRunnerRegistrationIdentity(paths.sessionDirectory)).resolves.toMatchObject({
        schemaVersion: 1,
        registrationId: expect.any(String),
        sessionId,
        codeSha: "sha-standalone",
        pid: process.pid,
        startIdentity: expect.any(String),
      });
    } finally {
      await runtime.shutdown();
    }
  });
});

describe("RunnerChildRuntime backend session rotation", () => {
  it("preserves the preparation error and old lifecycle when rollover uses an obsolete native ID", async () => {
    const { runtime, sessionId } = await createRotationRuntime("backend-session-fresh");
    const child = runtime as unknown as RunnerChildRuntimeRotationHarness;
    const previous = executeCommandFrame("previous-command", {
      agentSessionId: sessionId, prompt: "previous", resumeSessionId: "backend-session-fresh",
    });
    await child.prepareExecution(previous);
    await child.outbox.finishExecution({ commandId: previous.commandId, state: "failed",
      progressedAt: new Date().toISOString(), terminalError: { code: "limit_hit", message: "quota" } });
    const before = child.lifecycle.read();
    const send = vi.spyOn(child, "sendRequired").mockResolvedValue(undefined);
    const shutdown = vi.spyOn(runtime, "shutdown");
    try {
      await child.drainExecution(rotationCommand(sessionId));
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        kind: "execution_ended", commandId: "rotate-backend-session",
        error: { code: "execution_failed", message: "runner backend session rollover conflicts with durable bootstrap" },
      }));
      expect(child.lifecycle.read()).toEqual(before);
      expect(shutdown).not.toHaveBeenCalled();
      await expect(child.outbox.readBootstrap()).resolves.toMatchObject({ payload: { backend_session_id: "backend-session-fresh" } });
    } finally {
      shutdown.mockRestore();
      await runtime.shutdown();
    }
  });

  it("rotates a Codex backend session ID when bootstrap already exists", async () => {
    const { runtime, sessionId } = await createRotationRuntime("backend-session-old");
    const child = runtime as unknown as RunnerChildRuntimeRotationHarness;
    const command = rotationCommand(sessionId);
    child.activeCommandId = command.commandId;

    try {
      await child.prepareExecution(command);
      await child.forwardRunnerFrame(
        engineEventFrame({ type: "session", session_id: "backend-session-fresh" }),
        { frames: [], bytes: 0 },
      );

      await expect(child.outbox.readBootstrap()).resolves.toMatchObject({
        payload: { backend_session_id: "backend-session-fresh" },
      });
      const events = (await child.outbox.readBatch())?.events ?? [];
      expect(events).toHaveLength(1);
      expect(events[0]?.session_effect).toEqual(
        backendSessionRotationEffect("backend-session-old", "backend-session-fresh"),
      );
    } finally {
      await runtime.shutdown();
    }
  });

  it("creates bootstrap before flushing buffered events when rotation starts without one", async () => {
    const { runtime, sessionId } = await createRotationRuntime(null);
    const child = runtime as unknown as RunnerChildRuntimeRotationHarness;
    const command = rotationCommand(sessionId);
    child.activeCommandId = command.commandId;
    const buffer = { frames: [] as RunnerEventFrame[], bytes: 0 };

    try {
      await child.prepareExecution(command);
      await child.forwardRunnerFrame(
        engineEventFrame({
          type: "assistant_message",
          content: "before the new session ID",
          timestamp: 1,
        }),
        buffer,
      );
      expect(buffer.frames).toHaveLength(1);

      await child.forwardRunnerFrame(
        engineEventFrame({ type: "session", session_id: "backend-session-fresh" }),
        buffer,
      );

      await expect(child.outbox.readBootstrap()).resolves.toMatchObject({
        payload: { backend_session_id: "backend-session-fresh" },
      });
      expect(buffer.frames).toHaveLength(0);
      const events = (await child.outbox.readBatch())?.events ?? [];
      expect(events.map((event) => event.payload.type)).toEqual([
        "assistant_message",
        "session",
      ]);
      expect(events[1]?.session_effect).toEqual(
        backendSessionRotationEffect("backend-session-old", "backend-session-fresh"),
      );
      expect(events.filter((event) =>
        event.session_effect?.kind === "rotate_backend_session_id"
      )).toHaveLength(1);
    } finally {
      await runtime.shutdown();
    }
  });

  it("accepts a repeated rotation when bootstrap already stores the new ID", async () => {
    const sessionId = "runner-rotation-replay";
    const outbox = await createRotationOutbox(sessionId, "backend-session-fresh");
    const rotation = {
      expectedBackendSessionId: "backend-session-old",
      backendSessionId: "backend-session-fresh",
    };

    try {
      await appendRotation(outbox, sessionId, rotation);

      await expect(outbox.readBootstrap()).resolves.toMatchObject({
        payload: { backend_session_id: "backend-session-fresh" },
      });
      expect((await outbox.readBatch())?.events).toHaveLength(1);
    } finally {
      outbox.close();
    }
  });

  it("rejects a repeated rotation when bootstrap has neither ID", async () => {
    const sessionId = "runner-rotation-mismatch";
    const outbox = await createRotationOutbox(sessionId, "backend-session-other");

    try {
      await expect(appendRotation(outbox, sessionId, {
        expectedBackendSessionId: "backend-session-old",
        backendSessionId: "backend-session-fresh",
      })).rejects.toThrow("expected backend session ID mismatch");
    } finally {
      outbox.close();
    }
  });
});

type RunnerChildRuntimeRotationHarness = {
  activeCommandId?: string;
  outbox: RunnerSqliteEventOutbox;
  lifecycle: { read(): unknown };
  sendRequired(frame: unknown): Promise<void>;
  drainExecution(command: Extract<RunnerCommandFrame, { kind: "execute" }>): Promise<void>;
  prepareExecution(
    command: Extract<RunnerCommandFrame, { kind: "execute" }>,
  ): Promise<void>;
  forwardRunnerFrame(
    frame: RunnerEventFrame,
    preBootstrap: { frames: RunnerEventFrame[]; bytes: number },
  ): Promise<void>;
};

async function createRotationRuntime(backendSessionId: string | null): Promise<{
  runtime: RunnerChildRuntime;
  sessionId: string;
}> {
  const stateDirectory = await mkdtemp(join(tmpdir(), "soulstream-runner-rotation-"));
  directories.push(stateDirectory);
  const sessionId = "runner-rotation-session";
  const paths = runnerProcessPaths(stateDirectory, sessionId);
  await mkdir(paths.sessionDirectory, { recursive: true });
  const seededOutbox = await RunnerSqliteEventOutbox.create(paths.databasePath);
  if (backendSessionId !== null) {
    await seededOutbox.initializeBootstrap(rotationBootstrapInput(
      sessionId,
      stateDirectory,
      backendSessionId,
    ));
  }
  seededOutbox.close();

  const config: RunnerChildConfig = {
    schemaVersion: 1,
    sessionId,
    backend: "codex",
    agent: {
      id: "rotation-agent",
      name: "Rotation Agent",
      backend: "codex",
      workspace_dir: stateDirectory,
    },
    paths,
    codeSha: "sha-rotation",
    snapshotPath: stateDirectory,
    codexAdapterMode: "sdk",
    codexCliPath: process.execPath,
    claudeRuntimeV2Enabled: true,
    claudeRuntimeIdleTtlMs: 300_000,
    claudeRuntimeMaxEntries: 16,
    claudeRuntimeTurnTimeoutMs: 1_800_000,
    internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
    codexHome: null,
    rolloutRoot: null,
  };
  const runtime = new RunnerChildRuntime(config, pino({ level: "silent" }), {
    createEngine: () => rotationEngine(config.backend, stateDirectory),
  });
  await runtime.start();
  return { runtime, sessionId };
}

function rotationEngine(backendId: RunnerChildConfig["backend"], workspaceDir: string): EnginePort {
  return {
    backendId,
    workspaceDir,
    async *execute() {},
    async interrupt() { return true; },
    async close() {},
  };
}

function rotationCommand(sessionId: string): Extract<RunnerCommandFrame, { kind: "execute" }> {
  return executeCommandFrame("rotate-backend-session", {
    agentSessionId: sessionId,
    prompt: "continue with a new native session",
    backendSessionRolloverFrom: "backend-session-old",
  });
}

async function createRotationOutbox(
  sessionId: string,
  backendSessionId: string,
): Promise<RunnerSqliteEventOutbox> {
  const directory = await mkdtemp(join(tmpdir(), "soulstream-runner-rotation-outbox-"));
  directories.push(directory);
  const outbox = await RunnerSqliteEventOutbox.create(join(directory, "outbox.sqlite"));
  await outbox.initializeBootstrap(rotationBootstrapInput(
    sessionId,
    directory,
    backendSessionId,
  ));
  return outbox;
}

function rotationBootstrapInput(
  sessionId: string,
  directory: string,
  backendSessionId: string,
) {
  return {
    session_id: sessionId,
    created_at: "2026-10-05T00:00:00.000Z",
    resume: {
      schema_version: 1,
      backend_session_id: backendSessionId,
      cwd: directory,
      codex_home: null,
      rollout_root: null,
      code_sha: "sha-rotation",
      snapshot_path: directory,
    },
  };
}

async function appendRotation(
  outbox: RunnerSqliteEventOutbox,
  sessionId: string,
  rotation: { expectedBackendSessionId: string; backendSessionId: string },
): Promise<void> {
  const effect = backendSessionRotationEffect(
    rotation.expectedBackendSessionId,
    rotation.backendSessionId,
  );
  const durable = buildDurableRunnerEvent(sessionId, {
    type: "session",
    session_id: rotation.backendSessionId,
  } as SSEEventPayload, effect);
  await outbox.appendEngineFrame(durable.appendInput, durable.frame, rotation);
}

function standaloneEngine(workspaceDir: string): EnginePort {
  return {
    backendId: "codex",
    workspaceDir,
    async *execute() {},
    async interrupt() { return true; },
    async close() {},
  };
}

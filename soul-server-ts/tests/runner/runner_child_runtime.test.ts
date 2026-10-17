import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import type { AttachmentDescriptor } from "@soulstream/wire-schema/attachments";
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
    expect(requiresBackendSessionId("antigravity")).toBe(true);
    expect(requiresBackendSessionId("opencode")).toBe(true);
    expect(requiresBackendSessionId("openai-agents")).toBe(false);
  });
  it("removes internal dedupe metadata before the durable frame crosses IPC", async () => {
    const event = {
      type: "assistant_message",
      content: "durable",
      timestamp: 1,
      _dedupe_key: "delivery:1",
    } as SSEEventPayload;

    const durable = await buildDurableRunnerEvent("session-a", event);

    expect(durable.appendInput.semantic_dedupe_key).toBe("delivery:1");
    expect(durable.appendInput.payload).not.toHaveProperty("_dedupe_key");
    expect(durable.frame.payload).toEqual(durable.appendInput.payload);
  });

  it("truncates 3 MiB Codex command and file_change results and keeps the following assistant event", async () => {
    const descriptor = {
      attachment_id: "attachment-large",
      name: "tool_result-0123456789abcdef.txt",
      mime_type: "text/plain",
      byte_size: 3 * 1024 * 1024,
      checksum_sha256: "a".repeat(64),
      width: null,
      height: null,
      preview_kind: "text",
      preview_mime_type: "text/plain",
    } satisfies AttachmentDescriptor;
    const archive = vi.fn(async () => descriptor);
    const commandResult = "c".repeat(3 * 1024 * 1024);
    const fileChangeResult = JSON.stringify([{
      path: "large.txt",
      diff: "f".repeat(3 * 1024 * 1024),
    }]);
    const events = [
      {
        type: "tool_result",
        tool_name: "command",
        tool_use_id: "command-1",
        result: commandResult,
        attachment_ids: ["preexisting-attachment"],
        is_error: false,
        timestamp: 1,
      },
      {
        type: "tool_result",
        tool_name: "file_change",
        tool_use_id: "file-change-1",
        result: fileChangeResult,
        is_error: false,
        timestamp: 2,
      },
      { type: "assistant_message", content: "done", timestamp: 3 },
    ] as unknown as SSEEventPayload[];

    const durableEvents = [];
    for (const event of events) {
      durableEvents.push(await buildDurableRunnerEvent(
        "session-a",
        event,
        undefined,
        undefined,
        archive,
      ));
    }

    expect(durableEvents).toHaveLength(3);
    for (const [index, durable] of durableEvents.slice(0, 2).entries()) {
      expect(Buffer.byteLength(JSON.stringify(durable.appendInput), "utf8"))
        .toBeLessThan(2 * 1024 * 1024);
      expect(durable.appendInput.payload.truncation).toMatchObject({
        attachment: descriptor,
      });
      expect(durable.appendInput.payload.attachment_ids).toEqual(index === 0
        ? ["preexisting-attachment", descriptor.attachment_id]
        : [descriptor.attachment_id]);
      expect(durable.frame.payload).toEqual(durable.appendInput.payload);
    }
    expect(archive).toHaveBeenCalledTimes(2);
    expect(durableEvents[2]?.appendInput.payload).not.toHaveProperty("truncation");
    expect(durableEvents[2]?.appendInput.payload).not.toHaveProperty("attachment_ids");
  });

  it("keeps archiving failures out of the runner event path and continues with the next event", async () => {
    const archive = vi.fn(async () => { throw new Error("archive unavailable"); });
    const large = {
      type: "tool_result",
      tool_name: "command",
      tool_use_id: "command-2",
      result: "x".repeat(3 * 1024 * 1024),
      is_error: false,
      timestamp: 1,
    } as unknown as SSEEventPayload;

    const first = await buildDurableRunnerEvent("session-a", large, undefined, undefined, archive);
    const second = await buildDurableRunnerEvent("session-a", {
      type: "assistant_message",
      content: "next event",
      timestamp: 2,
    } as SSEEventPayload, undefined, undefined, archive);

    expect(first.appendInput.payload.truncation).toMatchObject({ attachment: null });
    expect(first.appendInput.payload).not.toHaveProperty("attachment_ids");
    expect(first.frame.payload).toEqual(first.appendInput.payload);
    expect(second.appendInput.payload.content).toBe("next event");
    expect(second.appendInput.payload).not.toHaveProperty("truncation");

    const nullArchive = vi.fn(async () => null);
    const nullResult = await buildDurableRunnerEvent("session-a", {
      type: "tool_result",
      tool_name: "command",
      tool_use_id: "command-3",
      result: "y".repeat(3 * 1024 * 1024),
      attachment_ids: ["keep-existing"],
      is_error: false,
      timestamp: 3,
    } as unknown as SSEEventPayload, undefined, undefined, nullArchive);
    expect(nullResult.appendInput.payload.truncation).toMatchObject({ attachment: null });
    expect(nullResult.appendInput.payload.attachment_ids).toEqual(["keep-existing"]);
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
  it("persists an OpenCode fatal after the rate-limit session frame bootstraps the runner", async () => {
    const fatal = {
      type: "error",
      fatal: true,
      message: "OpenCode free tier rate limit exceeded (Rate limit exceeded). Try again later or use another model.",
      model: "opencode/deepseek-v4.1-flash-free",
      timestamp: 1,
    } as SSEEventPayload;
    const { runtime, sessionId } = await createRotationRuntime(null, [], "opencode");
    const child = runtime as unknown as RunnerChildRuntimeRotationHarness;
    const command = executeCommandFrame("opencode-rate-limit", {
      agentSessionId: sessionId,
      prompt: "retry after the limit clears",
    });
    child.activeCommandId = command.commandId;
    const preBootstrap = { frames: [] as RunnerEventFrame[], bytes: 0 };
    try {
      await child.prepareExecution(command);
      await child.forwardRunnerFrame(
        engineEventFrame({ type: "session", session_id: "ses_rate_limit_runner" }),
        preBootstrap,
      );
      await child.forwardRunnerFrame(engineEventFrame(fatal), preBootstrap);

      await expect(child.outbox.readBootstrap()).resolves.toMatchObject({
        payload: { backend_session_id: "ses_rate_limit_runner" },
      });
      expect((await child.outbox.readBatch())?.events.map((event) => event.payload.type))
        .toEqual(["session", "error"]);
      expect((await child.outbox.readBatch())?.events[1]?.payload).toMatchObject(fatal);
    } finally {
      await runtime.shutdown();
    }
  });

  it.each([true, false])("records a naturally ended fatal=%s stream in the lifecycle and end frame", async (fatal) => {
    const error = { type: "error", message: "provider rejected model", fatal, timestamp: 1 } as SSEEventPayload;
    const { runtime, sessionId } = await createRotationRuntime("backend-session-old", [error]);
    const child = runtime as unknown as RunnerChildRuntimeRotationHarness;
    const command = executeCommandFrame("fatal-turn", {
      agentSessionId: sessionId, prompt: "continue", resumeSessionId: "backend-session-old",
    });
    const send = vi.spyOn(child, "sendRequired").mockResolvedValue(undefined);
    try {
      await child.dispatcher.dispatch(command);
      await child.drainExecution(command);
      expect(child.lifecycle.read()).toMatchObject({ execution_state: fatal ? "failed" : "completed" });
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: "execution_ended",
        ...(fatal ? { error: { code: "execution_failed", message: error.message } } : {}),
      }));
      expect((await child.outbox.readBatch())?.events.map((event) => event.payload)).toContainEqual(
        expect.objectContaining({ type: "error", fatal, message: error.message }),
      );
    } finally {
      await runtime.shutdown();
    }
  });

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
  dispatcher: { dispatch(frame: unknown): Promise<unknown> };
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

async function createRotationRuntime(
  backendSessionId: string | null,
  events: SSEEventPayload[] = [],
  backend: RunnerChildConfig["backend"] = "codex",
): Promise<{
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
    backend,
    agent: {
      id: "rotation-agent",
      name: "Rotation Agent",
      backend,
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
    createEngine: () => ({ ...rotationEngine(config.backend, stateDirectory),
      async *execute() { yield* events; },
    }),
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
  const durable = await buildDurableRunnerEvent(sessionId, {
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

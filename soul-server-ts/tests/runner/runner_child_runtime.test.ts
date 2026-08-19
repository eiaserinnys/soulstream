import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import { RunnerChildRuntime } from "../../src/runner/runner_child_runtime.js";
import {
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

function standaloneEngine(workspaceDir: string): EnginePort {
  return {
    backendId: "codex",
    workspaceDir,
    async *execute() {},
    async interrupt() { return true; },
    async close() {},
  };
}

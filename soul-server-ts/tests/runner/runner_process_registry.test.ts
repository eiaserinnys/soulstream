import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyRunnerRegistration,
  inspectRunnerDurableState,
  listLiveRunnerSessionIds,
  scanRunnerRegistrations,
  type RunnerRegistration,
} from "../../src/runner/runner_process_registry.js";
import { resolveRegisteredRunnerPid } from "../../src/runner/runner_process_spawn.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import {
  runnerLifecycleSummaryPath,
  RunnerSqliteLifecycle,
} from "../../src/runner/sqlite_runner_lifecycle.js";
import {
  pendingRunnerRegistrationIdentity,
  writeRunnerRegistrationIdentity,
} from "../../src/runner/runner_registration_identity.js";

const temporaryDirectories: string[] = [];
const NOW = Date.parse("2026-08-11T00:00:30.000Z");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("runner process registry", () => {
  it("uses lifecycle pid evidence when the pid sidecar is missing", () => {
    expect(resolveRegisteredRunnerPid(null, 4123, 4123, "session-a")).toBe(4123);
    expect(() => resolveRegisteredRunnerPid(null, 4123, 4999, "session-a"))
      .toThrow("runner pid evidence disagrees: session-a");
  });
  it("classifies bootstrap grace, live prebootstrap, and durable terminal state", () => {
    const pending = {
      ...registration({ pidAlive: false }),
      registeredAtMs: NOW - 1_000,
      bootstrap: null,
      lifecycle: null,
    };
    expect(classifyRunnerRegistration(pending, NOW, 120_000)).toBe("wait_for_bootstrap");
    expect(classifyRunnerRegistration(
      { ...pending, registeredAtMs: NOW - 120_000 },
      NOW,
      120_000,
    )).toBe("reap_dead");
    expect(classifyRunnerRegistration({ ...pending, pidAlive: true }, NOW, 120_000))
      .toBe("adopt_prebootstrap");
    expect(classifyRunnerRegistration(registration({
      pidAlive: false,
      lifecycleState: "failed",
    }), NOW, 120_000)).toBe("replay_terminal");
  });

  it("reaps a hung execution with fresh liveness but no actual progress", () => {
    expect(classifyRunnerRegistration(registration({
      progressedAt: "2026-08-11T00:00:00.000Z",
      livenessAt: "2026-08-11T00:00:29.000Z",
      inFlightTools: [],
    }), NOW, 10_000)).toBe("reap_stalled");
  });

  it("reaps a hung tool after its finite tool lease expires", () => {
    expect(classifyRunnerRegistration(registration({
      progressedAt: "2026-08-10T22:59:59.999Z",
      livenessAt: "2026-08-11T00:00:29.000Z",
      inFlightTools: [{
        tool_use_id: "tool-hung",
        started_at: "2026-08-10T22:59:59.999Z",
      }],
    }), NOW, 10_000)).toBe("reap_stalled");
  });

  it("reaps a tool whose completion event is lost after the finite tool lease", () => {
    expect(classifyRunnerRegistration(registration({
      progressedAt: "2026-08-10T23:59:00.000Z",
      livenessAt: "2026-08-11T00:00:29.000Z",
      inFlightTools: [{
        tool_use_id: "tool-result-lost",
        started_at: "2026-08-10T22:59:59.999Z",
      }],
    }), NOW, 10_000)).toBe("reap_stalled");
  });

  it("preserves a normal thirty-minute tool call below the finite tool lease cap", () => {
    expect(classifyRunnerRegistration(registration({
      progressedAt: "2026-08-10T23:30:00.000Z",
      livenessAt: "2026-08-11T00:00:29.000Z",
      inFlightTools: [{
        tool_use_id: "tool-long",
        started_at: "2026-08-10T23:30:00.000Z",
      }],
    }), NOW, 1_800_000)).toBe("adopt_running");
  });

  it("leaves a normally progressing execution untouched", () => {
    expect(classifyRunnerRegistration(registration({
      progressedAt: "2026-08-11T00:00:25.000Z",
      livenessAt: "2026-08-11T00:00:29.000Z",
      inFlightTools: [],
    }), NOW, 10_000)).toBe("adopt_running");
  });

  it("reports only live lease dispositions and deduplicates the reconnect inventory", async () => {
    const registrations = [
      { ...registration({ sessionId: "session-pre" }), bootstrap: null, lifecycle: null },
      registration({ sessionId: "session-live" }),
      registration({ sessionId: "session-live" }),
      registration({ sessionId: "session-dead", pidAlive: false }),
      registration({ sessionId: "session-terminal", lifecycleState: "completed" }),
    ];
    await expect(listLiveRunnerSessionIds({
      stateDirectory: "/runner",
      leaseTimeoutMs: 120_000,
      now: () => NOW,
      scan: async () => ({ registrations, errors: [] }),
    })).resolves.toEqual(["session-live", "session-pre"]);
  });

  it("includes a recovered damaged neighbor identity in the conservative inventory", async () => {
    const failure = new Error("runner registration unreadable");
    const onScanError = vi.fn();
    await expect(listLiveRunnerSessionIds({
      stateDirectory: "/runner",
      leaseTimeoutMs: 120_000,
      now: () => NOW,
      scan: async () => ({
        registrations: [registration({ sessionId: "session-live" })],
        errors: [{
          directory: "/runner/session-unknown",
          error: failure,
          sessionId: "session-unknown",
        }],
      }),
      onScanError,
    })).resolves.toEqual(["session-live", "session-unknown"]);
    expect(onScanError).toHaveBeenCalledOnce();
  });

  it("refuses partial inventory when a damaged directory has no recoverable identity", async () => {
    const failure = new Error("runner identity cannot be recovered");
    await expect(listLiveRunnerSessionIds({
      stateDirectory: "/runner",
      leaseTimeoutMs: 120_000,
      now: () => NOW,
      scan: async () => ({
        registrations: [registration({ sessionId: "session-live" })],
        errors: [{ directory: "/runner/unidentified", error: failure }],
      }),
    })).rejects.toThrow("runner inventory incomplete: identity unavailable for /runner/unidentified");
  });

  it("keeps the periodic scan lightweight and never opens the event outbox", async () => {
    const stateDirectory = await temporaryDirectory("light");
    const paths = runnerProcessPaths(stateDirectory, "session-a");
    await mkdir(paths.sessionDirectory, { recursive: true });
    await writeFile(paths.configPath, JSON.stringify({ ...registration().config, paths }));
    await writeFile(paths.databasePath, "not-opened-by-periodic-scan");
    await writeFile(
      runnerLifecycleSummaryPath(paths.databasePath),
      JSON.stringify(registration().lifecycle),
    );
    const open = vi.spyOn(RunnerSqliteEventOutbox, "open");
    const result = await scanRunnerRegistrations(stateDirectory);
    expect(result.errors).toEqual([]);
    expect(result.registrations[0]).toMatchObject({
      bootstrap: null,
      lifecycle: { execution_state: "running" },
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("reports a missing database without recreating recovery state", async () => {
    const stateDirectory = await temporaryDirectory("missing-db");
    const paths = runnerProcessPaths(stateDirectory, "session-a");
    await mkdir(paths.sessionDirectory, { recursive: true });
    await writeFile(paths.configPath, JSON.stringify({ ...registration().config, paths }));
    const result = await scanRunnerRegistrations(stateDirectory);
    expect(result.registrations).toEqual([]);
    expect(result.errors[0]).toMatchObject({ directory: paths.sessionDirectory });
    await expect(access(paths.databasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a damaged config identity from the independent sidecar", async () => {
    const stateDirectory = await temporaryDirectory("sidecar");
    const paths = runnerProcessPaths(stateDirectory, "session-sidecar");
    await mkdir(paths.sessionDirectory, { recursive: true });
    await writeFile(paths.configPath, "{damaged");
    await writeRunnerRegistrationIdentity(
      paths.sessionDirectory,
      pendingRunnerRegistrationIdentity("session-sidecar", "release-sidecar"),
    );
    const result = await scanRunnerRegistrations(stateDirectory);
    expect(result.errors[0]).toMatchObject({
      sessionId: "session-sidecar",
      codeSha: "release-sidecar",
    });
    await expect(listLiveRunnerSessionIds({ stateDirectory, leaseTimeoutMs: 120_000 }))
      .resolves.toEqual(["session-sidecar"]);
  });

  it("recovers a damaged config identity from SQLite when no sidecar exists", async () => {
    const stateDirectory = await temporaryDirectory("sqlite");
    const paths = runnerProcessPaths(stateDirectory, "session-sqlite");
    await mkdir(paths.sessionDirectory, { recursive: true });
    const outbox = await RunnerSqliteEventOutbox.create(paths.databasePath);
    await outbox.initializeBootstrap({
      session_id: "session-sqlite",
      created_at: "2026-08-11T00:00:00.000Z",
      resume: {
        schema_version: 1,
        backend_session_id: "backend-sqlite",
        cwd: "/workspace/a",
        codex_home: "/home/test/.codex",
        rollout_root: "/home/test/.codex/sessions",
        code_sha: "release-sqlite",
        snapshot_path: "/release/release-sqlite/soul-server-ts",
      },
    });
    outbox.close();
    await writeFile(paths.configPath, "{damaged");
    const result = await scanRunnerRegistrations(stateDirectory);
    expect(result.errors[0]).toMatchObject({
      sessionId: "session-sqlite",
      codeSha: "release-sqlite",
    });
    await expect(listLiveRunnerSessionIds({ stateDirectory, leaseTimeoutMs: 120_000 }))
      .resolves.toEqual(["session-sqlite"]);
  });

  it("drops orphaned host-call receipts while inspecting a dead terminal runner", async () => {
    const stateDirectory = await temporaryDirectory("terminal-host-call");
    const paths = runnerProcessPaths(stateDirectory, "session-a");
    await mkdir(paths.sessionDirectory, { recursive: true });
    const outbox = await RunnerSqliteEventOutbox.create(paths.databasePath);
    await outbox.initializeBootstrap({
      session_id: "session-a",
      created_at: "2026-08-11T00:00:00.000Z",
      resume: {
        schema_version: 1,
        backend_session_id: "backend-a",
        cwd: "/workspace/a",
        codex_home: "/home/test/.codex",
        rollout_root: "/home/test/.codex/sessions",
        code_sha: "release-a",
        snapshot_path: "/release/release-a/soul-server-ts",
      },
    });
    await outbox.recordHostCallApplied({
      correlationId: "host:orphaned",
      service: "snapshot",
      operation: "persistRunState",
      createdAt: "2026-08-11T00:00:01.000Z",
    });
    outbox.close();
    const lifecycle = RunnerSqliteLifecycle.open(paths.databasePath);
    lifecycle.begin({
      pid: 4123,
      commandId: "execute-a",
      progressedAt: "2026-08-11T00:00:01.000Z",
    });
    lifecycle.finish("execute-a", "completed", "2026-08-11T00:00:02.000Z");
    lifecycle.close();
    const current = registration({ pidAlive: false, lifecycleState: "completed" });
    current.config = { ...current.config, paths };

    await expect(inspectRunnerDurableState(current)).resolves.toMatchObject({
      incompleteDurableWork: false,
      registration: { lifecycle: { execution_state: "completed" } },
    });
    const recovered = await RunnerSqliteEventOutbox.open(paths.databasePath);
    await expect(recovered.readHostCallApplied("host:orphaned")).resolves.toBeNull();
    recovered.close();
  });
});

function registration(options: {
  sessionId?: string;
  pidAlive?: boolean;
  lifecycleState?: "running" | "completed" | "failed";
  progressedAt?: string;
  livenessAt?: string;
  inFlightTools?: Array<{ tool_use_id: string; started_at: string }>;
} = {}): RunnerRegistration {
  const sessionId = options.sessionId ?? "session-a";
  return {
    config: {
      schemaVersion: 1,
      sessionId,
      backend: "codex",
      agent: { id: "agent-a", name: "Agent A", backend: "codex", workspace_dir: "/workspace" },
      paths: {
        sessionDirectory: `/runner/${sessionId}`,
        databasePath: `/runner/${sessionId}/runner.sqlite`,
        socketPath: `/runner/${sessionId}/runner.sock`,
        pidPath: `/runner/${sessionId}/runner.pid`,
        lockPath: `/runner/${sessionId}/runner.lock`,
        configPath: `/runner/${sessionId}/runner-config.json`,
      },
      codeSha: "release-a",
      snapshotPath: "/release/release-a",
      codexAdapterMode: "sdk",
      claudeRuntimeV2Enabled: true,
      claudeRuntimeIdleTtlMs: 300_000,
      claudeRuntimeMaxEntries: 16,
      claudeRuntimeTurnTimeoutMs: 1_800_000,
      internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
      codexHome: "/home/test/.codex",
      rolloutRoot: "/home/test/.codex/sessions",
    },
    pid: 4123,
    pidAlive: options.pidAlive ?? true,
    registeredAtMs: Date.parse("2026-08-11T00:00:00.000Z"),
    bootstrap: { payload: { code_sha: "release-a" } } as never,
    lifecycle: {
      session_id: sessionId,
      runner_pid: 4123,
      execution_command_id: "execute-a",
      execution_state: options.lifecycleState ?? "running",
      progress_seq: 3,
      progress_at: options.progressedAt ?? "2026-08-11T00:00:20.000Z",
      liveness_at: options.livenessAt ?? "2026-08-11T00:00:20.000Z",
      in_flight_tools: options.inFlightTools ?? [],
      terminal_error: null,
    },
  };
}

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `runner-registry-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

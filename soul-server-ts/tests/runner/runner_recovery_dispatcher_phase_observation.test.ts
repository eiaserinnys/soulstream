import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunnerProcessDispatcher } from
  "../../src/runner/runner_process_dispatcher.js";
import { createRunnerPhaseObservation } from
  "../../src/runner/runner_phase_observation.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import { RunnerSocketEndpoint } from "../../src/runner/runner_socket_endpoint.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import { RunnerSqliteLifecycle } from "../../src/runner/sqlite_runner_lifecycle.js";
import { EventOutboxPump } from "../../src/upstream/event_outbox_pump.js";
import { EventOutboxPumpMux } from "../../src/upstream/event_outbox_pump_mux.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("recovery dispatcher phase observation", () => {
  it.each(["adopt", "replay", "offline"] as const)(
    "records actual outbox open and recovery reads during %s initialization",
    async (mode) => {
      const stateDirectory = await mkdtemp(join(tmpdir(), "runner-recovery-observation-"));
      directories.push(stateDirectory);
      const paths = runnerProcessPaths(stateDirectory, "session-a");
      await mkdir(paths.sessionDirectory, { recursive: true });
      const writer = await RunnerSqliteEventOutbox.create(paths.databasePath, {
        sessionId: "session-a",
      });
      await writer.initializeBootstrap({
        session_id: "session-a",
        created_at: "2026-10-12T00:00:00.000Z",
        resume: {
          schema_version: 1,
          backend_session_id: "backend-a",
          cwd: "/workspace/a",
          codex_home: "/home/test/.codex",
          rollout_root: "/home/test/.codex/sessions",
          code_sha: "sha-a",
          snapshot_path: "/release/sha-a/soul-server-ts",
        },
      });
      writer.close();
      const lifecycle = RunnerSqliteLifecycle.open(paths.databasePath, "session-a");
      lifecycle.begin({
        pid: 1001,
        commandId: "execute-old",
        progressedAt: "2026-10-12T00:00:00.000Z",
      });
      lifecycle.finish("execute-old", "completed", "2026-10-12T00:00:01.000Z");
      lifecycle.close();

      let now = 0;
      const startedPhases: string[] = [];
      const finishedPhases: string[] = [];
      const observation = createRunnerPhaseObservation({
        nodeId: "node-test",
        scopeId: `recovery-${mode}`,
        operation: "runnerRecovery.scan",
        logger: { warn: vi.fn() },
        monotonicNow: () => now++,
        beginRunnerOperation: ({ phase }) => {
          startedPhases.push(phase ?? "");
          return () => finishedPhases.push(phase ?? "");
        },
      });
      const endpoint = mode === "offline"
        ? undefined
        : new RunnerSocketEndpoint(paths.socketPath, async () => undefined, vi.fn());
      await endpoint?.listen();
      const dispatcher = new RunnerProcessDispatcher({
        spawn: spawnInput(stateDirectory),
        runnerProcess: mode === "offline"
          ? null
          : {
            pid: 1001,
            registrationId: "registration-a",
            paths,
            config: {} as never,
            adopted: true,
          },
        offlineExisting: mode === "offline",
        pumpMux: new EventOutboxPumpMux(
          new EventOutboxPump(emptyStore("node-stream"), vi.fn()),
        ),
        logger: pino({ level: "silent" }),
        phaseObservation: observation,
        handleHostCall: async () => null,
      });

      try {
        const frames = [];
        for await (const frame of dispatcher.recoverFrames("execute-old")) {
          frames.push(frame);
        }
        expect(frames).toEqual([]);

        const summary = observation.databaseSummary();
        expect(summary).toBeDefined();
        expect(summary?.counts.dbOpen).toBeGreaterThan(0);
        expect(summary?.counts.dbRead).toBeGreaterThan(0);
        expect(summary?.failures).toEqual({ dbOpen: 0, dbRead: 0 });
        expect(startedPhases).toContain("dbOpen");
        expect(startedPhases).toContain("dbRead");
        expect(finishedPhases).toEqual(startedPhases);
        expect(summary?.recentSamples).toEqual(expect.arrayContaining([
          expect.objectContaining({
            phase: "dbOpen",
            databasePath: paths.databasePath,
            label: "runner outbox recovery open",
          }),
          expect.objectContaining({
            phase: "dbRead",
            databasePath: paths.databasePath,
            label: "runner outbox snapshot recovery",
          }),
        ]));
        if (mode === "offline") {
          expect(summary?.recentSamples).toEqual(expect.arrayContaining([
            expect.objectContaining({
              phase: "dbOpen",
              databasePath: paths.databasePath,
              label: "runner writable outbox open",
            }),
            expect.objectContaining({
              phase: "dbRead",
              databasePath: paths.databasePath,
              label: "runner writable outbox recovery",
            }),
          ]));
        }
      } finally {
        if (mode === "offline") await dispatcher.close();
        else await dispatcher.detachHost();
        await endpoint?.close();
      }
    },
  );
});

function spawnInput(stateDirectory: string) {
  return {
    stateDirectory,
    sessionId: "session-a",
    backend: "codex" as const,
    agent: {
      id: "agent-a",
      name: "Agent A",
      backend: "codex" as const,
      workspace_dir: "/workspace/a",
    },
    codeSha: "sha-a",
    snapshotPath: "/release/sha-a/soul-server-ts",
    codexAdapterMode: "sdk" as const,
    claudeRuntimeV2Enabled: true,
    claudeRuntimeIdleTtlMs: 300_000,
    claudeRuntimeMaxEntries: 16,
    claudeRuntimeTurnTimeoutMs: 1_800_000,
    codexHome: "/home/test/.codex",
    rolloutRoot: "/home/test/.codex/sessions",
  };
}

function emptyStore(streamId: string) {
  return {
    streamId,
    ackedSeq: 0,
    onAppend: () => () => {},
    async readBatch() { return null; },
    async acknowledge() {},
  };
}

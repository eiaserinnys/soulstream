import { renameSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EVENT_OUTBOX_COMPACT_ROWS } from "../../src/upstream/event_outbox.js";
import {
  classifyRunnerRegistration,
  inspectRunnerDurableState,
  listLiveRunnerSessionIds,
  scanRunnerRegistrations,
  type RunnerRegistration,
} from "../../src/runner/runner_process_registry.js";
import { resolveRegisteredRunnerPid } from "../../src/runner/runner_process_spawn.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import {
  RunnerHostStateStore,
  runnerHostStatePath,
} from "../../src/runner/runner_host_state_store.js";
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
    expect(resolveRegisteredRunnerPid(
      null,
      4123,
      4999,
      "session-a",
      () => false,
    )).toBe(4999);
    expect(() => resolveRegisteredRunnerPid(
      null,
      4123,
      4999,
      "session-a",
      (pid) => pid === 4123,
    ))
      .toThrow("runner pid evidence disagrees: session-a");
  });

  it("classifies mismatched all-dead pid evidence as a dead registration", async () => {
    const stateDirectory = await temporaryDirectory("all-dead-pid-evidence");
    const paths = runnerProcessPaths(stateDirectory, "session-all-dead");
    const current = registration({ sessionId: "session-all-dead" });
    current.config = { ...current.config, paths };
    const lifecyclePid = 2_147_483_601;
    const identityPid = 2_147_483_602;
    await mkdir(paths.sessionDirectory, { recursive: true });
    await writeFile(paths.configPath, JSON.stringify(current.config));
    await writeFile(paths.pidPath, `${identityPid}\n`);
    await writeRunnerRegistrationIdentity(paths.sessionDirectory, {
      ...pendingRunnerRegistrationIdentity(current.config.sessionId, current.config.codeSha),
      pid: identityPid,
      startIdentity: `dead-${identityPid}`,
    });
    const outbox = await RunnerSqliteEventOutbox.create(paths.databasePath);
    await outbox.initializeBootstrap({
      session_id: current.config.sessionId,
      created_at: "2026-08-11T00:00:00.000Z",
      resume: {
        schema_version: 1,
        backend_session_id: "backend-all-dead",
        cwd: "/workspace/a",
        codex_home: "/home/test/.codex",
        rollout_root: "/home/test/.codex/sessions",
        code_sha: current.config.codeSha,
        snapshot_path: current.config.snapshotPath,
      },
    });
    outbox.close();
    const lifecycle = RunnerSqliteLifecycle.open(paths.databasePath);
    lifecycle.begin({
      pid: lifecyclePid,
      commandId: "execute-all-dead",
      progressedAt: "2026-08-11T00:00:29.000Z",
    });
    lifecycle.close();

    const result = await scanRunnerRegistrations(stateDirectory);

    expect(result.errors).toEqual([]);
    expect(result.registrations).toHaveLength(1);
    expect(result.registrations[0]).toMatchObject({
      pid: identityPid,
      pidAlive: false,
      lifecycle: { runner_pid: lifecyclePid, execution_state: "running" },
    });
    expect(classifyRunnerRegistration(result.registrations[0]!, NOW, 120_000))
      .toBe("reap_dead");
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
    }), NOW, 120_000)).toBe("replay_terminal_dead");
  });

  /**
   * 260820 incident: a terminal lifecycle short-circuited the liveness check,
   * so a runner whose process had already exited was still classified as
   * something to attach to.
   */
  it("separates a terminal runner that is still running from one that is gone", () => {
    expect(classifyRunnerRegistration(registration({
      pidAlive: true,
      lifecycleState: "completed",
    }), NOW, 120_000)).toBe("replay_terminal");
    expect(classifyRunnerRegistration(registration({
      pidAlive: false,
      lifecycleState: "completed",
    }), NOW, 120_000)).toBe("replay_terminal_dead");
  });

  it("never revives a retired registration from stale lifecycle or a reused pid", () => {
    expect(classifyRunnerRegistration({
      ...registration({ pidAlive: true, lifecycleState: "running" }),
      retiredAt: "2026-08-11T00:00:29.000Z",
    }, NOW, 120_000)).toBe("retired_terminal");
  });

  it("reaps a hung execution with fresh liveness but no actual progress", () => {
    expect(classifyRunnerRegistration(registration({
      progressedAt: "2026-08-10T23:29:59.999Z",
      livenessAt: "2026-08-11T00:00:29.000Z",
      inFlightTools: [],
    }), NOW, 10_000)).toBe("reap_stalled");
  });

  it("reaps a hung tool after the configured progress gap expires", () => {
    expect(classifyRunnerRegistration(registration({
      progressedAt: "2026-08-10T22:59:59.999Z",
      livenessAt: "2026-08-11T00:00:29.000Z",
      inFlightTools: [{
        tool_use_id: "tool-hung",
        started_at: "2026-08-10T22:59:59.999Z",
      }],
    }), NOW, 10_000)).toBe("reap_stalled");
  });

  it("keeps a night-long tool when durable runner progress is fresh", () => {
    expect(classifyRunnerRegistration(registration({
      progressedAt: "2026-08-11T00:00:29.000Z",
      livenessAt: "2026-08-11T00:00:29.000Z",
      inFlightTools: [{
        tool_use_id: "tool-expired",
        started_at: "2026-08-10T22:59:59.999Z",
      }],
    }), NOW, 10_000)).toBe("adopt_running");
  });

  it("keeps a tool below the progress inactivity threshold even when its start is old", () => {
    expect(classifyRunnerRegistration(registration({
      progressedAt: "2026-08-10T23:59:00.000Z",
      livenessAt: "2026-08-11T00:00:29.000Z",
      inFlightTools: [{
        tool_use_id: "tool-result-lost",
        started_at: "2026-08-10T22:59:59.999Z",
      }],
    }), NOW, 10_000)).toBe("adopt_running");
  });

  it("reaps repeated duplicate tool starts after the progress gap expires", async () => {
    const directory = await temporaryDirectory("duplicate-tool-starts");
    const databasePath = join(directory, "runner.sqlite");
    const outbox = await RunnerSqliteEventOutbox.create(databasePath);
    await outbox.initializeBootstrap({
      session_id: "session-a",
      created_at: "2026-07-12T00:00:00.000Z",
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
    outbox.close();
    const lifecycle = RunnerSqliteLifecycle.open(databasePath);
    lifecycle.begin({
      pid: 4123,
      commandId: "execute-a",
      progressedAt: "2026-07-12T00:00:00.000Z",
    });
    lifecycle.toolStarted("execute-a", "tool-duplicate", "2026-07-12T00:00:01.000Z");
    for (const repeatedAt of [
      "2026-07-12T01:00:01.000Z",
      "2026-07-13T00:00:01.000Z",
      "2026-08-10T00:00:01.000Z",
      "2026-08-11T00:00:29.000Z",
    ]) {
      lifecycle.toolStarted("execute-a", "tool-duplicate", repeatedAt);
    }
    const durable = lifecycle.read();
    lifecycle.close();

    expect(durable).toMatchObject({
      progress_seq: 2,
      progress_at: "2026-07-12T00:00:01.000Z",
      in_flight_tools: [{
        tool_use_id: "tool-duplicate",
        started_at: "2026-07-12T00:00:01.000Z",
      }],
    });
    expect(classifyRunnerRegistration({
      ...registration(),
      lifecycle: durable,
    }, NOW, 10_000)).toBe("reap_stalled");
  });

  it("preserves an in-flight tool below the configured progress gap", () => {
    expect(classifyRunnerRegistration(registration({
      progressedAt: "2026-08-10T23:31:00.000Z",
      livenessAt: "2026-08-11T00:00:29.000Z",
      inFlightTools: [{
        tool_use_id: "tool-long",
        started_at: "2026-08-10T20:00:00.000Z",
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

  it("excludes reserved runner-state infrastructure from recovery scans", async () => {
    const stateDirectory = await temporaryDirectory("reserved-infrastructure-scan");
    const controlDirectory = join(stateDirectory, "_control");
    await mkdir(controlDirectory);
    await writeFile(join(controlDirectory, "control-inbox.sqlite"), "not-a-runner-database");

    await expect(scanRunnerRegistrations(stateDirectory)).resolves.toEqual({
      registrations: [],
      errors: [],
    });
  });

  it.each([
    "sessionDirectory",
    "databasePath",
    "socketPath",
    "pidPath",
    "lockPath",
    "configPath",
    "logPath",
  ] as const)("fails closed when runner config %s is not canonical", async (pathField) => {
    const stateDirectory = await temporaryDirectory(`noncanonical-${pathField}`);
    const paths = runnerProcessPaths(stateDirectory, "session-paths");
    const current = registration({ sessionId: "session-paths" });
    current.config = {
      ...current.config,
      paths: { ...paths, [pathField]: `${paths[pathField]}.other` },
    };
    await mkdir(paths.sessionDirectory, { recursive: true });
    await writeFile(paths.configPath, JSON.stringify(current.config));

    const result = await scanRunnerRegistrations(stateDirectory);

    expect(result.registrations).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      directory: paths.sessionDirectory,
      sessionId: "session-paths",
      codeSha: "release-a",
      error: { message: `runner config paths mismatch: ${paths.sessionDirectory}` },
    });
  });

  it("skips a registration directory collected during the inventory scan and logs it", async () => {
    const stateDirectory = await temporaryDirectory("inventory-gc-race");
    const collectedDirectory = join(stateDirectory, "collected");
    await mkdir(collectedDirectory);
    const logger = { info: vi.fn() };

    await expect(listLiveRunnerSessionIds({
      stateDirectory,
      leaseTimeoutMs: 120_000,
      now: () => NOW,
      scan: async () => {
        await rm(collectedDirectory, { recursive: true });
        return {
          registrations: [registration({ sessionId: "session-live" })],
          errors: [{
            directory: collectedDirectory,
            error: Object.assign(new Error("registration disappeared"), { code: "ENOENT" }),
          }],
        };
      },
      logger,
    })).resolves.toEqual(["session-live"]);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 1, directories: [collectedDirectory] },
      "skipped runner inventory entries removed during scan",
    );
  });

  it("includes a recovered damaged neighbor identity in the conservative inventory", async () => {
    const stateDirectory = await temporaryDirectory("damaged-neighbor");
    const damagedDirectory = join(stateDirectory, "session-unknown");
    await mkdir(damagedDirectory);
    const failure = new Error("runner registration unreadable");
    const onScanError = vi.fn();
    await expect(listLiveRunnerSessionIds({
      stateDirectory,
      leaseTimeoutMs: 120_000,
      now: () => NOW,
      scan: async () => ({
        registrations: [registration({ sessionId: "session-live" })],
        errors: [{
          directory: damagedDirectory,
          error: failure,
          sessionId: "session-unknown",
        }],
      }),
      onScanError,
    })).resolves.toEqual(["session-live", "session-unknown"]);
    expect(onScanError).toHaveBeenCalledOnce();
  });

  it("skips a busy SQLite scan cycle and retries the live runner on the next cycle", async () => {
    const stateDirectory = await temporaryDirectory("busy-inventory");
    const busyDirectory = join(stateDirectory, "session-busy");
    await mkdir(busyDirectory);
    const busy = Object.assign(new Error("database is locked"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 5,
    });
    const scan = vi.fn()
      .mockResolvedValueOnce({
        registrations: [],
        errors: [{
          directory: busyDirectory,
          error: busy,
          sessionId: "session-busy",
        }],
      })
      .mockResolvedValueOnce({
        registrations: [registration({ sessionId: "session-busy" })],
        errors: [],
      });

    await expect(listLiveRunnerSessionIds({
      stateDirectory,
      leaseTimeoutMs: 120_000,
      now: () => NOW,
      scan,
    })).resolves.toEqual(["session-busy"]);
    await expect(listLiveRunnerSessionIds({
      stateDirectory,
      leaseTimeoutMs: 120_000,
      now: () => NOW,
      scan,
    })).resolves.toEqual(["session-busy"]);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("refuses partial inventory when a damaged directory has no recoverable identity", async () => {
    const stateDirectory = await temporaryDirectory("damaged-inventory");
    const damagedDirectory = join(stateDirectory, "unidentified");
    await mkdir(damagedDirectory);
    await writeFile(join(damagedDirectory, "runner-config.json"), "{damaged");
    await expect(listLiveRunnerSessionIds({
      stateDirectory,
      leaseTimeoutMs: 120_000,
      now: () => NOW,
    })).rejects.toThrow(
      `runner inventory incomplete: identity unavailable for ${damagedDirectory}`,
    );
  });

  it("reads only the lifecycle row and never opens the event outbox", async () => {
    const stateDirectory = await temporaryDirectory("light");
    const paths = runnerProcessPaths(stateDirectory, "session-a");
    await mkdir(paths.sessionDirectory, { recursive: true });
    await writeFile(paths.configPath, JSON.stringify({ ...registration().config, paths }));
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
    outbox.close();
    const lifecycle = RunnerSqliteLifecycle.open(paths.databasePath);
    lifecycle.begin({
      pid: 4123,
      commandId: "execute-a",
      progressedAt: "2026-08-11T00:00:20.000Z",
    });
    lifecycle.close();
    const open = vi.spyOn(RunnerSqliteEventOutbox, "open");
    const result = await scanRunnerRegistrations(stateDirectory);
    expect(result.errors).toEqual([]);
    expect(result.registrations[0]).toMatchObject({
      bootstrap: null,
      lifecycle: { execution_state: "running" },
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("derives a closed tail fingerprint from the durable head and host ACK", async () => {
    const { stateDirectory, paths, outbox, host } = await closedRunnerState("tail-state");
    const event = await outbox.append({
      session_id: "session-tail-state",
      event_type: "session_ended",
      payload: { type: "session_ended", status: "completed" },
      searchable_text: null,
      created_at: "2026-08-11T00:00:01.000Z",
      semantic_dedupe_key: "terminal:session-tail-state",
      session_effect: null,
    });
    host.acknowledgeEvent({
      streamId: outbox.streamId,
      sessionId: "session-tail-state",
      acknowledgedThrough: event.source_seq,
      latestDurableSourceSeq: event.source_seq,
    });
    outbox.close();
    host.close();

    const first = await scanRunnerRegistrations(stateDirectory);

    expect(first.errors).toEqual([]);
    expect(first.registrations[0]?.closedTailState).toEqual({
      status: "fully_acknowledged",
      streamId: expect.any(String),
      sessionId: "session-tail-state",
      latestDurableSourceSeq: event.source_seq,
      acknowledgedThrough: event.source_seq,
    });

    const writer = await RunnerSqliteEventOutbox.open(paths.databasePath);
    const later = await writer.append({
      session_id: "session-tail-state",
      event_type: "assistant_message",
      payload: { type: "assistant_message", content: "late durable tail" },
      searchable_text: "late durable tail",
      created_at: "2026-08-11T00:00:02.000Z",
      semantic_dedupe_key: null,
      session_effect: null,
    });
    writer.close();

    const second = await scanRunnerRegistrations(stateDirectory);

    expect(second.errors).toEqual([]);
    expect(second.registrations[0]?.closedTailState).toEqual({
      status: "requires_drain",
      streamId: expect.any(String),
      sessionId: "session-tail-state",
      latestDurableSourceSeq: later.source_seq,
      acknowledgedThrough: event.source_seq,
    });
  });

  it("uses sqlite_sequence as the durable head after acknowledged-prefix compaction", async () => {
    const { stateDirectory, outbox, host } = await closedRunnerState("compacted-tail");
    let latestSourceSeq = 1;
    for (let index = 0; index < EVENT_OUTBOX_COMPACT_ROWS; index += 1) {
      const event = await outbox.append({
        session_id: "session-compacted-tail",
        event_type: "assistant_message",
        payload: { type: "assistant_message", content: String(index) },
        searchable_text: null,
        created_at: "2026-08-11T00:00:01.000Z",
        semantic_dedupe_key: null,
        session_effect: null,
      });
      latestSourceSeq = event.source_seq;
    }
    await outbox.acknowledge(outbox.streamId, latestSourceSeq);
    host.acknowledgeEvent({
      streamId: outbox.streamId,
      sessionId: "session-compacted-tail",
      acknowledgedThrough: latestSourceSeq,
      latestDurableSourceSeq: latestSourceSeq,
    });
    outbox.close();
    host.close();

    const scan = await scanRunnerRegistrations(stateDirectory);

    expect(scan.errors).toEqual([]);
    expect(scan.registrations[0]?.closedTailState).toEqual({
      status: "fully_acknowledged",
      streamId: expect.any(String),
      sessionId: "session-compacted-tail",
      latestDurableSourceSeq: latestSourceSeq,
      acknowledgedThrough: latestSourceSeq,
    });
  });

  it.each(["missing", "stale", "invalid"] as const)(
    "classifies from durable SQLite when the lifecycle cache is %s and regenerates it",
    async (cacheState) => {
      const stateDirectory = await temporaryDirectory(`durable-${cacheState}`);
      const paths = runnerProcessPaths(stateDirectory, `session-${cacheState}`);
      const current = registration({ sessionId: `session-${cacheState}` });
      current.config = { ...current.config, paths };
      await mkdir(paths.sessionDirectory, { recursive: true });
      await writeFile(paths.configPath, JSON.stringify(current.config));
      await writeFile(paths.pidPath, String(process.pid));
      const identity = pendingRunnerRegistrationIdentity(
        current.config.sessionId,
        current.config.codeSha,
      );
      await writeRunnerRegistrationIdentity(paths.sessionDirectory, {
        ...identity,
        pid: process.pid,
        startIdentity: "current-process",
      });
      const outbox = await RunnerSqliteEventOutbox.create(paths.databasePath);
      await outbox.initializeBootstrap({
        session_id: current.config.sessionId,
        created_at: "2026-08-11T00:00:00.000Z",
        resume: {
          schema_version: 1,
          backend_session_id: `backend-${cacheState}`,
          cwd: "/workspace/a",
          codex_home: "/home/test/.codex",
          rollout_root: "/home/test/.codex/sessions",
          code_sha: current.config.codeSha,
          snapshot_path: current.config.snapshotPath,
        },
      });
      outbox.close();
      const lifecycle = RunnerSqliteLifecycle.open(paths.databasePath);
      lifecycle.begin({
        pid: process.pid,
        commandId: `execute-${cacheState}`,
        progressedAt: "2026-08-11T00:00:29.000Z",
      });
      lifecycle.close();
      const summaryPath = runnerLifecycleSummaryPath(paths.databasePath);
      if (cacheState === "missing") {
        await rm(summaryPath);
      } else if (cacheState === "stale") {
        await writeFile(summaryPath, JSON.stringify({
          ...current.lifecycle,
          session_id: current.config.sessionId,
          runner_pid: process.pid + 100_000,
          execution_state: "closed",
        }));
      } else {
        await writeFile(summaryPath, "{invalid");
      }

      const result = await scanRunnerRegistrations(stateDirectory);

      expect(result.errors).toEqual([]);
      expect(result.registrations).toHaveLength(1);
      expect(result.registrations[0]).toMatchObject({
        pid: process.pid,
        pidAlive: true,
        lifecycle: {
          runner_pid: process.pid,
          execution_command_id: `execute-${cacheState}`,
          execution_state: "running",
        },
      });
      expect(classifyRunnerRegistration(result.registrations[0]!, NOW, 120_000))
        .toBe("adopt_running");
      expect(JSON.parse(await readFile(summaryPath, "utf8"))).toMatchObject({
        runner_pid: process.pid,
        execution_command_id: `execute-${cacheState}`,
        execution_state: "running",
      });
    },
  );

  it("keeps cache refresh failure escalation per path without blocking scan retries", async () => {
    const stateDirectory = await temporaryDirectory("refresh-escalation");
    const paths = runnerProcessPaths(stateDirectory, "session-refresh");
    const current = registration({ sessionId: "session-refresh" });
    current.config = { ...current.config, paths };
    await mkdir(paths.sessionDirectory, { recursive: true });
    await writeFile(paths.configPath, JSON.stringify(current.config));
    await writeFile(paths.pidPath, String(process.pid));
    await writeRunnerRegistrationIdentity(paths.sessionDirectory, {
      ...pendingRunnerRegistrationIdentity(current.config.sessionId, current.config.codeSha),
      pid: process.pid,
      startIdentity: "current-process",
    });
    const outbox = await RunnerSqliteEventOutbox.create(paths.databasePath);
    await outbox.initializeBootstrap({
      session_id: current.config.sessionId,
      created_at: "2026-08-12T00:00:00.000Z",
      resume: {
        schema_version: 1,
        backend_session_id: "backend-refresh",
        cwd: "/workspace/a",
        codex_home: "/home/test/.codex",
        rollout_root: "/home/test/.codex/sessions",
        code_sha: current.config.codeSha,
        snapshot_path: current.config.snapshotPath,
      },
    });
    outbox.close();
    const lifecycle = RunnerSqliteLifecycle.open(paths.databasePath);
    lifecycle.begin({
      pid: process.pid,
      commandId: "execute-refresh",
      progressedAt: "2026-08-12T00:00:01.000Z",
    });
    lifecycle.close();
    await writeFile(runnerLifecycleSummaryPath(paths.databasePath), "{invalid");
    const sleep = vi.fn();
    const onSummaryRenameFailure = vi.fn();
    const onSummaryRenameRecovery = vi.fn();
    const scanOptions = {
      lifecycleSummaryOptions: {
        renameFile: () => {
          throw Object.assign(new Error("persistent lock"), { code: "EPERM" });
        },
        sleep,
        onSummaryRenameFailure,
      },
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await scanRunnerRegistrations(stateDirectory, scanOptions);
      expect(result.errors).toEqual([]);
      expect(result.registrations[0]?.lifecycle?.runner_pid).toBe(process.pid);
    }

    expect(sleep).not.toHaveBeenCalled();
    expect(onSummaryRenameFailure).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ code: "EPERM" }),
      runnerLifecycleSummaryPath(paths.databasePath),
      { consecutiveFailures: 1, severity: "warn" },
    );
    expect(onSummaryRenameFailure).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ code: "EPERM" }),
      runnerLifecycleSummaryPath(paths.databasePath),
      { consecutiveFailures: 3, severity: "error" },
    );
    const recovered = await scanRunnerRegistrations(stateDirectory, {
      lifecycleSummaryOptions: { renameFile: renameSync, onSummaryRenameRecovery },
    });
    expect(recovered.errors).toEqual([]);
    expect(onSummaryRenameRecovery).toHaveBeenCalledWith(
      runnerLifecycleSummaryPath(paths.databasePath),
      3,
    );
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

  it("ignores applied legacy host-call receipts without writing during inspection", async () => {
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
      acknowledgedThrough: null,
      latestDurableSourceSeq: 1,
      incompleteDurableWork: true,
      durableRecordCount: 1,
      unacknowledgedIpcFrameCount: 0,
      pendingInterventionCount: 0,
      registration: { lifecycle: { execution_state: "completed" } },
    });
    const recovered = await RunnerSqliteEventOutbox.open(paths.databasePath);
    await expect(recovered.readHostCallApplied("host:orphaned")).resolves.toMatchObject({
      correlationId: "host:orphaned",
    });
    recovered.close();
  });

  it("proves a terminal pre-bootstrap runner has no durable discard blockers", async () => {
    const stateDirectory = await temporaryDirectory("terminal-prebootstrap-empty");
    const paths = runnerProcessPaths(stateDirectory, "session-a");
    await mkdir(paths.sessionDirectory, { recursive: true });
    const outbox = await RunnerSqliteEventOutbox.create(paths.databasePath);
    outbox.close();
    const lifecycle = RunnerSqliteLifecycle.open(paths.databasePath, "session-a");
    lifecycle.begin({
      pid: 4123,
      commandId: "execute-a",
      progressedAt: "2026-08-11T00:00:01.000Z",
    });
    lifecycle.finish("execute-a", "closed", "2026-08-11T00:00:02.000Z");
    lifecycle.close();
    const current = registration({ pidAlive: false, lifecycleState: "failed" });
    current.config = { ...current.config, paths };

    await expect(inspectRunnerDurableState(current)).resolves.toMatchObject({
      acknowledgedThrough: null,
      latestDurableSourceSeq: null,
      incompleteDurableWork: true,
      durableRecordCount: 0,
      unacknowledgedIpcFrameCount: 0,
      pendingInterventionCount: 0,
      registration: { bootstrap: null, lifecycle: { execution_state: "closed" } },
    });
  });

  it("reports a terminal durable tail as pending when the orch ACK is behind", async () => {
    const stateDirectory = await temporaryDirectory("terminal-partial-ack");
    const paths = runnerProcessPaths(stateDirectory, "session-a");
    await mkdir(paths.sessionDirectory, { recursive: true });
    const outbox = await RunnerSqliteEventOutbox.create(paths.databasePath);
    const bootstrap = await outbox.initializeBootstrap({
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
    const event = await outbox.append({
      session_id: "session-a",
      event_type: "assistant_message",
      payload: { type: "assistant_message", content: "not ACKed" },
      searchable_text: "not ACKed",
      created_at: "2026-08-11T00:00:01.000Z",
      semantic_dedupe_key: null,
      session_effect: null,
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
    const hostPath = runnerHostStatePath(paths.databasePath);
    const host = RunnerHostStateStore.open(hostPath);
    host.initializeEventCheckpoint({
      streamId: bootstrap.stream_id,
      sessionId: "session-a",
      acknowledgedThrough: 1,
    });
    host.close();
    const runnerBefore = await readFile(paths.databasePath);
    const hostBefore = await readFile(hostPath);
    const current = registration({ pidAlive: false, lifecycleState: "completed" });
    current.config = { ...current.config, paths };

    await expect(inspectRunnerDurableState(current)).resolves.toMatchObject({
      acknowledgedThrough: 1,
      latestDurableSourceSeq: event.source_seq,
      incompleteDurableWork: true,
      registration: { lifecycle: { execution_state: "completed" } },
    });
    expect(await readFile(paths.databasePath)).toEqual(runnerBefore);
    expect(await readFile(hostPath)).toEqual(hostBefore);
  });
});

async function closedRunnerState(label: string) {
  const sessionId = `session-${label}`;
  const stateDirectory = await temporaryDirectory(label);
  const paths = runnerProcessPaths(stateDirectory, sessionId);
  const current = registration({ sessionId, pidAlive: false });
  current.config = { ...current.config, paths };
  await mkdir(paths.sessionDirectory, { recursive: true });
  await writeFile(paths.configPath, JSON.stringify(current.config));

  const initial = await RunnerSqliteEventOutbox.create(paths.databasePath);
  const bootstrap = await initial.initializeBootstrap({
    session_id: sessionId,
    created_at: "2026-08-11T00:00:00.000Z",
    resume: {
      schema_version: 1,
      backend_session_id: `backend-${label}`,
      cwd: "/workspace/a",
      codex_home: "/home/test/.codex",
      rollout_root: "/home/test/.codex/sessions",
      code_sha: current.config.codeSha,
      snapshot_path: current.config.snapshotPath,
    },
  });
  initial.close();

  const lifecycle = RunnerSqliteLifecycle.open(paths.databasePath, sessionId);
  lifecycle.begin({
    pid: 4123,
    commandId: `execute-${label}`,
    progressedAt: "2026-08-11T00:00:00.000Z",
  });
  lifecycle.finish(
    `execute-${label}`,
    "closed",
    "2026-08-11T00:00:03.000Z",
  );
  lifecycle.close();

  const host = RunnerHostStateStore.open(runnerHostStatePath(paths.databasePath));
  host.initializeEventCheckpoint({
    streamId: bootstrap.stream_id,
    sessionId,
    acknowledgedThrough: 1,
  });
  const outbox = await RunnerSqliteEventOutbox.open(paths.databasePath);
  return { stateDirectory, paths, outbox, host };
}

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

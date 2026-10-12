import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RunnerReleaseGarbageCollector,
  type RunnerReleaseGarbageCollectorDependencies,
} from "../../src/runner/runner_release_gc.js";
import type {
  RunnerReleaseDescriptor,
  RunnerReleaseMaterializer,
} from "../../src/runner/runner_release_materializer.js";
import {
  BuildArtifactReleaseMaterializer,
  RUNNER_RELEASE_ARTIFACTS,
} from "../../src/runner/runner_release_materializer.js";
import { RunnerReleasePool } from "../../src/runner/runner_release_pool.js";
import { createRunnerPhaseObservation } from "../../src/runner/runner_phase_observation.js";
import {
  scanRunnerRegistrations,
  type RunnerRegistration,
  type RunnerRegistrationScan,
} from "../../src/runner/runner_process_registry.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("RunnerReleaseGarbageCollector", () => {
  it("can never remove a snapshot while any referencing runner pid is alive", async () => {
    const subject = await makeSubject([registration({ pidAlive: true })], false);

    await expect(subject.collector.collect()).resolves.toEqual({
      removed: [],
      retained: [{ releaseId: "release-a", reason: "live_runner" }],
    });
    expect(subject.materializer.remove).not.toHaveBeenCalled();
    expect(subject.inspect).not.toHaveBeenCalled();
    expect(subject.materializer.verify).not.toHaveBeenCalled();
  });

  it("retains a stopped terminal runner until outbox and IPC final ACK", async () => {
    const subject = await makeSubject([registration()], true);

    await expect(subject.collector.collect()).resolves.toEqual({
      removed: [],
      retained: [{ releaseId: "release-a", reason: "final_ack_pending" }],
    });
    expect(subject.materializer.remove).not.toHaveBeenCalled();
    expect(subject.materializer.verify).not.toHaveBeenCalled();
  });

  it("fails closed when a live runner loses its PID-file evidence", async () => {
    const subject = await makeSubject([
      registration({ pid: null, pidAlive: false }),
    ], false);

    await expect(subject.collector.collect()).resolves.toEqual({
      removed: [],
      retained: [{ releaseId: "release-a", reason: "pid_evidence_missing" }],
    });
    expect(subject.materializer.remove).not.toHaveBeenCalled();
    expect(subject.materializer.verify).not.toHaveBeenCalled();
    expect(subject.logger.warn).toHaveBeenCalledWith(
      { releaseId: "release-a", sessionId: "session-a" },
      "runner release GC retained release because PID evidence is missing",
    );
  });

  it("retains a running lease record even when its pid probe is temporarily unavailable", async () => {
    const active = registration();
    active.lifecycle = { ...active.lifecycle!, execution_state: "running" };
    const subject = await makeSubject([active], false);

    await expect(subject.collector.collect()).resolves.toEqual({
      removed: [],
      retained: [{ releaseId: "release-a", reason: "running_lifecycle" }],
    });
    expect(subject.materializer.remove).not.toHaveBeenCalled();
    expect(subject.materializer.verify).not.toHaveBeenCalled();
  });

  it("retains a release when durable ACK evidence cannot be read without verifying its bundle", async () => {
    const subject = await makeSubject([registration()], false);
    subject.inspect.mockRejectedValueOnce(new Error("durable evidence unreadable"));

    await expect(subject.collector.collect()).resolves.toEqual({
      removed: [],
      retained: [{ releaseId: "release-a", reason: "evidence_unreadable" }],
    });
    expect(subject.materializer.verify).not.toHaveBeenCalled();
    expect(subject.materializer.remove).not.toHaveBeenCalled();
  });

  it("removes a release only after every registration is stopped, terminal, and fully ACKed", async () => {
    const subject = await makeSubject([
      registration({ sessionId: "session-a" }),
      registration({ sessionId: "session-b" }),
    ], false);

    await expect(subject.collector.collect()).resolves.toEqual({
      removed: ["release-a"],
      retained: [],
    });
    expect(subject.materializer.remove).toHaveBeenCalledOnce();
    expect(subject.materializer.verify).toHaveBeenCalledOnce();
  });

  it("retains a prewarmed release with no final-ACK evidence", async () => {
    const subject = await makeSubject([], false);

    await expect(subject.collector.collect()).resolves.toEqual({
      removed: [],
      retained: [{ releaseId: "release-a", reason: "no_final_ack_evidence" }],
    });
    expect(subject.materializer.checkReadyMarker).toHaveBeenCalledOnce();
    expect(subject.materializer.verify).not.toHaveBeenCalled();
  });

  it("fully verifies a deletion candidate and continues after a candidate fails verification", async () => {
    const subject = await makeSubject([
      registration({ sessionId: "session-a" }),
      registration({ sessionId: "session-b", codeSha: "release-b" }),
    ], false);
    await subject.pool.ensureRelease(subject.pool.describe("release-b"));
    subject.materializer.verify.mockClear();
    subject.materializer.verify.mockImplementation(async (release) => {
      if (!subject.materializer.isIntact(release.releaseId)) {
        throw new Error("runner release content mismatch");
      }
    });
    subject.materializer.corrupt("release-a");

    const result = await subject.collector.collect();

    expect(result.removed).toEqual(["release-b"]);
    expect(result.retained).toEqual([
      { releaseId: "release-a", reason: "evidence_unreadable" },
    ]);
    expect(subject.materializer.verify).toHaveBeenCalledTimes(2);
    expect(subject.materializer.remove).toHaveBeenCalledOnce();
    expect(subject.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ releaseId: "release-a" }),
      "runner release GC retained release because release verification failed",
    );
  });

  it("retains a marker-valid bundle when final full verification finds changed content", async () => {
    const root = await temporaryDirectory();
    const artifacts = join(root, "build-artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, "package.json"), "{\"type\":\"module\"}\n");
    await writeFile(join(artifacts, "runner_entry.js"), "export const ready = true;\n");
    const materializer = new BuildArtifactReleaseMaterializer(artifacts);
    const pool = new RunnerReleasePool(join(root, "runner-releases"), materializer);
    const release = await pool.resolveCurrentRelease();
    await pool.ensureRelease(release);
    await chmod(release.releaseRoot, 0o755);
    await chmod(join(release.releaseRoot, "runner_entry.js"), 0o644);
    await writeFile(join(release.releaseRoot, "runner_entry.js"), "export const ready = false;\n");
    const verify = vi.spyOn(materializer, "verify");
    verify.mockClear();
    const registrationForRelease = registration({ codeSha: release.releaseId });
    const inspect = vi.fn(async (current: RunnerRegistration) => ({
      registration: current,
      acknowledgedThrough: 2,
      latestDurableSourceSeq: 2,
      incompleteDurableWork: false,
      durableRecordCount: 2,
      unacknowledgedIpcFrameCount: 0,
      pendingInterventionCount: 0,
    }));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const collector = new RunnerReleaseGarbageCollector(
      pool,
      join(root, "runner-state"),
      logger as never,
      {
        scan: vi.fn(async () => ({ registrations: [registrationForRelease], errors: [] })),
        inspect,
      },
    );

    await expect(collector.collect()).resolves.toEqual({
      removed: [],
      retained: [{ releaseId: release.releaseId, reason: "evidence_unreadable" }],
    });
    expect(verify).toHaveBeenCalledOnce();
    await expect(readFile(join(release.releaseRoot, "runner_entry.js"), "utf8"))
      .resolves.toBe("export const ready = false;\n");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ releaseId: release.releaseId }),
      "runner release GC retained release because release verification failed",
    );
  });

  it("does not fail closed on reserved runner-state infrastructure", async () => {
    const subject = await makeSubject(
      [],
      false,
      [],
      async (stateDirectory) => await scanRunnerRegistrations(stateDirectory),
    );
    const controlDirectory = join(subject.stateDirectory, "_control");
    await mkdir(controlDirectory, { recursive: true });
    await writeFile(join(controlDirectory, "control-inbox.sqlite"), "not-a-runner-database");

    await expect(subject.collector.collect()).resolves.toEqual({
      removed: [],
      retained: [{ releaseId: "release-a", reason: "no_final_ack_evidence" }],
    });
    expect(subject.logger.warn).not.toHaveBeenCalled();
  });

  it("fails closed when any runner registration is unreadable", async () => {
    const subject = await makeSubject([], false, [
      { directory: "/broken", error: new Error("unreadable registration") },
    ]);

    await expect(subject.collector.collect()).resolves.toEqual({
      removed: [],
      retained: [{ releaseId: "release-a", reason: "inventory_incomplete" }],
    });
    expect(subject.materializer.remove).not.toHaveBeenCalled();
    expect(subject.materializer.verify).not.toHaveBeenCalled();
  });

  it("scans the registration inventory once regardless of release count", async () => {
    const subject = await makeSubject([registration()], false);
    await subject.pool.ensureRelease(subject.pool.describe("release-b"));

    await subject.collector.collect();

    expect(subject.scan).toHaveBeenCalledOnce();
  });

  it("isolates known corrupt evidence to its referenced release", async () => {
    const subject = await makeSubject([
      registration({ sessionId: "healthy", codeSha: "release-b" }),
    ], false, [{
      directory: "/state/broken",
      sessionId: "broken",
      codeSha: "release-a",
      error: new Error("corrupt lifecycle summary"),
    }]);
    await subject.pool.ensureRelease(subject.pool.describe("release-b"));
    subject.materializer.verify.mockClear();

    await expect(subject.collector.collect()).resolves.toEqual({
      removed: ["release-b"],
      retained: [{ releaseId: "release-a", reason: "inventory_incomplete" }],
    });
    expect(subject.materializer.verify).toHaveBeenCalledOnce();
  });

  it("re-scans registration ownership under the release lock before deletion", async () => {
    const stale = registration({ pidAlive: false });
    const revived = {
      ...stale,
      pidAlive: true,
      pidStartIdentity: "replacement-process",
    } as RunnerRegistration;
    const subject = await makeSubject([revived], false);

    await expect(subject.collector.collect({ registrations: [stale], errors: [] }))
      .resolves.toEqual({
        removed: [],
        retained: [{ releaseId: "release-a", reason: "live_runner" }],
      });
    expect(subject.scan).toHaveBeenCalledOnce();
    expect(subject.materializer.remove).not.toHaveBeenCalled();
  });

  it("reports release GC phases in lock, fresh inventory, then durable inspection order", async () => {
    const subject = await makeSubject([registration()], false);
    const phases: string[] = [];
    let now = 10;
    const observation = createRunnerPhaseObservation({
      nodeId: "node-a",
      scopeId: "release-gc-1",
      operation: "runner.recovery.releaseGc",
      logger: subject.logger as never,
      monotonicNow: () => now++,
      beginRunnerOperation: (context) => {
        phases.push(context.phase ?? "missing");
        return () => {};
      },
    });

    await subject.collector.collect(undefined, observation);

    expect(phases).toEqual([
      "enumerateAndVerify",
      "releaseLock",
      "registry",
      "durableInspection",
      "candidateVerification",
    ]);
    expect(subject.scan).toHaveBeenCalledOnce();
    expect(subject.inspect).toHaveBeenCalledOnce();
    expect(subject.logger.info).toHaveBeenCalledWith(expect.objectContaining({
      phaseDurationsMs: expect.objectContaining({
        enumerateAndVerify: expect.any(Number),
        releaseLock: expect.any(Number),
        registry: expect.any(Number),
        durableInspection: expect.any(Number),
        candidateVerification: expect.any(Number),
      }),
    }), "runner release GC sweep completed");
  });
});

async function makeSubject(
  registrations: RunnerRegistration[],
  incomplete: boolean,
  errors: RunnerRegistrationScan["errors"] = [],
  scanRegistrationInventory?: RunnerReleaseGarbageCollectorDependencies["scan"],
) {
  const root = await temporaryDirectory();
  const stateDirectory = join(root, "runner-state");
  const materializer = new FakeMaterializer();
  const pool = new RunnerReleasePool(join(root, "runner-releases"), materializer);
  const release = pool.describe("release-a");
  await pool.ensureRelease(release);
  materializer.verify.mockClear();
  const scan = vi.fn(scanRegistrationInventory
    ?? (async () => ({ registrations, errors })));
  const inspect = vi.fn(async (registration: RunnerRegistration) => ({
    registration,
    acknowledgedThrough: incomplete ? 1 : 2,
    latestDurableSourceSeq: 2,
    incompleteDurableWork: incomplete,
    durableRecordCount: 2,
    unacknowledgedIpcFrameCount: 0,
    pendingInterventionCount: 0,
  }));
  const deps: RunnerReleaseGarbageCollectorDependencies = {
    scan,
    inspect,
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  return {
    collector: new RunnerReleaseGarbageCollector(
      pool,
      stateDirectory,
      logger as never,
      deps,
    ),
    materializer,
    logger,
    pool,
    scan,
    inspect,
    stateDirectory,
  };
}

class FakeMaterializer implements RunnerReleaseMaterializer {
  readonly remove = vi.fn(async (release: RunnerReleaseDescriptor) => {
    this.ready.delete(release.releaseId);
    this.intact.delete(release.releaseId);
    await rm(release.releaseRoot, { recursive: true, force: true });
  });
  readonly verify = vi.fn(async (release: RunnerReleaseDescriptor) => {
    if (!this.ready.has(release.releaseId)) {
      throw Object.assign(new Error("not ready"), { code: "ENOENT" });
    }
    if (!this.intact.has(release.releaseId)) {
      throw new Error("runner release content mismatch");
    }
  });
  readonly checkReadyMarker = vi.fn(async (release: RunnerReleaseDescriptor) => {
    if (!this.ready.has(release.releaseId)) {
      throw Object.assign(new Error("not ready"), { code: "ENOENT" });
    }
  });
  private readonly ready = new Set<string>();
  private readonly intact = new Set<string>();

  async resolveCurrentReleaseId(): Promise<string> {
    return "release-a";
  }

  async materialize(release: RunnerReleaseDescriptor): Promise<void> {
    await mkdir(release.runnerModuleRoot, { recursive: true });
    await writeFile(join(release.runnerModuleRoot, "runner_entry.js"), "");
    await writeFile(
      join(release.releaseRoot, ".runner-release.json"),
      JSON.stringify({
        schemaVersion: 1,
        releaseId: release.releaseId,
        hashAlgorithm: "sha256",
        artifacts: RUNNER_RELEASE_ARTIFACTS,
      }) + "\n",
    );
    this.ready.add(release.releaseId);
    this.intact.add(release.releaseId);
  }

  corrupt(releaseId: string): void {
    this.intact.delete(releaseId);
  }

  isIntact(releaseId: string): boolean {
    return this.intact.has(releaseId);
  }
}

function registration(options: {
  sessionId?: string;
  codeSha?: string;
  pid?: number | null;
  pidAlive?: boolean;
} = {}): RunnerRegistration {
  const sessionId = options.sessionId ?? "session-a";
  const codeSha = options.codeSha ?? "release-a";
  return {
    config: {
      sessionId,
      codeSha,
      paths: { databasePath: `/state/${sessionId}/runner.sqlite` },
    } as never,
    pid: options.pid === undefined ? 42 : options.pid,
    pidAlive: options.pidAlive ?? false,
    registrationId: "registration-a",
    pidStartIdentity: "process-start-a",
    registeredAtMs: Date.now(),
    bootstrap: { payload: { code_sha: codeSha } } as never,
    lifecycle: {
      session_id: sessionId,
      runner_pid: 42,
      execution_command_id: "execute-a",
      execution_state: "completed",
      progress_seq: 2,
      progress_at: new Date().toISOString(),
      liveness_at: new Date().toISOString(),
      in_flight_tools: [],
      terminal_error: null,
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runner-release-gc-"));
  directories.push(directory);
  return directory;
}

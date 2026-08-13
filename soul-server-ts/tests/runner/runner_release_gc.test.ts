import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { RunnerReleasePool } from "../../src/runner/runner_release_pool.js";
import type { RunnerRegistration } from "../../src/runner/runner_process_registry.js";
import type { RunnerRegistrationScan } from "../../src/runner/runner_process_registry.js";

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
  });

  it("retains a stopped terminal runner until outbox and IPC final ACK", async () => {
    const subject = await makeSubject([registration()], true);

    await expect(subject.collector.collect()).resolves.toEqual({
      removed: [],
      retained: [{ releaseId: "release-a", reason: "final_ack_pending" }],
    });
    expect(subject.materializer.remove).not.toHaveBeenCalled();
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
  });

  it("retains a prewarmed release with no final-ACK evidence", async () => {
    const subject = await makeSubject([], false);

    await expect(subject.collector.collect()).resolves.toEqual({
      removed: [],
      retained: [{ releaseId: "release-a", reason: "no_final_ack_evidence" }],
    });
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

    await expect(subject.collector.collect()).resolves.toEqual({
      removed: ["release-b"],
      retained: [{ releaseId: "release-a", reason: "inventory_incomplete" }],
    });
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
});

async function makeSubject(
  registrations: RunnerRegistration[],
  incomplete: boolean,
  errors: RunnerRegistrationScan["errors"] = [],
) {
  const root = await temporaryDirectory();
  const materializer = new FakeMaterializer();
  const pool = new RunnerReleasePool(join(root, "runner-releases"), materializer);
  const release = pool.describe("release-a");
  await pool.ensureRelease(release);
  const scan = vi.fn(async () => ({ registrations, errors }));
  const inspect = vi.fn(async (registration: RunnerRegistration) => ({
    registration,
    acknowledgedThrough: incomplete ? 1 : 2,
    latestDurableSourceSeq: 2,
    incompleteDurableWork: incomplete,
  }));
  const deps: RunnerReleaseGarbageCollectorDependencies = {
    scan,
    inspect,
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  return {
    collector: new RunnerReleaseGarbageCollector(
      pool,
      join(root, "runner-state"),
      logger as never,
      deps,
    ),
    materializer,
    logger,
    pool,
    scan,
    inspect,
  };
}

class FakeMaterializer implements RunnerReleaseMaterializer {
  readonly remove = vi.fn(async (release: RunnerReleaseDescriptor) => {
    this.ready.delete(release.releaseId);
    await rm(release.releaseRoot, { recursive: true, force: true });
  });
  private readonly ready = new Set<string>();

  async resolveCurrentReleaseId(): Promise<string> {
    return "release-a";
  }

  async materialize(release: RunnerReleaseDescriptor): Promise<void> {
    await mkdir(release.runnerModuleRoot, { recursive: true });
    await writeFile(join(release.runnerModuleRoot, "runner_entry.js"), "");
    this.ready.add(release.releaseId);
  }

  async verify(release: RunnerReleaseDescriptor): Promise<void> {
    if (!this.ready.has(release.releaseId)) {
      throw Object.assign(new Error("not ready"), { code: "ENOENT" });
    }
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

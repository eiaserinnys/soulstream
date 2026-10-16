import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: openMock };
});

import { createRunnerPhaseObservation } from "../../src/runner/runner_phase_observation.js";
import { inspectRunnerWriterLock, RunnerWriterLock } from "../../src/runner/runner_writer_lock.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  openMock.mockReset();
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) =>
    await rm(directory, { recursive: true, force: true }),
  ));
});

describe("RunnerWriterLock ownership observation", () => {
  it("records nested ownership phases and releases the kernel lock after sync fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runner-writer-lock-observation-"));
    temporaryDirectories.push(directory);
    const lockPath = join(directory, "runner.lock");
    const syncFailure = new Error("owner sync failed");
    const handle = {
      writeFile: vi.fn(async () => {}),
      sync: vi.fn(async () => { throw syncFailure; }),
      close: vi.fn(async () => {}),
    };
    openMock.mockResolvedValue(handle);
    const phases: string[] = [];
    const observation = createRunnerPhaseObservation({
      nodeId: "node-a",
      scopeId: "writer-lock-sync-failure",
      operation: "runner.sessionMutation",
      logger: { warn: vi.fn() },
      monotonicNow: (() => {
        let now = 0;
        return () => now++;
      })(),
      beginRunnerOperation: (context) => {
        phases.push(context.phase ?? "missing");
        return () => {};
      },
    });

    await expect(RunnerWriterLock.acquire(lockPath, undefined, {
      phaseObservation: observation,
      sessionId: "session-sync-failure",
    })).rejects.toBe(syncFailure);

    expect(phases).toEqual([
      "mutationKernelAcquire",
      "mutationOwnerPreparation",
      "mutationOwnerPublish",
      "mutationOwnerSync",
    ]);
    expect(observation.failureFor(syncFailure)).toMatchObject({ phase: "mutationOwnerSync" });
    expect(handle.close).toHaveBeenCalledTimes(1);
    await expect(inspectRunnerWriterLock(lockPath)).resolves.toEqual({ kind: "free" });
  });
});

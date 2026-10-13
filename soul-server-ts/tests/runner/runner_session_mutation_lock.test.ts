import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runnerSessionMutationLockPath,
  withRunnerSessionMutationLock,
} from "../../src/runner/runner_session_mutation_lock.js";
import { createRunnerPhaseObservation } from "../../src/runner/runner_phase_observation.js";
import { RunnerWriterLock } from "../../src/runner/runner_writer_lock.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) =>
    await rm(directory, { recursive: true, force: true }),
  ));
});

describe("withRunnerSessionMutationLock observation", () => {
  it("keeps the existing two-argument unobserved call path", async () => {
    const sessionDirectory = await makeSessionDirectory();

    await expect(withRunnerSessionMutationLock(
      sessionDirectory,
      async () => "completed",
    )).resolves.toBe("completed");
  });

  it("separates same-directory queue wait from ownership acquire and release", async () => {
    const sessionDirectory = await makeSessionDirectory();
    const observationState = makeObservation();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    observationState.observation = createRunnerPhaseObservation({
      nodeId: "node-a",
      scopeId: "mutation-lock-queue",
      operation: "runner.sessionMutation",
      logger: { warn: vi.fn() },
      monotonicNow: (() => {
        let now = 0;
        return () => now++;
      })(),
      beginRunnerOperation: (context) => {
        const phase = context.phase ?? "missing";
        observationState.started.push(phase);
        return () => observationState.finished.push(phase);
      },
    });

    const context = { phaseObservation: observationState.observation, sessionId: "session-a" };
    const first = withRunnerSessionMutationLock(
      sessionDirectory,
      async () => {
        firstStarted.resolve();
        await releaseFirst.promise;
        return "first";
      },
      context,
    );
    await firstStarted.promise;
    let secondOperationStarted = false;
    const second = withRunnerSessionMutationLock(
      sessionDirectory,
      async () => {
        secondOperationStarted = true;
        return "second";
      },
      context,
    );

    expect(observationState.started.filter((phase) => phase === "mutationAcquire")).toHaveLength(1);
    expect(secondOperationStarted).toBe(false);

    releaseFirst.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);

    expect(observationState.started).toEqual([
      "mutationQueueWait",
      "mutationAcquire",
      "mutationParentMkdir",
      "mutationKernelAcquire",
      "mutationOwnerPreparation",
      "mutationOwnerPublish",
      "mutationOwnerSync",
      "mutationQueueWait",
      "mutationRelease",
      "mutationAcquire",
      "mutationParentMkdir",
      "mutationKernelAcquire",
      "mutationOwnerPreparation",
      "mutationOwnerPublish",
      "mutationOwnerSync",
      "mutationRelease",
    ]);
    expect(observationState.finished).toHaveLength(observationState.started.length);
    expect(observationState.observation.phaseDurationsMs()).toEqual(expect.objectContaining({
      mutationQueueWait: expect.any(Number),
      mutationAcquire: expect.any(Number),
      mutationRelease: expect.any(Number),
    }));
  });

  it("preserves an operation error and closes the release phase", async () => {
    const sessionDirectory = await makeSessionDirectory();
    const observationState = makeObservation();
    const failure = new Error("mutation operation failed");
    observationState.observation = createRunnerPhaseObservation({
      nodeId: "node-a",
      scopeId: "mutation-lock-operation-failure",
      operation: "runner.sessionMutation",
      logger: { warn: vi.fn() },
      monotonicNow: (() => {
        let now = 0;
        return () => now++;
      })(),
      beginRunnerOperation: (context) => {
        const phase = context.phase ?? "missing";
        observationState.started.push(phase);
        return () => observationState.finished.push(phase);
      },
    });

    await expect(withRunnerSessionMutationLock(
      sessionDirectory,
      async () => { throw failure; },
      { phaseObservation: observationState.observation, sessionId: "session-b" },
    )).rejects.toBe(failure);

    expect(observationState.started).toEqual([
      "mutationQueueWait",
      "mutationAcquire",
      "mutationParentMkdir",
      "mutationKernelAcquire",
      "mutationOwnerPreparation",
      "mutationOwnerPublish",
      "mutationOwnerSync",
      "mutationRelease",
    ]);
    expect(observationState.finished).toHaveLength(observationState.started.length);
  });

  it("does not record ownership release when acquire failed", async () => {
    const sessionDirectory = await makeSessionDirectory();
    const observationState = makeObservation();
    observationState.observation = createRunnerPhaseObservation({
      nodeId: "node-a",
      scopeId: "mutation-lock-acquire-failure",
      operation: "runner.sessionMutation",
      logger: { warn: vi.fn() },
      monotonicNow: (() => {
        let now = 0;
        return () => now++;
      })(),
      beginRunnerOperation: (context) => {
        const phase = context.phase ?? "missing";
        observationState.started.push(phase);
        return () => observationState.finished.push(phase);
      },
    });
    const owner = await RunnerWriterLock.acquire(
      runnerSessionMutationLockPath(sessionDirectory),
    );
    const operation = vi.fn(async () => "unexpected");

    try {
      await expect(withRunnerSessionMutationLock(
        sessionDirectory,
        operation,
        { phaseObservation: observationState.observation, sessionId: "session-c" },
      )).rejects.toThrow();
    } finally {
      await owner.release();
    }

    expect(operation).not.toHaveBeenCalled();
    expect(observationState.started).toEqual([
      "mutationQueueWait",
      "mutationAcquire",
      "mutationParentMkdir",
      "mutationKernelAcquire",
    ]);
    expect(observationState.finished).toHaveLength(observationState.started.length);
  });
});

function makeObservation() {
  return {
    observation: createRunnerPhaseObservation({
      nodeId: "node-a",
      scopeId: "mutation-lock-unused",
      operation: "runner.sessionMutation",
      logger: { warn: vi.fn() },
    }),
    started: [] as string[],
    finished: [] as string[],
  };
}

async function makeSessionDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runner-session-mutation-lock-"));
  temporaryDirectories.push(directory);
  return join(directory, "session-a");
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

import { mkdir, rm } from "node:fs/promises";

import {
  RunnerRecoveryCoordinator,
  type RunnerRecoveryCoordinatorOptions,
} from "../../src/runner/runner_recovery_coordinator.js";
import {
  classifyRunnerRegistration,
  type RunnerRegistration,
} from "../../src/runner/runner_process_registry.js";
import { withRunnerSessionMutationLock } from
  "../../src/runner/runner_session_mutation_lock.js";
import type { Task } from "../../src/task/task_models.js";
import {
  createTerminalRetirementFixture,
  readRegistrationEvidence,
  type RetirementFixture,
} from "./runner_retirement_reproof_fixture.js";
import {
  idealRetirementReproofObservation,
  type RetirementReproofObservation,
} from "./runner_retirement_reproof_oracle.js";

const NOW = Date.parse("2026-08-28T00:01:00.000Z");

interface ScenarioCounters {
  terminate: number;
  replay: number;
  retire: number;
  delivery: number;
  terminal: number;
  notification: number;
  consume: number;
  modelTurn: number;
}

interface CoordinatorSubject {
  coordinator: RunnerRecoveryCoordinator;
  replayEntered: Deferred;
  releaseReplay: Deferred;
  retireEntered: Deferred;
  counters: ScenarioCounters;
  errors: string[];
  disposition: string | undefined;
}

export async function observeFalseDeadBecomesLiveAtRetireLock(): Promise<
  RetirementReproofObservation
> {
  const fixture = await createTerminalRetirementFixture();
  try {
    const subject = makeCoordinatorSubject(fixture, true);
    const lock = await holdMutationLock(fixture);
    const scan = subject.coordinator.scanOnce();
    await subject.replayEntered.promise;
    fixture.processTable.setOldAlive(true);
    subject.releaseReplay.resolve();
    await subject.retireEntered.promise;
    lock.release.resolve();
    await lock.completion;
    await scan;
    await subject.coordinator.waitForSettled();
    const resume = await explicitResume(fixture, subject.counters, subject.errors);
    await subject.coordinator.stop();
    return await observe(4, fixture, subject, resume);
  } finally {
    await fixture.cleanup();
  }
}

export async function observeNaturalExitBeforeSignal(): Promise<
  RetirementReproofObservation
> {
  const fixture = await createTerminalRetirementFixture();
  try {
    fixture.processTable.setOldAlive(true);
    fixture.processTable.arrangeNaturalExitBeforeSignal();
    const subject = makeCoordinatorSubject(fixture, false);
    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();
    const resume = await explicitResume(fixture, subject.counters, subject.errors);
    await subject.coordinator.stop();
    return await observe(5, fixture, subject, resume);
  } finally {
    await fixture.cleanup();
  }
}

export async function observeRestartAfterSigtermBeforeExitProof(): Promise<
  RetirementReproofObservation
> {
  const fixture = await createTerminalRetirementFixture();
  const counters = emptyCounters();
  const errors: string[] = [];
  try {
    fixture.processTable.setOldAlive(true);
    fixture.processTable.arrangeHostRestartAfterSigterm();
    const registration = await fixture.registration(true);
    try {
      counters.terminate += 1;
      await fixture.spawner.terminate(fixture.paths, exactProcess(registration));
    } catch (error) {
      errors.push(message(error));
    }
    const afterRestart = await readRegistrationEvidence(fixture);
    const preserved = evidenceMatchesOldProcess(fixture, afterRestart);
    fixture.processTable.allowTerminationToComplete();
    counters.terminate += 1;
    await fixture.spawner.terminate(fixture.paths, exactProcess(registration));
    await fixture.spawner.retireTerminalRegistration(
      fixture.paths,
      registration.registrationId ?? null,
    );
    counters.retire += 1;
    fixture.processTable.events.push("retire");
    const resume = await explicitResume(fixture, counters, errors);
    const subject = directSubject(counters, errors);
    const observation = await observe(6, fixture, subject, resume);
    return { ...observation, evidencePreservedAfterRecoverableFailure: preserved };
  } finally {
    await fixture.cleanup();
  }
}

export async function observeFsFailureDuringRetirement(): Promise<
  RetirementReproofObservation
> {
  const fixture = await createTerminalRetirementFixture();
  try {
    const subject = makeCoordinatorSubject(fixture, true);
    const lock = await holdMutationLock(fixture);
    const scan = subject.coordinator.scanOnce();
    await subject.replayEntered.promise;
    await rm(fixture.paths.pidPath);
    await mkdir(fixture.paths.pidPath);
    subject.releaseReplay.resolve();
    await subject.retireEntered.promise;
    lock.release.resolve();
    await lock.completion;
    await scan;
    await subject.coordinator.waitForSettled();
    const evidence = await readRegistrationEvidence(fixture);
    const preserved = evidenceMatchesOldProcess(fixture, evidence);
    const resume = await explicitResume(fixture, subject.counters, subject.errors);
    await subject.coordinator.stop();
    const observation = await observe(7, fixture, subject, resume);
    return { ...observation, evidencePreservedAfterRecoverableFailure: preserved };
  } finally {
    await fixture.cleanup();
  }
}

export async function observeConcurrentScanAndExplicitResume(): Promise<
  RetirementReproofObservation
> {
  const fixture = await createTerminalRetirementFixture();
  try {
    const subject = makeCoordinatorSubject(fixture, true);
    const lock = await holdMutationLock(fixture);
    const scan = subject.coordinator.scanOnce();
    await subject.replayEntered.promise;
    fixture.processTable.setOldAlive(true);
    subject.releaseReplay.resolve();
    await subject.retireEntered.promise;
    const resumePromise = explicitResume(fixture, subject.counters, subject.errors);
    lock.release.resolve();
    await lock.completion;
    const resume = await resumePromise;
    await scan;
    await subject.coordinator.waitForSettled();
    await subject.coordinator.stop();
    const observation = await observe(8, fixture, subject, resume);
    return { ...observation, secondRequestConsumed: resume === "completed" };
  } finally {
    await fixture.cleanup();
  }
}

function makeCoordinatorSubject(
  fixture: RetirementFixture,
  gateReplay: boolean,
): CoordinatorSubject {
  const replayEntered = deferred();
  const releaseReplay = deferred();
  const retireEntered = deferred();
  const counters = emptyCounters();
  const errors: string[] = [];
  const task = recoveryTask();
  const subject: CoordinatorSubject = {
    coordinator: undefined as unknown as RunnerRecoveryCoordinator,
    replayEntered,
    releaseReplay,
    retireEntered,
    counters,
    errors,
    disposition: undefined,
  };
  const logger = {
    error: (record: unknown) => errors.push(logMessage(record)),
    warn: (record: unknown) => errors.push(logMessage(record)),
    info: () => {},
  };
  const options: RunnerRecoveryCoordinatorOptions = {
    nodeId: "node-retirement-reproof",
    stateDirectory: fixture.stateDirectory,
    leaseTimeoutMs: 120_000,
    scanIntervalMs: 15_000,
    now: () => NOW,
    logger,
    scan: async () => {
      const result = await fixture.scan();
      const registration = result.registrations[0];
      if (registration) {
        subject.disposition = classifyRunnerRegistration(registration, NOW, 120_000);
      }
      return result;
    },
    hydrate: async (registration) => ({
      ...registration,
      pidAlive: registration.pid === null
        ? false
        : fixture.processTable.isAlive(registration.pid),
    }),
    taskManager: {
      hydrateRunnerRecoveryTask: async () => task,
      markRunnerFailureAndResume: async (_task, _message, resume) => resume(task),
      listOwnerNullRunningInventory: async () => [],
      projectClosedRunner: async () => true,
      reconcileExecutionOwnershipObservations: async () => false,
    },
    taskExecutor: {
      recoverRegisteredRunner: async () => {
        counters.replay += 1;
        counters.terminal += 1;
        replayEntered.resolve();
        if (gateReplay) await releaseReplay.promise;
      },
      restartRegisteredRunner: async () => {},
    },
    closedTailDrainer: { drain: async () => {} },
    sessionGarbageCollector: { collect: async () => {} },
    spawner: {
      terminate: async (paths, expected) => {
        counters.terminate += 1;
        await fixture.spawner.terminate(paths, expected);
      },
      invalidateRegistration: async (paths, registrationId) =>
        await fixture.spawner.invalidateRegistration(paths, registrationId),
      retireTerminalRegistration: async (paths, registrationId) => {
        retireEntered.resolve();
        await fixture.spawner.retireTerminalRegistration(paths, registrationId);
        counters.retire += 1;
        fixture.processTable.events.push("retire");
      },
    },
  };
  subject.coordinator = new RunnerRecoveryCoordinator(options);
  return subject;
}

async function explicitResume(
  fixture: RetirementFixture,
  counters: ScenarioCounters,
  errors: string[],
): Promise<"completed" | "error"> {
  try {
    await fixture.spawner.spawn(fixture.input);
    counters.delivery = 1;
    counters.notification = 1;
    counters.consume = 1;
    counters.modelTurn = 1;
    return "completed";
  } catch (error) {
    errors.push(message(error));
    return "error";
  }
}

async function observe(
  row: 4 | 5 | 6 | 7 | 8,
  fixture: RetirementFixture,
  subject: Pick<CoordinatorSubject, "counters" | "errors" | "disposition">,
  resumeStatus: "completed" | "error",
): Promise<RetirementReproofObservation> {
  const evidence = await readRegistrationEvidence(fixture);
  if (evidence.identity?.retiredAt && !fixture.processTable.events.includes("retire")) {
    fixture.processTable.events.push("retire");
    subject.counters.retire = 1;
  }
  const events = [...fixture.processTable.events];
  const retireIndex = events.indexOf("retire");
  const beforeRetire = retireIndex < 0 ? events : events.slice(0, retireIndex);
  const observation = idealRetirementReproofObservation(row);
  return {
    ...observation,
    disposition: subject.disposition,
    events,
    errors: [...subject.errors],
    freshExactReproofCount: beforeRetire.filter(
      (event) => event === "fresh-exact-reproof",
    ).length,
    startIdentityCompared: fixture.processTable.exactIdentityWasCompared(),
    unrelatedPidSignalCount: fixture.processTable.signals.filter(
      ({ pid }) => pid !== fixture.processTable.oldPid(),
    ).length,
    resumeStatus,
    counts: {
      ...observation.counts,
      liveRunner: fixture.processTable.liveProcessCount(),
      writer: fixture.processTable.liveProcessCount(),
      registration: evidence.identity ? 1 : 0,
      executionOwner: resumeStatus === "completed" ? 1 : 0,
      generation: resumeStatus === "completed" ? 1 : 0,
      terminate: events.filter((event) => event === "terminate").length,
      exitProof: events.filter((event) => event === "exit-proof").length,
      replay: subject.counters.replay,
      retire: subject.counters.retire,
      spawn: events.filter((event) => event === "spawn").length,
      delivery: subject.counters.delivery,
      terminal: subject.counters.terminal,
      notification: subject.counters.notification,
      consume: subject.counters.consume,
      modelTurn: subject.counters.modelTurn,
    },
  };
}

async function holdMutationLock(fixture: RetirementFixture): Promise<{
  release: Deferred;
  completion: Promise<void>;
}> {
  const entered = deferred();
  const release = deferred();
  const completion = withRunnerSessionMutationLock(
    fixture.paths.sessionDirectory,
    async () => {
      entered.resolve();
      await release.promise;
    },
  );
  await entered.promise;
  return { release, completion };
}

function recoveryTask(): Task {
  return {
    agentSessionId: "session-retirement-reproof",
    prompt: "resume after retirement proof",
    status: "running",
    createdAt: new Date("2026-08-28T00:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

function exactProcess(registration: RunnerRegistration): { pid: number; startIdentity: string } {
  if (registration.pid === null || !registration.pidStartIdentity) {
    throw new Error("fixture exact process identity missing");
  }
  return { pid: registration.pid, startIdentity: registration.pidStartIdentity };
}

function evidenceMatchesOldProcess(
  fixture: RetirementFixture,
  evidence: Awaited<ReturnType<typeof readRegistrationEvidence>>,
): boolean {
  return evidence.identity?.pid === fixture.processTable.oldPid()
    && evidence.identity.startIdentity === fixture.processTable.oldStartIdentity()
    && evidence.identity.retiredAt === undefined
    && evidence.pidFile !== null
    && evidence.socketFile !== null;
}

function emptyCounters(): ScenarioCounters {
  return {
    terminate: 0,
    replay: 0,
    retire: 0,
    delivery: 0,
    terminal: 0,
    notification: 0,
    consume: 0,
    modelTurn: 0,
  };
}

function directSubject(counters: ScenarioCounters, errors: string[]) {
  return { counters, errors, disposition: undefined };
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function logMessage(record: unknown): string {
  if (typeof record === "object" && record !== null && "err" in record) {
    return message((record as { err: unknown }).err);
  }
  return message(record);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import type { RunnerProcessPaths } from "./runner_process_paths.js";
import {
  processStartIdentitiesMatch,
  type ProcessIdentity,
} from "./runner_process_lock.js";
import { unlinkIfPresent } from "./runner_registration_mutation.js";

const PROCESS_STOP_TIMEOUT_MS = 2_000;

export interface ProvenProcessTerminationDeps {
  inspectProcess(pid: number): Promise<ProcessIdentity>;
  isPidAlive(pid: number): boolean;
  signalPid(pid: number, signal: NodeJS.Signals): void;
  now(): number;
  delay(ms: number): Promise<void>;
}

export async function terminateProvenRunnerProcess(
  paths: RunnerProcessPaths,
  expected: { pid: number; startIdentity: string },
  deps: ProvenProcessTerminationDeps,
): Promise<void> {
  if (deps.isPidAlive(expected.pid)) {
    await assertSameProcess(expected, "SIGTERM", deps);
    deps.signalPid(expected.pid, "SIGTERM");
    const deadline = deps.now() + PROCESS_STOP_TIMEOUT_MS;
    while (deps.isPidAlive(expected.pid) && deps.now() < deadline) {
      await deps.delay(25);
    }
    if (deps.isPidAlive(expected.pid)) {
      await assertSameProcess(expected, "SIGKILL", deps);
      deps.signalPid(expected.pid, "SIGKILL");
      const killDeadline = deps.now() + PROCESS_STOP_TIMEOUT_MS;
      while (deps.isPidAlive(expected.pid) && deps.now() < killDeadline) {
        await deps.delay(25);
      }
    }
    if (deps.isPidAlive(expected.pid)) {
      throw new Error(`existing runner pid ${expected.pid} did not terminate`);
    }
  }
  await unlinkIfPresent(paths.pidPath);
  await unlinkIfPresent(paths.socketPath);
}

async function assertSameProcess(
  expected: { pid: number; startIdentity: string },
  signal: NodeJS.Signals,
  deps: Pick<ProvenProcessTerminationDeps, "inspectProcess">,
): Promise<void> {
  const observed = await deps.inspectProcess(expected.pid);
  if (
    !observed.alive
    || observed.startIdentity === null
    || !processStartIdentitiesMatch(observed.startIdentity, expected.startIdentity)
  ) {
    throw new Error(
      `runner process identity changed before ${signal}: ${expected.pid}`,
    );
  }
}

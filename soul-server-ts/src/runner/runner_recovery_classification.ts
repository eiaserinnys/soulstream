import {
  classifyRunnerRegistration,
  type RunnerRegistration,
  type RunnerRecoveryDisposition,
} from "./runner_process_registry.js";

export function classifyRunnerRegistrationSafely(
  registration: RunnerRegistration,
  now: number,
  leaseTimeoutMs: number,
  onError: (error: unknown) => void,
): RunnerRecoveryDisposition | undefined {
  try {
    return classifyRunnerRegistration(registration, now, leaseTimeoutMs);
  } catch (error) {
    onError(error);
    return undefined;
  }
}

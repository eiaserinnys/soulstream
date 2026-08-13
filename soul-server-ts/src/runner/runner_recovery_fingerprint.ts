import type {
  RunnerRecoveryDisposition,
  RunnerRegistration,
} from "./runner_process_registry.js";

export function pruneRecoveryFailureFingerprints(
  fingerprints: Map<string, string>,
  registrations: RunnerRegistration[],
): void {
  const currentSessionIds = new Set(
    registrations.map((registration) => registration.config.sessionId),
  );
  for (const sessionId of fingerprints.keys()) {
    if (!currentSessionIds.has(sessionId)) fingerprints.delete(sessionId);
  }
}

export function unreadableRegistrationFingerprint(failure: {
  error: Error;
  sessionId?: string;
  codeSha?: string;
}): string {
  const error = failure.error as Error & {
    code?: unknown;
    runnerRegistrationStage?: unknown;
  };
  return JSON.stringify({
    name: error.name,
    message: error.message,
    code: error.code ?? null,
    stage: error.runnerRegistrationStage ?? null,
    sessionId: failure.sessionId ?? null,
    codeSha: failure.codeSha ?? null,
  });
}

export function recoveryFailureFingerprint(
  registration: RunnerRegistration,
  disposition: RunnerRecoveryDisposition,
  failure: unknown,
): string {
  const error = failure instanceof Error ? failure : new Error(String(failure));
  const errorWithCode = error as Error & { code?: unknown };
  const code = errorWithCode.code;
  return JSON.stringify({
    disposition,
    name: error.name,
    message: error.message,
    code: code == null ? null : String(code),
    sessionId: registration.config.sessionId,
    codeSha: registration.config.codeSha,
    registrationId: registration.registrationId ?? null,
    pid: registration.pid,
    pidStartIdentity: registration.pidStartIdentity ?? null,
    pidAlive: registration.pidAlive,
    bootstrapStreamId: registration.bootstrap?.stream_id ?? null,
    lifecycleState: registration.lifecycle?.execution_state ?? null,
    lifecycleProgressSeq: registration.lifecycle?.progress_seq ?? null,
    lifecycleProgressAt: registration.lifecycle?.progress_at ?? null,
  });
}

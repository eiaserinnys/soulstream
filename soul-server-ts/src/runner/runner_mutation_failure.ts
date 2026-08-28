export type RunnerMutationFailureCode =
  | "runner_registration_identity_proof_failed"
  | "runner_termination_signal_failed"
  | "runner_termination_exit_proof_failed"
  | "runner_registration_persistence_failed";

export class RunnerMutationFailure extends Error {
  readonly recoverable = true;

  constructor(
    readonly code: RunnerMutationFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "RunnerMutationFailure";
  }
}

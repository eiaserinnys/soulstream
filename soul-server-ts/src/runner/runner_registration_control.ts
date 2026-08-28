import { RunnerMutationFailure } from "./runner_mutation_failure.js";
import { RunnerProcessSpawner } from "./runner_process_spawn.js";
import type { RunnerTerminationOutcome } from "./runner_process_termination.js";
import type { RunnerRegistration } from "./runner_process_registry.js";
import type { RunnerProcessPaths } from "./runner_process_paths.js";
import type { TerminalExecutionOwnershipIdentity } from "./runner_process_spawn.js";

type RegistrationSpawner = Pick<
  RunnerProcessSpawner,
  "invalidateRegistration" | "retireTerminalRegistration" | "terminate"
> & Partial<Pick<RunnerProcessSpawner, "retireTerminalOwnership">>;

export class RunnerRegistrationControl {
  constructor(private readonly spawner: RegistrationSpawner = new RunnerProcessSpawner()) {}

  async terminate(registration: RunnerRegistration): Promise<RunnerTerminationOutcome> {
    if (registration.pid === null || !registration.pidStartIdentity) {
      throw new RunnerMutationFailure(
        "runner_registration_identity_proof_failed",
        `runner process identity unavailable before termination: ${registration.config.sessionId}`,
      );
    }
    return await this.spawner.terminate(
      registration.config.paths,
      { pid: registration.pid, startIdentity: registration.pidStartIdentity },
    ) ?? "registration_invalidated";
  }

  async invalidate(registration: RunnerRegistration): Promise<void> {
    await this.spawner.invalidateRegistration(
      registration.config.paths,
      registration.registrationId ?? null,
    );
  }

  async retireTerminal(registration: RunnerRegistration): Promise<void> {
    await this.spawner.retireTerminalRegistration(
      registration.config.paths,
      registration.registrationId ?? null,
    );
  }

  async retireTerminalOwnership(
    paths: RunnerProcessPaths,
    expected: TerminalExecutionOwnershipIdentity,
    commitOwnership: () => Promise<boolean>,
  ): Promise<void> {
    if (!this.spawner.retireTerminalOwnership) {
      throw new Error("terminal execution ownership retirement is not configured");
    }
    await this.spawner.retireTerminalOwnership(
      { ...expected, paths },
      commitOwnership,
    );
  }
}

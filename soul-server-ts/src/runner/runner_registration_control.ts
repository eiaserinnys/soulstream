import { RunnerMutationFailure } from "./runner_mutation_failure.js";
import { RunnerProcessSpawner } from "./runner_process_spawn.js";
import type { RunnerTerminationOutcome } from "./runner_process_termination.js";
import type { RunnerRegistration } from "./runner_process_registry.js";

type RegistrationSpawner = Pick<
  RunnerProcessSpawner,
  "invalidateRegistration" | "retireTerminalRegistration" | "terminate"
> & Partial<Pick<RunnerProcessSpawner, "disposeUnprovenRegistration">>;

export class RunnerRegistrationControl {
  constructor(private readonly spawner: RegistrationSpawner = new RunnerProcessSpawner()) {}

  /**
   * An incomplete registration identity is residue, not proof of a live runner.
   *
   * Refusing to act on it is what made orphans permanent: the host invalidates
   * `pid`/`startIdentity` while the child survives, and every later disposal
   * died at this gate before a single signal was sent (15 consecutive failures
   * against pid 44892 on eias-linegames). There is no identity left to compare,
   * so disposition falls to the R30 substance comparison, which decides by what
   * the process behind the pid actually is. A registration that still proves an
   * identity keeps the unchanged exact-identity path and its fail-closed proof.
   */
  async terminate(registration: RunnerRegistration): Promise<RunnerTerminationOutcome> {
    if (registration.pid === null || !registration.pidStartIdentity) {
      if (!this.spawner.disposeUnprovenRegistration) {
        throw new RunnerMutationFailure(
          "runner_registration_identity_proof_failed",
          `runner process identity unavailable before termination: `
          + `${registration.config.sessionId}`,
        );
      }
      return await this.spawner.disposeUnprovenRegistration(registration.config.paths);
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
    if (!registration.pidAlive && registration.pidStartIdentity === null) {
      await this.retireReleasedTerminal(registration, async () => true);
      return;
    }
    await this.spawner.retireTerminalRegistration(
      registration.config.paths,
      registration.registrationId ?? null,
    );
  }

  async retireReleasedTerminal(
    registration: RunnerRegistration,
    confirmRetirementStillValid: () => Promise<boolean>,
  ): Promise<void> {
    if (
      registration.pidAlive
      || registration.pidStartIdentity !== null
    ) {
      throw new RunnerMutationFailure(
        "runner_registration_identity_proof_failed",
        `released terminal evidence is incomplete: ${registration.config.sessionId}`,
      );
    }
    await this.spawner.terminate(
      registration.config.paths,
      undefined,
      registration,
      confirmRetirementStillValid,
    );
  }

}

import { RunnerProcessSpawner } from "./runner_process_spawn.js";
import type { RunnerRegistration } from "./runner_process_registry.js";

type RegistrationSpawner = Pick<
  RunnerProcessSpawner,
  "invalidateRegistration" | "retireTerminalRegistration" | "terminate"
>;

export class RunnerRegistrationControl {
  constructor(private readonly spawner: RegistrationSpawner = new RunnerProcessSpawner()) {}

  async terminate(registration: RunnerRegistration): Promise<void> {
    if (registration.pid === null || !registration.pidStartIdentity) {
      throw new Error(
        `runner process identity unavailable before termination: ${registration.config.sessionId}`,
      );
    }
    await this.spawner.terminate(
      registration.config.paths,
      { pid: registration.pid, startIdentity: registration.pidStartIdentity },
    );
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
}

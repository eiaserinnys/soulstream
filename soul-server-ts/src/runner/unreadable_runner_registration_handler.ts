import type { Logger } from "pino";
import { unreadableRegistrationFingerprint } from "./runner_recovery_fingerprint.js";
import {
  quarantineUnreadableRunnerRegistration,
  type RunnerRegistrationQuarantineResult,
} from "./runner_registration_quarantine.js";

type RegistrationFailure = {
  directory: string;
  error: Error;
  sessionId?: string;
  codeSha?: string;
};

export class UnreadableRunnerRegistrationHandler {
  private readonly fingerprints = new Map<string, string>();

  constructor(private readonly options: {
    stateDirectory: string;
    logger: Pick<Logger, "error" | "info">;
    quarantineFailure?: typeof quarantineUnreadableRunnerRegistration;
  }) {}

  async handle(failures: RegistrationFailure[]): Promise<void> {
    const currentDirectories = new Set(failures.map((failure) => failure.directory));
    for (const directory of this.fingerprints.keys()) {
      if (!currentDirectories.has(directory)) this.fingerprints.delete(directory);
    }
    for (const failure of failures) {
      const fingerprint = unreadableRegistrationFingerprint(failure);
      const shouldLog = this.fingerprints.get(failure.directory) !== fingerprint;
      if (shouldLog) {
        const { error, ...failureContext } = failure;
        this.options.logger.error(
          { ...failureContext, err: error },
          "runner registration is unreadable",
        );
        this.fingerprints.set(failure.directory, fingerprint);
      }
      let result: RunnerRegistrationQuarantineResult;
      try {
        result = await (
          this.options.quarantineFailure ?? quarantineUnreadableRunnerRegistration
        )(this.options.stateDirectory, failure);
      } catch (error) {
        if (shouldLog) {
          this.options.logger.error(
            { err: error, directory: failure.directory, sessionId: failure.sessionId },
            "runner registration quarantine failed",
          );
        }
        continue;
      }
      if (result.status === "quarantined") {
        this.options.logger.info(
          {
            directory: failure.directory,
            quarantinePath: result.path,
            pid: result.pid,
            sessionId: failure.sessionId,
          },
          "proven-dead unreadable runner registration quarantined",
        );
      }
    }
  }
}

import type { Logger } from "pino";

import type { ProcessIdentity } from "../runner/runner_process_lock.js";
import { processStartIdentitiesMatch } from "../runner/runner_process_lock.js";
import type { CanonicalExecutionOwnership } from "./execution_ownership.js";

/**
 * Displaces an execution ownership whose owner process no longer exists.
 *
 * Ownership is released by its owner. When the owning process dies between
 * reserving and activating, nobody is left to release it: every later attempt
 * loses the reservation, and the compensation path fails *its own* generation,
 * which was never the one holding the session. The registration then stays put
 * and the recovery scan retries forever — 56 conflicts in one minute during the
 * 260820 incident, with no path that could ever converge.
 *
 * The escape is narrow on purpose, and it errs toward leaving the reservation
 * alone. Two things have to be proven before anything is displaced:
 *
 * - that the owner would be *here*. The pid is inspected on this host, so a
 *   session executing on another node would read as "no such process" and its
 *   perfectly healthy ownership would be revoked from across the cluster. The
 *   session's own node assignment is checked first.
 * - that the live process, if there is one, is still the recorded owner. Pids
 *   are reused, so a recycled pid would otherwise read as a live owner forever;
 *   the start identity recorded with the ownership settles it.
 *
 * Anything unproven — no pid, no start identity on either side, an unreadable
 * process, an unknown session — is treated as "still owned".
 */

export interface ExecutionOwnershipExpiryDeps {
  /** Fails the *named* generation, not the caller's. */
  fail(
    sessionId: string,
    ownershipGeneration: number,
    failureReason: string,
  ): Promise<{ applied: boolean }>;
  inspectProcess(pid: number): Promise<ProcessIdentity>;
  /** False whenever this node is not the one that executes the session. */
  isSessionExecutedHere(sessionId: string): Promise<boolean>;
  logger: Pick<Logger, "info" | "warn">;
}

export type ExecutionOwnershipExpiryOutcome =
  | "expired"
  | "owner_alive"
  | "owner_unknown"
  | "not_local"
  | "not_applied";

/** Pids are reused, so liveness alone never proves the *recorded* owner lives. */
function ownerIsGone(
  observed: ProcessIdentity,
  recordedStartIdentity: string | null,
): boolean {
  if (!observed.alive) return true;
  if (!recordedStartIdentity || !observed.startIdentity) return false;
  return !processStartIdentitiesMatch(observed.startIdentity, recordedStartIdentity);
}

export class ExecutionOwnershipExpiry {
  constructor(private readonly deps: ExecutionOwnershipExpiryDeps) {}

  async expireIfOwnerIsGone(
    sessionId: string,
    ownership: CanonicalExecutionOwnership | undefined,
  ): Promise<ExecutionOwnershipExpiryOutcome> {
    if (!ownership || ownership.pid === null) return "owner_unknown";
    if (ownership.phase === "terminal" || ownership.phase === "failed") {
      return "owner_unknown";
    }
    let executedHere: boolean;
    try {
      executedHere = await this.deps.isSessionExecutedHere(sessionId);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId },
        "could not confirm this node executes the session; leaving its ownership alone",
      );
      return "not_local";
    }
    if (!executedHere) return "not_local";
    let observed: ProcessIdentity;
    try {
      observed = await this.deps.inspectProcess(ownership.pid);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId, pid: ownership.pid },
        "could not inspect the execution owner process; leaving its ownership alone",
      );
      return "owner_unknown";
    }
    if (!ownerIsGone(observed, ownership.startIdentity)) return "owner_alive";

    const failureReason =
      `execution owner process ${ownership.pid} is gone while holding ${ownership.phase}`;
    let applied: boolean;
    try {
      const application = await this.deps.fail(
        sessionId,
        ownership.ownershipGeneration,
        failureReason,
      );
      applied = application.applied;
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId, ownershipGeneration: ownership.ownershipGeneration },
        "dead execution owner expiry failed",
      );
      return "not_applied";
    }
    if (!applied) return "not_applied";
    this.deps.logger.info(
      {
        sessionId,
        ownershipGeneration: ownership.ownershipGeneration,
        pid: ownership.pid,
        phase: ownership.phase,
      },
      "expired an execution ownership whose owner process is gone",
    );
    return "expired";
  }
}

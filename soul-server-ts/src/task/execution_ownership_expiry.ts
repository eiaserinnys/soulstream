import type { Logger } from "pino";

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
 * The escape is narrow on purpose. Ownership is only expired when the recorded
 * owner pid is known and provably gone; an unknown pid, a live pid, or a
 * missing ownership record all leave the reservation alone.
 */

export interface ExecutionOwnershipExpiryDeps {
  /** Fails the *named* generation, not the caller's. */
  fail(
    sessionId: string,
    ownershipGeneration: number,
    failureReason: string,
  ): Promise<{ applied: boolean }>;
  isProcessAlive(pid: number): boolean;
  logger: Pick<Logger, "info" | "warn">;
}

export type ExecutionOwnershipExpiryOutcome =
  | "expired"
  | "owner_alive"
  | "owner_unknown"
  | "not_applied";

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
    if (this.deps.isProcessAlive(ownership.pid)) return "owner_alive";

    const failureReason =
      `execution owner process ${ownership.pid} exited while holding ${ownership.phase}`;
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

/** `kill(pid, 0)` probes existence without signalling. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

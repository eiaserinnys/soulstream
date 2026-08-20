import type { Logger } from "pino";

/**
 * The single record of how long execution ownership asked callers to wait.
 *
 * The executor is where a rejected reservation is observed and the recovery
 * scan is what has to honour it, so neither can own this fact alone. One
 * instance is shared by both.
 *
 * A rejected reservation reports when it is worth trying again. The scan runs
 * on its own fixed interval and ignored that entirely, so a session whose
 * ownership was wedged was retried roughly four times faster than the contract
 * allowed — 56 conflicts in a minute during the 260820 incident, each one
 * rewriting the registration's identity file for nothing.
 *
 * After enough consecutive conflicts the session is dropped from the scan
 * altogether and said so out loud. A wedge that survives that many attempts is
 * not going to clear by being asked again on a timer; it needs the dead-owner
 * expiry path or an operator, and until then the scan should not spend itself
 * on it.
 */

const DEFAULT_MAX_CONSECUTIVE_CONFLICTS = 5;

interface ConflictState {
  retryAtMs: number;
  consecutive: number;
  excluded: boolean;
}

export interface ExecutionOwnershipBackoffOptions {
  logger: Pick<Logger, "warn" | "error">;
  now?: () => number;
  maxConsecutiveConflicts?: number;
}

export class ExecutionOwnershipBackoff {
  private readonly states = new Map<string, ConflictState>();
  private readonly now: () => number;
  private readonly maxConsecutiveConflicts: number;

  constructor(private readonly options: ExecutionOwnershipBackoffOptions) {
    this.now = options.now ?? (() => Date.now());
    this.maxConsecutiveConflicts = options.maxConsecutiveConflicts
      ?? DEFAULT_MAX_CONSECUTIVE_CONFLICTS;
  }

  /** True when this scan must leave the session alone. */
  shouldSkip(sessionId: string): boolean {
    const state = this.states.get(sessionId);
    if (!state) return false;
    if (state.excluded) return true;
    return this.now() < state.retryAtMs;
  }

  observeConflict(sessionId: string, retryAt: string): void {
    const parsed = Date.parse(retryAt);
    const retryAtMs = Number.isFinite(parsed) ? parsed : this.now();
    const previous = this.states.get(sessionId);
    const consecutive = (previous?.consecutive ?? 0) + 1;
    const excluded = consecutive >= this.maxConsecutiveConflicts;
    this.states.set(sessionId, { retryAtMs, consecutive, excluded });
    if (excluded && previous?.excluded !== true) {
      this.options.logger.error(
        { sessionId, consecutive, retryAt },
        "execution ownership conflict did not clear; dropping this session from runner recovery scans until its ownership changes",
      );
      return;
    }
    this.options.logger.warn(
      { sessionId, consecutive, retryAt },
      "runner recovery deferred by execution ownership backoff",
    );
  }

  clear(sessionId: string): void {
    this.states.delete(sessionId);
  }

  prune(sessionIds: Iterable<string>): void {
    const live = new Set(sessionIds);
    for (const sessionId of this.states.keys()) {
      if (!live.has(sessionId)) this.states.delete(sessionId);
    }
  }
}

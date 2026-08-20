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
 * After enough consecutive conflicts the session drops to a much longer probe
 * interval and says so once. It is deliberately not excluded outright: the
 * paths that could clear the wedge — the dead-owner expiry, an operator, the
 * owner finally releasing — all run *inside* a recovery attempt, so a session
 * that never gets attempted again could never recover either. Slowing the loop
 * by two orders of magnitude stops the churn while keeping convergence.
 */

const DEFAULT_MAX_CONSECUTIVE_CONFLICTS = 5;
/** Probe cadence once a session's conflicts stop clearing. */
const STUCK_PROBE_INTERVAL_MS = 5 * 60_000;

interface ConflictState {
  retryAtMs: number;
  consecutive: number;
  stuck: boolean;
}

export interface ExecutionOwnershipBackoffOptions {
  logger: Pick<Logger, "warn" | "error">;
  now?: () => number;
  maxConsecutiveConflicts?: number;
  stuckProbeIntervalMs?: number;
}

export class ExecutionOwnershipBackoff {
  private readonly states = new Map<string, ConflictState>();
  private readonly now: () => number;
  private readonly maxConsecutiveConflicts: number;
  private readonly stuckProbeIntervalMs: number;

  constructor(private readonly options: ExecutionOwnershipBackoffOptions) {
    this.now = options.now ?? (() => Date.now());
    this.maxConsecutiveConflicts = options.maxConsecutiveConflicts
      ?? DEFAULT_MAX_CONSECUTIVE_CONFLICTS;
    this.stuckProbeIntervalMs = options.stuckProbeIntervalMs
      ?? STUCK_PROBE_INTERVAL_MS;
  }

  /** True when this scan must leave the session alone. */
  shouldSkip(sessionId: string): boolean {
    const state = this.states.get(sessionId);
    if (!state) return false;
    return this.now() < state.retryAtMs;
  }

  observeConflict(sessionId: string, retryAt: string): void {
    const now = this.now();
    const parsed = Date.parse(retryAt);
    const requestedRetryAtMs = Number.isFinite(parsed) ? parsed : now;
    const previous = this.states.get(sessionId);
    const consecutive = (previous?.consecutive ?? 0) + 1;
    const stuck = consecutive >= this.maxConsecutiveConflicts;
    const retryAtMs = stuck
      ? Math.max(requestedRetryAtMs, now + this.stuckProbeIntervalMs)
      : requestedRetryAtMs;
    this.states.set(sessionId, { retryAtMs, consecutive, stuck });
    if (stuck && previous?.stuck !== true) {
      this.options.logger.error(
        {
          sessionId,
          consecutive,
          retryAt,
          probeIntervalMs: this.stuckProbeIntervalMs,
        },
        "execution ownership conflict is not clearing; runner recovery will only probe this session occasionally until it does",
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

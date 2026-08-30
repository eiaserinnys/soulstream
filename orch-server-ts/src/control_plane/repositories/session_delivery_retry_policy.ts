import type { SqlClient } from "../control_plane_types.js";

export interface DeliveryRetryInput {
  reason: string;
  /** State to return to for the next scheduling pass. */
  retryState: "pending" | "queued";
  /**
   * Delay before the next attempt. Omit to use the canonical backoff ladder.
   *
   * This is a duration, never an absolute instant: the caller's clock is not
   * the database's, and a node-computed timestamp compared against `NOW()`
   * either nullified the backoff or doubled it depending on skew direction
   * (7.45s measured between the WSL node and the host).
   */
  retryDelayMs?: number;
  /**
   * Keep an error already recorded on the row instead of overwriting it. Used
   * by the lease sweeper, whose own reason ("lease expired") is less useful
   * than whatever the previous owner recorded before it died.
   */
  preserveExistingError?: boolean;
  /**
   * Whether this counts as a delivery attempt. Default true.
   *
   * A liveness probe — "is the transcript settled yet?" — is not an attempt to
   * deliver anything, and it repeats on a one-second cadence. Charging it to
   * the attempt counter would misrepresent actual delivery attempts.
   */
  spendsAttempt?: boolean;
}

/**
 * Canonical scheduling-only retry SET clause. Time and attempt counts may move
 * the next scheduling instant; they never decide whether accepted input still
 * exists. Only an exact receipt or explicit invalidation owns that decision.
 */
export function deliveryRetrySet(
  sql: SqlClient,
  input: DeliveryRetryInput,
) {
  const spendsAttempt = input.spendsAttempt ?? true;
  const reason = input.preserveExistingError
    ? sql`COALESCE(last_error, ${input.reason})`
    : sql`${input.reason}`;
  const retryDelay = input.retryDelayMs === undefined
    ? sql`LEAST(
        INTERVAL '60 seconds',
        INTERVAL '100 milliseconds' * POWER(2, LEAST(attempt_count, 9))
      )`
    : sql`(${input.retryDelayMs}::double precision * INTERVAL '1 millisecond')`;
  return sql`
    attempt_count = attempt_count + ${spendsAttempt ? 1 : 0},
    state = ${input.retryState},
    aggregate_state = 'pending',
    lease_owner = NULL,
    lease_expires_at = NULL,
    next_attempt_at = NOW() + ${retryDelay},
    last_error = ${reason},
    updated_at = NOW()
  `;
}

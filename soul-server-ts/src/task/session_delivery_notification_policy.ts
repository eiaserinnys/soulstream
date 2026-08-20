export const DELIVERY_NOTIFICATION_MAX_ATTEMPTS = 16;
export const DELIVERY_NOTIFICATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function notificationOldestAllowedCreatedAt(now = new Date()): Date {
  return new Date(now.getTime() - DELIVERY_NOTIFICATION_MAX_AGE_MS);
}

/**
 * Canonical delivery backoff ladder, expressed as a *duration*.
 *
 * Retry scheduling crosses the node/host boundary, and the two clocks differ
 * (7.45s measured). A duration is evaluated against `NOW()` on the database
 * side, so the ladder means the same thing on every node; an absolute instant
 * computed here did not.
 */
export function deliveryRetryDelayMs(attemptCount: number): number {
  return Math.min(60_000, 100 * 2 ** Math.min(attemptCount, 9));
}

/**
 * Absolute variant, for the notification outbox projection whose repository
 * still takes an instant.
 */
export function notificationRetryAt(
  attemptCount: number,
  nowMs = Date.now(),
): Date {
  return new Date(nowMs + deliveryRetryDelayMs(attemptCount));
}

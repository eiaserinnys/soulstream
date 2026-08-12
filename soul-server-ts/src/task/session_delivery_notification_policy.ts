export const DELIVERY_NOTIFICATION_MAX_ATTEMPTS = 16;
export const DELIVERY_NOTIFICATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function notificationOldestAllowedCreatedAt(now = new Date()): Date {
  return new Date(now.getTime() - DELIVERY_NOTIFICATION_MAX_AGE_MS);
}

export function notificationRetryAt(
  attemptCount: number,
  nowMs = Date.now(),
): Date {
  const delayMs = Math.min(60_000, 100 * 2 ** Math.min(attemptCount, 9));
  return new Date(nowMs + delayMs);
}

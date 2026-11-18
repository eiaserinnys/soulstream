/**
 * Per-grant in-memory token bucket (design 2.8).
 *
 * The bucket lives in the orchestrator process only. It is reset on restart and
 * not shared between processes; that is enough to stop one looping external
 * agent from flooding a target session.
 */

export type ExternalAccessTokenTakeResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export interface ExternalAccessTokenBucketOptions {
  /** Milliseconds clock; injectable so tests do not sleep. */
  now?: () => number;
}

interface BucketState {
  tokens: number;
  updatedAt: number;
}

export class ExternalAccessTokenBucket {
  private readonly now: () => number;
  private readonly buckets = new Map<string, BucketState>();

  constructor(options: ExternalAccessTokenBucketOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Takes one token for `key`, refilling at `limitPerMinute`. */
  take(key: string, limitPerMinute: number): ExternalAccessTokenTakeResult {
    if (limitPerMinute <= 0) return { allowed: false, retryAfterSeconds: 60 };
    const now = this.now();
    const tokensPerMs = limitPerMinute / 60_000;
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens: limitPerMinute, updatedAt: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsed = Math.max(0, now - bucket.updatedAt);
      bucket.tokens = Math.min(limitPerMinute, bucket.tokens + elapsed * tokensPerMs);
      bucket.updatedAt = now;
    }
    if (bucket.tokens < 1) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((1 - bucket.tokens) / tokensPerMs / 1000),
      );
      return { allowed: false, retryAfterSeconds };
    }
    bucket.tokens -= 1;
    return { allowed: true };
  }
}

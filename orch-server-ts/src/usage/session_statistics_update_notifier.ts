/** Facts land event by event; listeners hear about them at most this often. */
export const SESSION_STATISTICS_UPDATE_INTERVAL_MS = 5_000;

export type SessionStatisticsUpdateNotifierOptions = {
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
};

/**
 * Coalesces session-statistics fact writes into stream notifications: at most
 * one notification per interval, and the trailing change always goes out
 * within one interval of the last write.
 */
export class SessionStatisticsUpdateNotifier {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly onError: (error: unknown) => void;
  private readonly listeners = new Set<() => void>();
  private lastNotifiedAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: SessionStatisticsUpdateNotifierOptions = {}) {
    const intervalMs = options.intervalMs ?? SESSION_STATISTICS_UPDATE_INTERVAL_MS;
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error(`intervalMs must be a positive integer: ${intervalMs}`);
    }
    this.intervalMs = intervalMs;
    this.now = options.now ?? (() => Date.now());
    this.onError = options.onError ?? (() => undefined);
  }

  /** Records one fact write; listeners fire immediately or on the trailing edge. */
  notify(): void {
    const now = this.now();
    if (this.timer !== undefined) return;
    const elapsed = this.lastNotifiedAt === null ? null : now - this.lastNotifiedAt;
    if (elapsed === null || elapsed >= this.intervalMs) {
      this.emit(now);
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.emit(this.now());
    }, this.intervalMs - elapsed);
    this.timer.unref?.();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private emit(now: number): void {
    this.lastNotifiedAt = now;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.onError(error);
      }
    }
  }
}

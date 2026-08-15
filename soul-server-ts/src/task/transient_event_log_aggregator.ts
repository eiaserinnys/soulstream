import type { Logger } from "pino";

export const TRANSIENT_EVENT_LOG_WINDOW_MS = 30_000;

type TransientEventOutcome = "dispatched" | "completed" | "failed";

/**
 * Replaces per-event broadcast info logs with one process-wide activity summary.
 * A timeout is armed only while the window has activity, so idle workers stay
 * silent and completed windows do not retain publisher instances.
 */
export class TransientEventLogAggregator {
  private dispatched = 0;
  private completed = 0;
  private failed = 0;
  private readonly sessionIds = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly logger: Pick<Logger, "info">) {}

  recordDispatch(sessionId: string): void {
    this.record("dispatched", sessionId);
  }

  recordCompleted(sessionId: string): void {
    this.record("completed", sessionId);
  }

  recordFailed(sessionId: string): void {
    this.record("failed", sessionId);
  }

  private record(outcome: TransientEventOutcome, sessionId: string): void {
    this[outcome] += 1;
    this.sessionIds.add(sessionId);
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), TRANSIENT_EVENT_LOG_WINDOW_MS);
    this.timer.unref?.();
  }

  private flush(): void {
    this.timer = undefined;
    const summary = {
      windowMs: TRANSIENT_EVENT_LOG_WINDOW_MS,
      dispatched: this.dispatched,
      completed: this.completed,
      failed: this.failed,
      sessionCount: this.sessionIds.size,
    };
    this.dispatched = 0;
    this.completed = 0;
    this.failed = 0;
    this.sessionIds.clear();
    this.logger.info(summary, "emitEventEnvelope activity summary");
  }
}

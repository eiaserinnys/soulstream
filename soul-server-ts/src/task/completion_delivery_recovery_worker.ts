import type { Logger } from "pino";

export interface CompletionDeliveryRecoveryWorkerDeps {
  recoverPending(): Promise<void>;
  logger: Pick<Logger, "warn">;
}

/** Replays durable completion rows until they leave pending/claimed state. */
export class CompletionDeliveryRecoveryWorker {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly deps: CompletionDeliveryRecoveryWorkerDeps,
    private readonly intervalMs = 5_000,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.deps.recoverPending();
    } catch (err) {
      this.deps.logger.warn({ err }, "Completion delivery recovery tick failed");
    } finally {
      this.running = false;
    }
  }
}

import type { Logger } from "pino";

export interface CompletionDeliveryRecoveryWorkerDeps {
  recoverPending(): Promise<void>;
  recoverNotifications(): Promise<void>;
  logger: Pick<Logger, "warn">;
}

/** Replays durable completion rows until they leave pending/claimed state. */
export class CompletionDeliveryRecoveryWorker {
  private timer?: NodeJS.Timeout;
  private activeTick?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly deps: CompletionDeliveryRecoveryWorkerDeps,
    private readonly intervalMs = 5_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref();
  }

  async stop(timeoutMs = 5_000): Promise<"drained" | "timed_out"> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!this.activeTick) return "drained";
    return await Promise.race([
      this.activeTick.then(() => "drained" as const),
      new Promise<"timed_out">((resolve) => {
        const timer = setTimeout(() => resolve("timed_out"), timeoutMs);
        timer.unref();
      }),
    ]);
  }

  async runOnce(): Promise<void> {
    if (this.stopping || this.activeTick) return;
    this.activeTick = this.runTick().finally(() => {
      this.activeTick = undefined;
    });
    await this.activeTick;
  }

  private async runTick(): Promise<void> {
    await this.runRecoveryStep(
      () => this.deps.recoverPending(),
      "Completion delivery recovery tick failed",
    );
    if (this.stopping) return;
    await this.runRecoveryStep(
      () => this.deps.recoverNotifications(),
      "Session notification recovery tick failed",
    );
  }

  private async runRecoveryStep(
    step: () => Promise<void>,
    message: string,
  ): Promise<void> {
    try {
      await step();
    } catch (err) {
      this.deps.logger.warn({ err }, message);
    }
  }
}

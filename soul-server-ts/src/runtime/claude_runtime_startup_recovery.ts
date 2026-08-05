import type { Logger } from "pino";

export interface ClaudeRuntimeStartupRecoveryDeps {
  recoverQueuedDeliveries(): Promise<number>;
  recoverBackgroundTasks(): Promise<number>;
  logger: Pick<Logger, "warn">;
  nodeId: string;
}

/** Retries startup-only Claude recovery without holding worker health hostage. */
export class ClaudeRuntimeStartupRecovery {
  private timer?: NodeJS.Timeout;
  private activeTick?: Promise<void>;
  private stopping = false;
  private queuedDeliveriesRecovered = false;
  private backgroundTasksRecovered = false;

  constructor(
    private readonly deps: ClaudeRuntimeStartupRecoveryDeps,
    private readonly intervalMs = 5_000,
  ) {}

  async start(): Promise<void> {
    this.stopping = false;
    await this.runOnce();
    this.scheduleRetry();
  }

  async stop(timeoutMs = 5_000): Promise<"drained" | "timed_out"> {
    this.stopping = true;
    this.clearRetry();
    if (!this.activeTick) return "drained";
    return await new Promise<"drained" | "timed_out">((resolve) => {
      const timer = setTimeout(() => resolve("timed_out"), timeoutMs);
      timer.unref();
      void this.activeTick!.then(() => {
        clearTimeout(timer);
        resolve("drained");
      });
    });
  }

  private async runOnce(): Promise<void> {
    if (this.stopping || this.activeTick || this.isComplete()) return;
    this.activeTick = this.runTick().finally(() => {
      this.activeTick = undefined;
    });
    await this.activeTick;
    if (this.isComplete()) this.clearRetry();
  }

  private async runTick(): Promise<void> {
    if (!this.queuedDeliveriesRecovered) {
      try {
        const count = await this.deps.recoverQueuedDeliveries();
        this.queuedDeliveriesRecovered = true;
        if (count > 0) {
          this.deps.logger.warn(
            { count, nodeId: this.deps.nodeId },
            "Reconciled queued deliveries after worker restart",
          );
        }
      } catch (err) {
        this.deps.logger.warn(
          { err, nodeId: this.deps.nodeId },
          "Queued delivery startup recovery failed; retry scheduled",
        );
      }
    }
    if (this.stopping) return;
    if (!this.backgroundTasksRecovered) {
      try {
        const count = await this.deps.recoverBackgroundTasks();
        this.backgroundTasksRecovered = true;
        if (count > 0) {
          this.deps.logger.warn(
            { count, nodeId: this.deps.nodeId },
            "Recovered in-flight Claude background tasks after worker restart",
          );
        }
      } catch (err) {
        this.deps.logger.warn(
          { err, nodeId: this.deps.nodeId },
          "Claude background task startup recovery failed; retry scheduled",
        );
      }
    }
  }

  private scheduleRetry(): void {
    if (this.stopping || this.timer || this.isComplete()) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref();
  }

  private clearRetry(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private isComplete(): boolean {
    return this.queuedDeliveriesRecovered && this.backgroundTasksRecovered;
  }
}

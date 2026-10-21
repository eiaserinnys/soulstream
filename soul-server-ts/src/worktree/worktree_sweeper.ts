import type { Logger } from "pino";

const FIRST_SWEEP_DELAY_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 60 * 60_000;

export class WorktreeSweeper {
  private firstTimer?: NodeJS.Timeout;
  private interval?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly options: {
    sweep: () => Promise<unknown>;
    logger: Pick<Logger, "info" | "warn">;
  }) {}

  start(): void {
    if (this.firstTimer || this.interval) return;
    this.firstTimer = setTimeout(() => {
      this.firstTimer = undefined;
      void this.tick();
      this.interval = setInterval(() => void this.tick(), SWEEP_INTERVAL_MS);
      this.interval.unref();
    }, FIRST_SWEEP_DELAY_MS);
    this.firstTimer.unref();
  }

  stop(): void {
    clearTimeout(this.firstTimer);
    clearInterval(this.interval);
    this.firstTimer = undefined;
    this.interval = undefined;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.options.logger.info(await this.options.sweep(), "Worktree sweep finished");
    } catch (err) {
      this.options.logger.warn({ err }, "Worktree sweep failed");
    } finally {
      this.running = false;
    }
  }
}

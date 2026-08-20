import type { Logger } from "pino";

import { PeriodicMaintenanceLoop } from "./periodic_maintenance_loop.js";

/**
 * `composeClaudeRuntime` awaits the first pass, so this deadline is also the
 * worst case this recovery can delay node startup. Before it existed, a wedged
 * recovery call blocked composition — and therefore the listener — forever.
 */
const STARTUP_RECOVERY_STEP_TIMEOUT_MS = 15_000;

export interface ClaudeRuntimeStartupRecoveryDeps {
  recoverQueuedDeliveries(): Promise<number>;
  recoverBackgroundTasks(): Promise<number>;
  logger: Pick<Logger, "info" | "warn" | "error">;
  nodeId: string;
}

/** Retries startup-only Claude recovery without holding worker health hostage. */
export class ClaudeRuntimeStartupRecovery {
  private readonly loop: PeriodicMaintenanceLoop;
  private queuedDeliveriesRecovered = false;
  private backgroundTasksRecovered = false;
  private stopped = false;

  constructor(
    private readonly deps: ClaudeRuntimeStartupRecoveryDeps,
    intervalMs = 5_000,
    stepTimeoutMs = STARTUP_RECOVERY_STEP_TIMEOUT_MS,
  ) {
    this.loop = new PeriodicMaintenanceLoop({
      lane: "claude-runtime-startup-recovery",
      steps: [
        {
          name: "recover_queued_deliveries",
          run: () => this.recoverQueuedDeliveries(),
        },
        {
          name: "recover_background_tasks",
          run: () => this.recoverBackgroundTasks(),
        },
      ],
      intervalMs,
      stepTimeoutMs,
      // A startup-only lane retires itself; a steady-state liveness summary
      // would only report a lane that is meant to stop.
      livenessIntervalMs: 0,
      logger: deps.logger,
    });
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.loop.start();
    this.retireIfComplete();
  }

  async stop(timeoutMs = 5_000): Promise<"drained" | "timed_out"> {
    this.stopped = true;
    return await this.loop.stop(timeoutMs);
  }

  private async recoverQueuedDeliveries(): Promise<void> {
    if (this.queuedDeliveriesRecovered) return;
    const count = await this.deps.recoverQueuedDeliveries();
    this.queuedDeliveriesRecovered = true;
    if (count > 0) {
      this.deps.logger.warn(
        { count, nodeId: this.deps.nodeId },
        "Reconciled queued deliveries after worker restart",
      );
    }
    this.retireIfComplete();
  }

  private async recoverBackgroundTasks(): Promise<void> {
    if (this.backgroundTasksRecovered) return;
    const count = await this.deps.recoverBackgroundTasks();
    this.backgroundTasksRecovered = true;
    if (count > 0) {
      this.deps.logger.warn(
        { count, nodeId: this.deps.nodeId },
        "Recovered in-flight Claude background tasks after worker restart",
      );
    }
    this.retireIfComplete();
  }

  private retireIfComplete(): void {
    if (this.stopped) return;
    if (!this.queuedDeliveriesRecovered || !this.backgroundTasksRecovered) return;
    this.stopped = true;
    void this.loop.stop(0);
  }
}

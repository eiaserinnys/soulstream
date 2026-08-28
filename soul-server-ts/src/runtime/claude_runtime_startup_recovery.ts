import type { Logger } from "pino";

import type { QueuedDeliveryTranscriptRecoveryPass } from
  "../task/queued_delivery_transcript_recovery.js";
import { PeriodicMaintenanceLoop } from "./periodic_maintenance_loop.js";

/**
 * `composeClaudeRuntime` awaits the first pass, so this deadline is also the
 * worst case this recovery can delay node startup. Before it existed, a wedged
 * recovery call blocked composition — and therefore the listener — forever.
 */
const STARTUP_RECOVERY_STEP_TIMEOUT_MS = 15_000;

export interface ClaudeRuntimeStartupRecoveryDeps {
  recoverQueuedDeliveries(): Promise<QueuedDeliveryTranscriptRecoveryPass>;
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
    const pass = await this.deps.recoverQueuedDeliveries();
    if (pass.settled > 0) {
      this.deps.logger.warn(
        { count: pass.settled, nodeId: this.deps.nodeId },
        "Reconciled queued deliveries after worker restart",
      );
    }
    // A claimed row may still have only an input receipt. Keep the existing
    // startup lane alive until a later empty pass proves that every queued
    // delivery either reached consumed or returned to replayable pending.
    if (pass.claimed > 0) return;
    this.queuedDeliveriesRecovered = true;
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

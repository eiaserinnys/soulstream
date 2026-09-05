import type { Logger } from "pino";

import type { QueuedDeliveryTranscriptRecoveryPass } from
  "../task/queued_delivery_transcript_recovery.js";
import type { ClaudeBackgroundGenerationRecoveryPass } from
  "../task/claude_background_generation_startup_recovery.js";
import { withDeadline } from "./deadline.js";

/**
 * Queued delivery reconciliation runs after runner convergence without
 * delaying listener or upstream-adapter readiness.
 */
const STARTUP_RECOVERY_STEP_TIMEOUT_MS = 15_000;

export interface ClaudeRuntimeStartupRecoveryDeps {
  recoverBackgroundGenerations?(): Promise<ClaudeBackgroundGenerationRecoveryPass>;
  recoverQueuedDeliveries(): Promise<QueuedDeliveryTranscriptRecoveryPass>;
  logger: Pick<Logger, "info" | "warn" | "error">;
  nodeId: string;
}

/** Runs each startup-only Claude recovery step at most once per worker boot. */
export class ClaudeRuntimeStartupRecovery {
  private startupRecovery?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly deps: ClaudeRuntimeStartupRecoveryDeps,
    private readonly stepTimeoutMs = STARTUP_RECOVERY_STEP_TIMEOUT_MS,
  ) {}

  /**
   * The worker startup boundary calls this only after runner registration and
   * adoption have completed their initial scan. The cached promise is the boot
   * cursor: no delivery ID can enter a second snapshot in the same process.
   */
  async afterRunnerRecovery(): Promise<void> {
    if (this.stopped) return;
    this.startupRecovery ??= this.recoverAll();
    await this.startupRecovery;
  }

  async stop(timeoutMs = 5_000): Promise<"drained" | "timed_out"> {
    this.stopped = true;
    const active = [this.startupRecovery]
      .filter((pending): pending is Promise<void> => pending !== undefined);
    if (active.length === 0) return "drained";
    return await Promise.race([
      Promise.allSettled(active).then(() => "drained" as const),
      new Promise<"timed_out">((resolve) => {
        const timer = setTimeout(() => resolve("timed_out"), timeoutMs);
        timer.unref?.();
      }),
    ]);
  }

  private async recoverAll(): Promise<void> {
    await this.recoverBackgroundGenerations();
    await this.recoverQueuedDeliveries();
  }

  private async recoverBackgroundGenerations(): Promise<void> {
    if (!this.deps.recoverBackgroundGenerations) return;
    try {
      const pass = await withDeadline(
        this.deps.recoverBackgroundGenerations(),
        this.stepTimeoutMs,
        () => new Error(
          `Background generation startup recovery exceeded ${this.stepTimeoutMs}ms`,
        ),
      );
      if (pass.recovered > 0) {
        this.deps.logger.warn(
          { count: pass.recovered, nodeId: this.deps.nodeId },
          "Reconciled legacy-lost Claude background generations after worker restart",
        );
      }
    } catch (err) {
      this.deps.logger.error(
        { err, nodeId: this.deps.nodeId },
        "Background generation startup recovery failed; boot pass will not retry",
      );
    }
  }

  private async recoverQueuedDeliveries(): Promise<void> {
    try {
      const pass = await withDeadline(
        this.deps.recoverQueuedDeliveries(),
        this.stepTimeoutMs,
        () => new Error(
          `Queued delivery startup recovery exceeded ${this.stepTimeoutMs}ms`,
        ),
      );
      if (pass.settled > 0) {
        this.deps.logger.warn(
          { count: pass.settled, nodeId: this.deps.nodeId },
          "Reconciled queued deliveries after worker restart",
        );
      }
    } catch (err) {
      this.deps.logger.error(
        { err, nodeId: this.deps.nodeId },
        "Queued delivery startup recovery failed; boot pass will not retry",
      );
    }
  }

}

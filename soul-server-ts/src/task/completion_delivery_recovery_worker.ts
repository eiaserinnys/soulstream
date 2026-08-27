import type { Logger } from "pino";

import { PeriodicMaintenanceLoop } from "../runtime/periodic_maintenance_loop.js";

/**
 * Comfortably above a healthy drain, so the deadline means "something is
 * wrong" rather than "the batch was large".
 *
 * Each step's own batch budget already stops it well inside its 60s claim
 * lease, so a step that reaches this deadline is stuck, not busy — which is
 * what makes the resulting error log worth reading.
 */
const RECOVERY_STEP_TIMEOUT_MS = 90_000;

export interface CompletionDeliveryRecoveryWorkerDeps {
  recoverPending(): Promise<void>;
  recoverNotifications(): Promise<void>;
  logger: Pick<Logger, "info" | "warn" | "error">;
}

/**
 * Reconciles durable delivery bookkeeping without replaying held input.
 *
 * The lane semantics — per-step deadlines, isolation of a hung step from its
 * siblings, and the stalled-tick watchdog — belong to PeriodicMaintenanceLoop.
 * `recoverPending` only releases abandoned admission leases; it cannot claim,
 * dispatch, or auto-resume queued input. Transcript-proven ACK reconciliation
 * is a separate one-shot startup boundary.
 */
export class CompletionDeliveryRecoveryWorker {
  private readonly loop: PeriodicMaintenanceLoop;

  constructor(
    deps: CompletionDeliveryRecoveryWorkerDeps,
    intervalMs = 5_000,
    stepTimeoutMs = RECOVERY_STEP_TIMEOUT_MS,
  ) {
    this.loop = new PeriodicMaintenanceLoop({
      lane: "session-deliveries",
      steps: [
        {
          name: "recover_pending_deliveries",
          run: () => deps.recoverPending(),
        },
        {
          name: "recover_delivery_notifications",
          run: () => deps.recoverNotifications(),
        },
      ],
      intervalMs,
      stepTimeoutMs,
      logger: deps.logger,
    });
  }

  start(): void {
    this.loop.start();
  }

  async stop(timeoutMs = 5_000): Promise<"drained" | "timed_out"> {
    return await this.loop.stop(timeoutMs);
  }

  async runOnce(): Promise<void> {
    await this.loop.runOnce();
  }
}

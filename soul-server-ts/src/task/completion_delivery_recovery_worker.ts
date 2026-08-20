import type { Logger } from "pino";

import { PeriodicMaintenanceLoop } from "../runtime/periodic_maintenance_loop.js";

/**
 * A step is generous enough for a full 100-row drain over the persistence host
 * (each host call is itself bounded at 10s by the transport) while still being
 * short enough that a wedged step is reported within one interval budget.
 */
const RECOVERY_STEP_TIMEOUT_MS = 60_000;

export interface CompletionDeliveryRecoveryWorkerDeps {
  recoverPending(): Promise<void>;
  recoverNotifications(): Promise<void>;
  logger: Pick<Logger, "info" | "warn" | "error">;
}

/**
 * Replays durable completion rows until they leave pending/claimed state.
 *
 * The lane semantics — per-step deadlines, isolation of a hung step from its
 * siblings, and the stalled-tick watchdog — belong to PeriodicMaintenanceLoop.
 * This class only declares which steps the session-delivery lane runs.
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

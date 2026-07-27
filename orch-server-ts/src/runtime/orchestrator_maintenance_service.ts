import type { PerNodeSessionCache } from "../node/session_cache.js";
import type { PushNotifier } from "../push/push_notifier.js";

export const ORCHESTRATOR_MAINTENANCE_INTERVAL_MS = 60_000;

export type OrchestratorMaintenanceSweepStats = {
  readonly sweptAtMs: number;
  readonly sessionCacheEntries: number;
  readonly pushNotifierEntries: number;
  readonly sessionCache: ReturnType<PerNodeSessionCache["sweepExpired"]>;
  readonly pushNotifier: ReturnType<PushNotifier["sweepExpired"]>;
};

export type OrchestratorMaintenanceServiceOptions = {
  readonly sessionCache: Pick<PerNodeSessionCache, "sweepExpired">;
  readonly pushNotifier: Pick<PushNotifier, "sweepExpired">;
  readonly intervalMs?: number;
  readonly nowMs?: () => number;
};

export class OrchestratorMaintenanceService {
  private readonly intervalMs: number;
  private readonly nowMs: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastSweepStats: OrchestratorMaintenanceSweepStats | null = null;

  constructor(private readonly options: OrchestratorMaintenanceServiceOptions) {
    this.intervalMs = options.intervalMs ?? ORCHESTRATOR_MAINTENANCE_INTERVAL_MS;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error("Orchestrator maintenance intervalMs must be a positive integer");
    }
    this.nowMs = options.nowMs ?? Date.now;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.sweepOnce();
    this.timer = setInterval(() => {
      this.sweepOnce();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  sweepOnce(): OrchestratorMaintenanceSweepStats {
    const sweptAtMs = this.nowMs();
    const sessionCache = this.options.sessionCache.sweepExpired(sweptAtMs);
    const pushNotifier = this.options.pushNotifier.sweepExpired(sweptAtMs);
    const stats = {
      sweptAtMs,
      sessionCacheEntries: sessionCache.total,
      pushNotifierEntries: pushNotifier.total,
      sessionCache,
      pushNotifier,
    };
    this.lastSweepStats = stats;
    return stats;
  }

  getLastSweepStats(): OrchestratorMaintenanceSweepStats | null {
    return this.lastSweepStats;
  }
}

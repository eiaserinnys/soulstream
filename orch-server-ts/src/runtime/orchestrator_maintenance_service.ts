import type { PerNodeSessionCache } from "../node/session_cache.js";
import type { PushNotifier } from "../push/push_notifier.js";
import type {
  MemoryStatsCollector,
  RuntimeMemorySummary,
} from "../system/memory_stats.js";

export const ORCHESTRATOR_MAINTENANCE_INTERVAL_MS = 60_000;
export const ORCHESTRATOR_MEMORY_LOG_INTERVAL_MS = 5 * 60_000;
export const ORCHESTRATOR_MEMORY_RSS_WARN_BYTES = 800 * 1024 * 1024;

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
  readonly memoryStats?: Pick<MemoryStatsCollector, "summary" | "collect">;
  readonly onInfo?: (event: OrchestratorMemoryLogEvent) => void;
  readonly onWarning?: (event: OrchestratorMemoryLogEvent) => void;
  readonly intervalMs?: number;
  readonly nowMs?: () => number;
};

export type OrchestratorMemoryLogEvent = {
  readonly memory: RuntimeMemorySummary;
  readonly swept: {
    readonly sessionCacheEntries: number;
    readonly pushNotifierEntries: number;
  };
};

export class OrchestratorMaintenanceService {
  private readonly intervalMs: number;
  private readonly nowMs: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastSweepStats: OrchestratorMaintenanceSweepStats | null = null;
  private lastMemoryLogAtMs: number | undefined;

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
    this.logMemoryIfDue(stats);
    return stats;
  }

  getLastSweepStats(): OrchestratorMaintenanceSweepStats | null {
    return this.lastSweepStats;
  }

  private logMemoryIfDue(stats: OrchestratorMaintenanceSweepStats): void {
    if (this.options.memoryStats === undefined) return;
    if (
      this.lastMemoryLogAtMs !== undefined &&
      stats.sweptAtMs - this.lastMemoryLogAtMs <
        ORCHESTRATOR_MEMORY_LOG_INTERVAL_MS
    ) {
      return;
    }
    this.lastMemoryLogAtMs = stats.sweptAtMs;
    const event = {
      memory: this.options.memoryStats.summary(),
      swept: {
        sessionCacheEntries: stats.sessionCacheEntries,
        pushNotifierEntries: stats.pushNotifierEntries,
      },
    };
    this.options.onInfo?.(event);
    if (event.memory.rss > ORCHESTRATOR_MEMORY_RSS_WARN_BYTES) {
      this.options.onWarning?.(event);
    }
  }
}

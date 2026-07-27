import { getHeapStatistics } from "node:v8";

export type MemoryStatsSource = {
  readonly name: string;
  readonly entries: () => number;
  readonly details?: () => Readonly<Record<string, number>>;
  readonly approxBytes?: () => number;
};

export type RuntimeMemorySummary = {
  readonly measuredAt: string;
  readonly rss: number;
  readonly heapUsed: number;
  readonly heapSizeLimit: number;
  readonly components: Readonly<Record<string, number>>;
};

export type RuntimeMemorySnapshot = {
  readonly measuredAt: string;
  readonly process: {
    readonly rss: number;
    readonly heapTotal: number;
    readonly heapUsed: number;
    readonly external: number;
    readonly arrayBuffers: number;
  };
  readonly v8: {
    readonly heapSizeLimit: number;
    readonly totalHeapSize: number;
    readonly totalAvailableSize: number;
    readonly usedHeapSize: number;
    readonly mallocedMemory: number;
    readonly externalMemory: number;
  };
  readonly components: Readonly<Record<string, {
    readonly entries: number;
    readonly details?: Readonly<Record<string, number>>;
    readonly approxBytes?: number;
  }>>;
};

export type MemoryStatsCollectorOptions = {
  readonly nowIso?: () => string;
  readonly memoryUsage?: () => {
    readonly rss: number;
    readonly heapTotal: number;
    readonly heapUsed: number;
    readonly external: number;
    readonly arrayBuffers: number;
  };
  readonly heapStatistics?: () => {
    readonly heap_size_limit: number;
    readonly total_heap_size: number;
    readonly total_available_size: number;
    readonly used_heap_size: number;
    readonly malloced_memory: number;
    readonly external_memory: number;
  };
};

export class MemoryStatsCollector {
  private readonly sources = new Map<string, MemoryStatsSource>();
  private readonly nowIso: () => string;
  private readonly memoryUsage: NonNullable<
    MemoryStatsCollectorOptions["memoryUsage"]
  >;
  private readonly heapStatistics: NonNullable<
    MemoryStatsCollectorOptions["heapStatistics"]
  >;

  constructor(options: MemoryStatsCollectorOptions = {}) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
    this.heapStatistics = options.heapStatistics ?? getHeapStatistics;
  }

  registerSource(source: MemoryStatsSource): void {
    if (this.sources.has(source.name)) {
      throw new Error(`Duplicate memory stats source: ${source.name}`);
    }
    this.sources.set(source.name, source);
  }

  summary(): RuntimeMemorySummary {
    const memory = this.memoryUsage();
    const heap = this.heapStatistics();
    return {
      measuredAt: this.nowIso(),
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapSizeLimit: heap.heap_size_limit,
      components: Object.fromEntries(
        [...this.sources.values()].map((source) => [
          source.name,
          source.entries(),
        ]),
      ),
    };
  }

  collect(): RuntimeMemorySnapshot {
    const memory = this.memoryUsage();
    const heap = this.heapStatistics();
    return {
      measuredAt: this.nowIso(),
      process: {
        rss: memory.rss,
        heapTotal: memory.heapTotal,
        heapUsed: memory.heapUsed,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
      },
      v8: {
        heapSizeLimit: heap.heap_size_limit,
        totalHeapSize: heap.total_heap_size,
        totalAvailableSize: heap.total_available_size,
        usedHeapSize: heap.used_heap_size,
        mallocedMemory: heap.malloced_memory,
        externalMemory: heap.external_memory,
      },
      components: Object.fromEntries(
        [...this.sources.values()].map((source) => {
          const details = source.details?.();
          const approxBytes = source.approxBytes?.();
          return [
            source.name,
            {
              entries: source.entries(),
              ...(details === undefined ? {} : { details }),
              ...(approxBytes === undefined ? {} : { approxBytes }),
            },
          ];
        }),
      ),
    };
  }
}

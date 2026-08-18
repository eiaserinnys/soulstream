import type { Logger } from "pino";
import type { scanRunnerRegistrations } from "./runner_process_registry.js";
import type { RunnerSessionGarbageCollector } from "./runner_session_gc.js";

const SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

export class RunnerSessionGarbageCollectionScheduler {
  private collectionInFlight: Promise<void> | undefined;
  private nextCollectionAtMs = 0;

  constructor(private readonly options: {
    collector?: Pick<RunnerSessionGarbageCollector, "collect">;
    logger: Pick<Logger, "error">;
    now: () => number;
  }) {}

  get inFlight(): Promise<void> | undefined {
    return this.collectionInFlight;
  }

  schedule(scan: Awaited<ReturnType<typeof scanRunnerRegistrations>>): void {
    if (
      !this.options.collector
      || this.collectionInFlight
      || (scan.registrations.length === 0 && scan.errors.length === 0)
    ) return;
    const now = this.options.now();
    if (now < this.nextCollectionAtMs) return;
    this.nextCollectionAtMs = now + SWEEP_INTERVAL_MS;
    const collection = this.options.collector.collect(scan)
      .then(() => undefined)
      .catch((error) => {
        this.nextCollectionAtMs = 0;
        this.options.logger.error({ err: error }, "runner session GC failed");
      })
      .finally(() => {
        if (this.collectionInFlight === collection) {
          this.collectionInFlight = undefined;
        }
      });
    this.collectionInFlight = collection;
  }
}

import type {
  TurnSummaryCatchUpRepositoryPort,
} from "./turn_summary_catch_up_repository.js";
import { findUsageLimitError } from "./error_chain.js";
import type {
  TurnSummaryConfigService,
  TurnSummaryLogger,
} from "./turn_summary_config.js";
import type { TurnSummaryPipeline } from "./turn_summary_pipeline.js";

const INITIAL_SWEEP_DELAY_MS = 60_000;
const CANDIDATE_MIN_AGE_MS = 10 * 60_000;

interface RememberedTurn {
  readonly sessionId: string;
  readonly completeEventId: number;
  readonly rememberedAt: number;
}

export class TurnSummaryCatchUpSweep {
  private timer: ReturnType<typeof setInterval> | undefined;
  private initialTimer: ReturnType<typeof setTimeout> | undefined;
  private activeSweep: Promise<void> | undefined;
  private stopped = false;
  private readonly remembered = new Map<string, RememberedTurn>();
  private readonly nowMs: () => number;

  constructor(private readonly deps: {
    readonly repository: Pick<
      TurnSummaryCatchUpRepositoryPort,
      "listCatchUpCandidates"
    >;
    readonly pipeline: Pick<TurnSummaryPipeline, "enqueue">;
    readonly configService: Pick<TurnSummaryConfigService, "read">;
    readonly logger: TurnSummaryLogger;
    readonly nowMs?: () => number;
  }) {
    this.nowMs = deps.nowMs ?? Date.now;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.stopped = false;
    const config = this.deps.configService.read();
    this.initialTimer = setTimeout(() => {
      this.initialTimer = undefined;
      void this.sweep();
    }, INITIAL_SWEEP_DELAY_MS);
    this.initialTimer.unref?.();
    this.timer = setInterval(
      () => void this.sweep(),
      config.catchUpIntervalMs,
    );
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.initialTimer !== undefined) {
      clearTimeout(this.initialTimer);
      this.initialTimer = undefined;
    }
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async drain(): Promise<void> {
    await this.activeSweep;
  }

  async sweep(): Promise<void> {
    if (this.activeSweep !== undefined) return await this.activeSweep;
    const active = this.executeSweep().finally(() => {
      if (this.activeSweep === active) this.activeSweep = undefined;
    });
    this.activeSweep = active;
    return await active;
  }

  private async executeSweep(): Promise<void> {
    try {
      const config = this.deps.configService.read();
      if (!config.turnEnabled) return;
      const now = this.nowMs();
      this.pruneRemembered(now, config.catchUpWindowHours);
      const candidates = await this.deps.repository.listCatchUpCandidates({
        since: new Date(now - config.catchUpWindowHours * 3_600_000),
        olderThan: new Date(now - CANDIDATE_MIN_AGE_MS),
        excludedFolderIds: config.excludedFolderIds,
        excludedTurns: [...this.remembered.values()].map(
          ({ sessionId, completeEventId }) => ({ sessionId, completeEventId }),
        ),
        limit: config.catchUpMaxJobsPerRound,
      });
      let enqueued = 0;
      let stored = 0;
      let skipped = 0;
      let failed = 0;
      let remembered = 0;
      let stoppedByUsageLimit = false;
      for (const candidate of candidates) {
        if (this.stopped) break;
        if (this.remembered.has(rememberedKey(candidate))) {
          remembered += 1;
          continue;
        }
        enqueued += 1;
        const outcome = await this.deps.pipeline.enqueue({
          nodeId: candidate.nodeId,
          sessionId: candidate.sessionId,
          completeEventId: candidate.completeEventId,
        });
        if (outcome.status === "stored") {
          stored += 1;
          continue;
        }
        if (outcome.status === "skipped") {
          skipped += 1;
          if (
            outcome.reason !== "provider_unavailable" &&
            outcome.reason !== "disabled"
          ) {
            this.remember(candidate, now);
          }
          continue;
        }
        const usageLimit = findUsageLimitError(outcome.error);
        if (usageLimit !== undefined) {
          stoppedByUsageLimit = true;
          this.deps.logger.warn(
            {
              sessionId: candidate.sessionId,
              completeEventId: candidate.completeEventId,
              limitCode: usageLimit.code,
              limitMessage: usageLimit.message,
              err: outcome.error,
            },
            "Turn summary catch-up stopped: usage limit",
          );
          break;
        }
        failed += 1;
        this.remember(candidate, now);
      }
      this.deps.logger.info?.(
        {
          candidates: candidates.length,
          enqueued,
          stored,
          skipped,
          failed,
          remembered,
          stoppedByUsageLimit,
        },
        "Turn summary catch-up",
      );
    } catch (error) {
      this.deps.logger.warn({ err: error }, "Turn summary catch-up failed");
    }
  }

  private remember(
    candidate: { readonly sessionId: string; readonly completeEventId: number },
    now: number,
  ): void {
    this.remembered.set(rememberedKey(candidate), {
      sessionId: candidate.sessionId,
      completeEventId: candidate.completeEventId,
      rememberedAt: now,
    });
  }

  private pruneRemembered(now: number, windowHours: number): void {
    const cutoff = now - windowHours * 3_600_000;
    for (const [key, turn] of this.remembered) {
      if (turn.rememberedAt < cutoff) this.remembered.delete(key);
    }
  }
}

function rememberedKey(candidate: {
  readonly sessionId: string;
  readonly completeEventId: number;
}): string {
  return `${candidate.sessionId}\u0000${candidate.completeEventId}`;
}


import type { SessionStoryFoldService } from
  "./session_story_fold_service.js";
import type {
  SessionStoryRepositoryPort,
} from "./session_story_repository.js";
import type {
  TurnSummaryConfigService,
  TurnSummaryLogger,
} from "./turn_summary_config.js";

const COMPLETION_CANDIDATE_LIMIT = 100;

export class SessionStoryCompletionSweep {
  private timer: ReturnType<typeof setInterval> | undefined;
  private activeSweep: Promise<void> | undefined;
  private readonly nowMs: () => number;

  constructor(private readonly deps: {
    readonly repository: Pick<
      SessionStoryRepositoryPort,
      "listCompletedFoldCandidates"
    >;
    readonly folder: Pick<SessionStoryFoldService, "foldCompletedIfNeeded">;
    readonly configService: Pick<TurnSummaryConfigService, "read">;
    readonly logger: TurnSummaryLogger;
    readonly nowMs?: () => number;
  }) {
    this.nowMs = deps.nowMs ?? Date.now;
  }

  start(): void {
    if (this.timer !== undefined) return;
    const config = this.deps.configService.read();
    void this.sweep();
    this.timer = setInterval(
      () => void this.sweep(),
      config.storyCompletionSweepIntervalMs,
    );
    this.timer.unref?.();
  }

  stop(): void {
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
      if (!config.enabled) return;
      const completedBefore = new Date(
        this.nowMs() - config.storyCompletionGraceMs,
      );
      const candidates =
        await this.deps.repository.listCompletedFoldCandidates({
          completedBefore,
          minimumSummaryCount: config.storyCompletionMinSummaries,
          limit: COMPLETION_CANDIDATE_LIMIT,
        });
      for (const candidate of candidates) {
        await this.deps.folder.foldCompletedIfNeeded(
          candidate,
          completedBefore,
          config.storyCompletionMinSummaries,
        );
      }
    } catch (error) {
      this.deps.logger.warn(
        { error },
        "Session story completion sweep failed",
      );
    }
  }
}

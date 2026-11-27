import type {
  CodexExecGenerateOptions,
} from "./codex_exec_turn_summarizer.js";
import type { SessionStoryTurnSummary } from "@soulstream/mcp-contract";
import type {
  CompletedSessionFoldCandidate,
  SessionStoryRepositoryPort,
  StoreSessionStoryDigestInput,
} from "./session_story_repository.js";
import type {
  TurnSummaryConfig,
  TurnSummaryConfigService,
  TurnSummaryLogger,
} from "./turn_summary_config.js";
import type {
  TurnSummaryResult,
  TurnSummaryUsage,
} from "./turn_summarizer.js";
import { errorCodeOf, errorMessageOf } from "./error_chain.js";
import {
  buildSessionStoryPrompt,
  markerOrderStats,
  observeOutputShape,
  parseSessionStoryOutput,
  type SessionStoryOutput,
} from "./session_story_output.js";
export { markerOrderStats } from "./session_story_output.js";

const STORY_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["narrative", "highlight"],
  properties: {
    narrative: {
      type: "string",
      pattern: "\\[T\\d+(?:-T\\d+)?\\]",
    },
    highlight: { type: "string" },
  },
} as const;


type FoldKind = "batch" | "completed_chunk" | "completed";
type FoldContext = {
  foldKind: FoldKind;
  summaryCount: number;
  promptChars: number;
  timeoutMs: number | null;
  startedAt: number;
};

export interface SessionStoryGenerator {
  generate(
    prompt: string,
    config: TurnSummaryConfig,
    options?: CodexExecGenerateOptions,
  ): Promise<TurnSummaryResult>;
}

export class SessionStoryFoldService {
  private readonly inFlight = new Set<string>();
  private readonly failureCooldownUntil = new Map<string, number>();
  private readonly nowMs: () => number;

  constructor(private readonly deps: {
    readonly repository: SessionStoryRepositoryPort;
    readonly configService: Pick<TurnSummaryConfigService, "read">;
    readonly generator: SessionStoryGenerator;
    readonly logger: TurnSummaryLogger;
    readonly nowMs?: () => number;
  }) {
    this.nowMs = deps.nowMs ?? Date.now;
  }

  async foldIfNeeded(sessionId: string): Promise<void> {
    await this.runExclusive(sessionId, "batch", async (startedAt, context, config) => {
      const digest = await this.deps.repository.loadDigest(sessionId);
      let narrative = digest?.narrative ?? null;
      let watermark = digest?.narrativeThroughEventId ?? null;
      let expectedVersion = digest?.version ?? 0;
      let foldCount = digest?.foldCount ?? 0;
      for (
        let batch = 0;
        batch < config.storyFoldMaxBatchesPerRun;
        batch += 1
      ) {
        const unfoldedCount =
          await this.deps.repository.countUnfoldedSummaries(
            sessionId,
            watermark,
          );
        if (unfoldedCount < config.storyFoldThreshold) {
          if (batch === 0) {
            this.debugSkip(sessionId, "below_threshold", {
              unfoldedCount,
              threshold: config.storyFoldThreshold,
            });
          }
          return;
        }
        Object.assign(context, { foldKind: "batch", summaryCount: 0, promptChars: 0, startedAt: this.nowMs() });
        const summaries = await this.deps.repository.loadUnfoldedSummaries(
          sessionId,
          watermark,
          config.storyFoldBatchSize,
        );
        if (summaries.length < config.storyFoldBatchSize) {
          this.debugSkip(sessionId, "batch_incomplete", {
            unfoldedCount,
            loadedCount: summaries.length,
          });
          return;
        }
        const nextNarrative = await this.generateAndStore({
          sessionId,
          config,
          narrative,
          expectedVersion,
          foldCount,
          summaries,
          startedAt,
          context,
          foldKind: "batch",
          conflictReason: "version_conflict",
          store: async (input) => await this.deps.repository.storeDigest(input),
        });
        if (nextNarrative === null) return;
        const lastSummary = summaries[summaries.length - 1];
        if (lastSummary === undefined) return;
        narrative = nextNarrative;
        watermark = lastSummary.eventId;
        expectedVersion += 1;
        foldCount += 1;
      }
    });
  }

  async foldCompletedIfNeeded(
    candidate: CompletedSessionFoldCandidate,
    completedBefore: Date,
    minimumSummaryCount: number,
  ): Promise<void> {
    await this.runExclusive(candidate.sessionId, "completed", async (startedAt, context, config) => {
      const digest = await this.deps.repository.loadDigest(candidate.sessionId);
      const counts = await this.deps.repository.countTurnSummaries(
        candidate.sessionId,
      );
      if (
        counts.totalCount < minimumSummaryCount ||
        counts.undigestedCount === 0
      ) {
        this.debugSkip(candidate.sessionId, "completed_not_eligible", {
          totalCount: counts.totalCount,
          undigestedCount: counts.undigestedCount,
          minimumSummaryCount,
        });
        return;
      }
      let narrative = digest?.narrative ?? null;
      let watermark = digest?.narrativeThroughEventId ?? null;
      let expectedVersion = digest?.version ?? 0;
      let foldCount = digest?.foldCount ?? 0;
      let remaining = counts.undigestedCount;
      const maxSummaries = config.storyCompletedFoldMaxSummaries;
      while (remaining > maxSummaries) {
        Object.assign(context, { foldKind: "completed_chunk", summaryCount: 0, promptChars: 0, startedAt: this.nowMs() });
        const summaries = await this.deps.repository.loadUnfoldedSummaries(
          candidate.sessionId,
          watermark,
          maxSummaries,
        );
        if (summaries.length !== maxSummaries) {
          this.debugSkip(candidate.sessionId, "completed_tail_changed", {
            expectedCount: maxSummaries,
            loadedCount: summaries.length,
          });
          return;
        }
        const nextNarrative = await this.generateAndStore({
          sessionId: candidate.sessionId,
          config,
          narrative,
          expectedVersion,
          foldCount,
          summaries,
          startedAt,
          context,
          foldKind: "completed_chunk",
          conflictReason: "completion_guard_conflict",
          store: async (input) => await this.deps.repository.storeDigest(input),
        });
        if (nextNarrative === null) return;
        const lastSummary = summaries[summaries.length - 1];
        if (lastSummary === undefined) return;
        narrative = nextNarrative;
        watermark = lastSummary.eventId;
        expectedVersion += 1;
        foldCount += 1;
        remaining -= maxSummaries;
      }
      Object.assign(context, { foldKind: "completed", summaryCount: 0, promptChars: 0, startedAt: this.nowMs() });
      const summaries = await this.deps.repository.loadUnfoldedSummaries(
        candidate.sessionId,
        watermark,
        remaining,
      );
      if (summaries.length !== remaining) {
        this.debugSkip(candidate.sessionId, "completed_tail_changed", {
          expectedCount: remaining,
          loadedCount: summaries.length,
        });
        return;
      }
      await this.generateAndStore({
        sessionId: candidate.sessionId,
        config,
        narrative,
        expectedVersion,
        foldCount,
        summaries,
        startedAt,
        context,
        foldKind: "completed",
        conflictReason: "completion_guard_conflict",
        store: async (input) =>
          await this.deps.repository.storeCompletedDigest({
            ...input,
            completedAt: candidate.completedAt,
            completedBefore,
            minimumSummaryCount,
          }),
      });
    });
  }

  private async runExclusive(
    sessionId: string,
    foldKind: FoldKind,
    action: (startedAt: number, context: FoldContext, config: TurnSummaryConfig) => Promise<void>,
  ): Promise<void> {
    if (this.inFlight.has(sessionId)) {
      this.deps.logger.info?.(
        { reason: "already_in_flight", sessionId },
        "Session story fold skipped",
      );
      return;
    }
    this.inFlight.add(sessionId);
    const startedAt = this.nowMs();
    const context: FoldContext = { foldKind, summaryCount: 0, promptChars: 0, timeoutMs: null, startedAt };
    let config: TurnSummaryConfig | undefined;
    try {
      config = this.deps.configService.read();
      context.timeoutMs = config.storyTimeoutMs;
      if (!config.sessionEnabled) return;
      const cooldownUntil = this.failureCooldownUntil.get(sessionId);
      if (cooldownUntil !== undefined && startedAt < cooldownUntil) {
        this.debugSkip(sessionId, "failure_cooldown");
        return;
      }
      if (cooldownUntil !== undefined) this.failureCooldownUntil.delete(sessionId);
      await action(startedAt, context, config);
    } catch (error) {
      if (config !== undefined) this.setFailureCooldown(sessionId, config);
      this.deps.logger.warn(
        {
          sessionId,
          foldKind: context.foldKind,
          summaryCount: context.summaryCount,
          promptChars: context.promptChars,
          timeoutMs: context.timeoutMs,
          elapsedMs: Math.max(0, this.nowMs() - context.startedAt),
          reason: "fold_error",
          errorCode: errorCodeOf(error),
          error: errorMessageOf(error),
        },
        "Session story fold failed",
      );
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  private async generateAndStore(input: {
    readonly sessionId: string;
    readonly config: TurnSummaryConfig;
    readonly narrative: string | null;
    readonly expectedVersion: number;
    readonly foldCount: number;
    readonly summaries: readonly SessionStoryTurnSummary[];
    readonly startedAt: number;
    readonly context: FoldContext;
    readonly foldKind: FoldKind;
    readonly conflictReason: string;
    readonly store: (value: StoreSessionStoryDigestInput) => Promise<boolean>;
  }): Promise<string | null> {
    input.context.foldKind = input.foldKind;
    input.context.summaryCount = input.summaries.length;
    const prompt = buildSessionStoryPrompt(
      input.config.storyInstruction,
      input.config.storyNarrativeMaxChars,
      input.narrative,
      input.summaries,
    );
    Object.assign(input.context, {
      foldKind: input.foldKind,
      summaryCount: input.summaries.length,
      promptChars: Array.from(prompt).length,
      startedAt: this.nowMs(),
    });
    const generated = await this.generateStructuredStory(
      prompt,
      input.config,
      input.sessionId,
      input.context,
    );
    if (generated === null) {
      this.setFailureCooldown(input.sessionId, input.config);
      return null;
    }
    const lastSummary = input.summaries[input.summaries.length - 1];
    if (lastSummary === undefined) return null;
    observeOutputShape(
      generated.output,
      input.config,
      input.sessionId,
      this.deps.logger,
    );
    const stored = await input.store({
      sessionId: input.sessionId,
      narrative: generated.output.narrative,
      highlight: generated.output.highlight,
      narrativeThroughEventId: lastSummary.eventId,
      expectedVersion: input.expectedVersion,
    });
    if (!stored) {
      this.deps.logger.info?.(
        {
          sessionId: input.sessionId,
          reason: input.conflictReason,
          expectedVersion: input.expectedVersion,
        },
        "Session story fold skipped",
      );
      return null;
    }
    this.failureCooldownUntil.delete(input.sessionId);
    const markerStats = markerOrderStats(generated.output.narrative);
    this.deps.logger.info?.(
      {
        sessionId: input.sessionId,
        foldKind: input.foldKind,
        summaryCount: input.summaries.length,
        promptChars: input.context.promptChars,
        timeoutMs: input.config.storyTimeoutMs,
        model: generated.model,
        latencyMs: Math.max(0, this.nowMs() - input.startedAt),
        modelLatencyMs: generated.latencyMs,
        attempts: generated.attempts,
        usage: generated.usage,
        inputTokens: generated.usage?.input_tokens,
        outputTokens: generated.usage?.output_tokens,
        markerCount: markerStats.markerCount,
        markerInversionPairs: markerStats.inversionPairs,
        foldedTurnCount: input.summaries.length,
        narrativeThroughEventId: lastSummary.eventId,
        foldCount: input.foldCount + 1,
      },
      "Session story fold stored",
    );
    return generated.output.narrative;
  }

  private async generateStructuredStory(
    prompt: string,
    config: TurnSummaryConfig,
    sessionId: string,
    context: FoldContext,
  ): Promise<{
    readonly output: SessionStoryOutput;
    readonly model: string;
    readonly latencyMs: number;
    readonly attempts: number;
    readonly usage?: TurnSummaryUsage;
  } | null> {
    let lastError: unknown;
    let modelLatencyMs = 0;
    let usage: TurnSummaryUsage | undefined;
    const storyConfig = { ...config, timeoutMs: config.storyTimeoutMs };
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await this.deps.generator.generate(prompt, storyConfig, {
          maxAttempts: 1,
          outputSchema: STORY_OUTPUT_SCHEMA,
        });
        modelLatencyMs += result.latencyMs;
        usage = sumUsage(usage, result.usage);
        const output = parseSessionStoryOutput(result.content);
        return {
          output,
          model: result.model,
          latencyMs: modelLatencyMs,
          attempts: attempt,
          ...(usage === undefined ? {} : { usage }),
        };
      } catch (error) {
        lastError = error;
      }
    }
    this.deps.logger.warn(
      {
        sessionId,
        foldKind: context.foldKind,
        summaryCount: context.summaryCount,
        promptChars: context.promptChars,
        timeoutMs: context.timeoutMs,
        elapsedMs: Math.max(0, this.nowMs() - context.startedAt),
        reason: "invalid_structured_output",
        errorCode: errorCodeOf(lastError),
        error: errorMessageOf(lastError),
        attempts: 2,
        modelLatencyMs,
        usage,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
      },
      "Session story fold failed",
    );
    return null;
  }

  private setFailureCooldown(sessionId: string, config: TurnSummaryConfig): void {
    this.failureCooldownUntil.set(sessionId, this.nowMs() + config.storyFoldFailureCooldownMs);
  }

  private debugSkip(
    sessionId: string,
    reason: string,
    details: Record<string, unknown> = {},
  ): void {
    this.deps.logger.debug?.(
      { ...details, reason, sessionId },
      "Session story fold skipped",
    );
  }
}

function sumUsage(
  total: TurnSummaryUsage | undefined,
  addition: TurnSummaryUsage | undefined,
): TurnSummaryUsage | undefined {
  if (addition === undefined) return total;
  return {
    input_tokens: (total?.input_tokens ?? 0) + (addition.input_tokens ?? 0),
    cached_input_tokens:
      (total?.cached_input_tokens ?? 0)
      + (addition.cached_input_tokens ?? 0),
    output_tokens:
      (total?.output_tokens ?? 0) + (addition.output_tokens ?? 0),
    reasoning_output_tokens:
      (total?.reasoning_output_tokens ?? 0)
      + (addition.reasoning_output_tokens ?? 0),
  };
}

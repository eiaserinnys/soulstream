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

const MARKER_PATTERN = /\[T(\d+)(?:-T(\d+))?\]/g;

export interface SessionStoryGenerator {
  generate(
    prompt: string,
    config: TurnSummaryConfig,
    options?: CodexExecGenerateOptions,
  ): Promise<TurnSummaryResult>;
}

export class SessionStoryFoldService {
  private readonly inFlight = new Set<string>();
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
    await this.runExclusive(sessionId, async (startedAt) => {
      const config = this.deps.configService.read();
      if (!config.enabled) return;
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
    await this.runExclusive(candidate.sessionId, async (startedAt) => {
      const config = this.deps.configService.read();
      if (!config.enabled) return;
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
    action: (startedAt: number) => Promise<void>,
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
    try {
      await action(startedAt);
    } catch (error) {
      this.deps.logger.warn(
        {
          sessionId,
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
    readonly conflictReason: string;
    readonly store: (value: StoreSessionStoryDigestInput) => Promise<boolean>;
  }): Promise<string | null> {
    const prompt = buildSessionStoryPrompt(
      input.config.storyInstruction,
      input.narrative,
      input.summaries,
    );
    const generated = await this.generateStructuredStory(
      prompt,
      input.config,
      input.sessionId,
    );
    if (generated === null) return null;
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
    const markerStats = markerOrderStats(generated.output.narrative);
    this.deps.logger.info?.(
      {
        sessionId: input.sessionId,
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
    const storyConfig = { ...config, model: config.storyModel };
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

export function markerOrderStats(narrative: string): {
  readonly markerCount: number;
  readonly inversionPairs: number;
} {
  const starts = [...narrative.matchAll(MARKER_PATTERN)]
    .map((match) => Number(match[1]));
  let inversionPairs = 0;
  for (let left = 0; left < starts.length; left += 1) {
    for (let right = left + 1; right < starts.length; right += 1) {
      if ((starts[left] ?? 0) > (starts[right] ?? 0)) inversionPairs += 1;
    }
  }
  return { markerCount: starts.length, inversionPairs };
}

function buildSessionStoryPrompt(
  instruction: string,
  existingNarrative: string | null,
  summaries: readonly SessionStoryTurnSummary[],
): string {
  const narrative = existingNarrative?.trim() || "(아직 접힌 줄거리 없음)";
  const turns = summaries
    .map((summary) => `[T${summary.turnNumber}] ${summary.content}`)
    .join("\n");
  return [
    instruction,
    "",
    "[기존 줄거리]",
    narrative,
    "",
    "[새 턴 요약]",
    turns,
  ].join("\n");
}

type SessionStoryOutput = {
  readonly narrative: string;
  readonly highlight: string;
};

function parseSessionStoryOutput(content: string): SessionStoryOutput {
  const value = JSON.parse(content) as unknown;
  if (!isRecord(value)) throw new Error("story output must be an object");
  const narrative = stringValue(value.narrative);
  const highlight = stringValue(value.highlight);
  if (narrative === null || highlight === null) {
    throw new Error("story output requires narrative and highlight strings");
  }
  if (markerOrderStats(narrative).markerCount === 0) {
    throw new Error("story narrative contains no parseable turn marker");
  }
  if (markerOrderStats(highlight).markerCount > 0) {
    throw new Error("story highlight must not contain turn markers");
  }
  return { narrative, highlight };
}

function observeOutputShape(
  output: SessionStoryOutput,
  config: TurnSummaryConfig,
  sessionId: string,
  logger: TurnSummaryLogger,
): void {
  const highlightSentenceCount = countSentences(output.highlight);
  const narrativeChars = Array.from(output.narrative).length;
  if (
    narrativeChars > config.storyNarrativeMaxChars ||
    highlightSentenceCount < 5 ||
    highlightSentenceCount > 6
  ) {
    logger.debug?.(
      {
        sessionId,
        narrativeChars,
        narrativeMaxChars: config.storyNarrativeMaxChars,
        highlightSentenceCount,
      },
      "Session story output exceeds advisory shape",
    );
  }
}

function countSentences(value: string): number {
  return value
    .split(/(?<=[.!?。！？])\s*/)
    .filter((sentence) => sentence.trim().length > 0)
    .length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
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

import type { SessionStoryTurnSummary } from "@soulstream/mcp-contract";
import type { TurnSummaryConfig, TurnSummaryLogger } from "./turn_summary_config.js";

const MARKER_PATTERN = /\[T(\d+)(?:-T(\d+))?\]/g;

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

export function buildSessionStoryPrompt(
  instruction: string,
  narrativeMaxChars: number,
  existingNarrative: string | null,
  summaries: readonly SessionStoryTurnSummary[],
): string {
  const narrative = existingNarrative?.trim() || "(아직 접힌 줄거리 없음)";
  const turns = summaries
    .map((summary) => `[T${summary.turnNumber}] ${summary.content}`)
    .join("\n");
  return [
    instruction,
    `narrative는 공백 포함 ${narrativeMaxChars}자 이내로 쓴다. 넘칠 것 같으면 오래된 턴을 더 줄여 쓴다.`,
    "",
    "[기존 줄거리]",
    narrative,
    "",
    "[새 턴 요약]",
    turns,
  ].join("\n");
}

export type SessionStoryOutput = {
  readonly narrative: string;
  readonly highlight: string;
};

export function parseSessionStoryOutput(content: string): SessionStoryOutput {
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

export function observeOutputShape(
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

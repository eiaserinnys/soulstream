import type {
  PersistentJevObservation,
  SSEEventDebug,
} from "../generated/typescript/index.js";

export type PersistentJevCandidatesDebugEvent = SSEEventDebug & {
  readonly kind: "persistent_jev_candidates";
  readonly observation: PersistentJevObservation;
};

const COUNT_LIMITS = {
  turn_summaries: 40,
  cards: 20,
  search_sessions: 15,
  recent_completed_sessions: 5,
} as const;

export function isPersistentJevCandidatesDebugEvent(
  value: unknown,
): value is PersistentJevCandidatesDebugEvent {
  if (!isRecord(value) || value.type !== "debug" || value.kind !== "persistent_jev_candidates") {
    return false;
  }
  // Consumers must compare observation.input_id with the input they sent.
  return isObservation(value.observation);
}

function isObservation(value: unknown): value is PersistentJevObservation {
  if (!hasRequiredKeys(value, ["input_id", "selected", "candidate_counts", "model", "latency_ms", "top_raw_score"])) {
    return false;
  }
  if (typeof value.input_id !== "string" || value.input_id.length === 0
    || value.model !== "jev-latest" || !isNonNegativeInteger(value.latency_ms)
    || !isRawScore(value.top_raw_score)
    || !isRecord(value.candidate_counts)
    || !hasRequiredKeys(value.candidate_counts, Object.keys(COUNT_LIMITS))
    || (Object.hasOwn(value, "unselected_top") && !isUnselectedTop(value.unselected_top))
    || (Object.hasOwn(value, "top_raw_scores") && !isTopRawScores(value.top_raw_scores))) {
    return false;
  }
  for (const [key, limit] of Object.entries(COUNT_LIMITS)) {
    const count = value.candidate_counts[key];
    if (!isNonNegativeInteger(count) || count > limit) return false;
  }
  return Array.isArray(value.selected)
    && value.selected.length <= 5
    && value.selected.every((candidate) => isSelectedCandidate(candidate)
      && isSelectedScore((candidate as Record<string, unknown>).score));
}

function isUnselectedTop(value: unknown): boolean {
  return Array.isArray(value)
    && value.length <= 5
    && value.every((candidate) => {
      if (!isRecord(candidate)
        || !hasRequiredKeys(candidate, ["kind", "label", "raw_score"])
        || !isNonEmptyText(candidate.label)
        || !isRawScore(candidate.raw_score)) return false;
      if (candidate.kind === "session") return isValidSources(candidate.sources);
      return candidate.kind === "turn_summary" || candidate.kind === "card";
    });
}

function isTopRawScores(value: unknown): boolean {
  if (!isRecord(value) || !hasRequiredKeys(value, Object.keys(COUNT_LIMITS))) return false;
  return Object.keys(COUNT_LIMITS).every((key) => value[key] === null || isRawScore(value[key]));
}

function isSelectedCandidate(value: unknown): boolean {
  if (!isRecord(value) || !isScore(value.score) || !isRawScore(value.raw_score) || value.raw_score < 2
    || !isBoundedText(value.label, 120) || !isBoundedText(value.line, 240)) {
    return false;
  }
  if (value.kind === "turn_summary") {
    return hasRequiredKeys(value, ["kind", "session_id", "summary_event_id", "turn_number", "label", "line", "score", "raw_score"])
      && isNonEmptyText(value.session_id)
      && isPositiveInteger(value.summary_event_id)
      && isPositiveInteger(value.turn_number)
      && isBoundedText(value.label, 32);
  }
  if (value.kind === "card") {
    return hasRequiredKeys(value, ["kind", "card_id", "label", "line", "score", "raw_score"])
      && isNonEmptyText(value.card_id)
      && (value.card_number === undefined || isPositiveInteger(value.card_number))
      && isBoundedText(value.label, 80);
  }
  if (value.kind === "session") {
    return hasRequiredKeys(value, ["kind", "session_id", "label", "line", "score", "raw_score"])
      && isNonEmptyText(value.session_id)
      && (value.sources === undefined || isValidSources(value.sources));
  }
  return false;
}

function isValidSources(value: unknown): boolean {
  return Array.isArray(value)
    && value.length >= 1
    && value.length <= 2
    && new Set(value).size === value.length
    && value.every((source) => source === "search" || source === "recent_completed");
}

function isScore(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0 && value <= 3;
}

function isSelectedScore(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 2 && value <= 3;
}

function isRawScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 3;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return isNonEmptyText(value) && value.length <= maxLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasRequiredKeys(
  value: unknown,
  required: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return required.every((key) => Object.hasOwn(value, key));
}

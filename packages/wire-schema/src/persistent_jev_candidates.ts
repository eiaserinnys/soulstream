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
  return isObservation(value.observation);
}

function isObservation(value: unknown): value is PersistentJevObservation {
  if (!hasExactKeys(value, ["input_id", "selected", "candidate_counts", "model", "latency_ms"])) {
    return false;
  }
  if (typeof value.input_id !== "string" || value.input_id.length === 0
    || value.model !== "jev-latest" || !isNonNegativeInteger(value.latency_ms)
    || !isRecord(value.candidate_counts)
    || !hasExactKeys(value.candidate_counts, Object.keys(COUNT_LIMITS))) {
    return false;
  }
  for (const [key, limit] of Object.entries(COUNT_LIMITS)) {
    const count = value.candidate_counts[key];
    if (!isNonNegativeInteger(count) || count > limit) return false;
  }
  return Array.isArray(value.selected)
    && value.selected.length <= 5
    && value.selected.every(isSelectedCandidate);
}

function isSelectedCandidate(value: unknown): boolean {
  if (!isRecord(value) || !isScore(value.score)
    || !isBoundedText(value.label, 120) || !isBoundedText(value.line, 240)) {
    return false;
  }
  if (value.kind === "turn_summary") {
    return hasExactKeys(value, ["kind", "session_id", "summary_event_id", "turn_number", "label", "line", "score"])
      && isNonEmptyText(value.session_id)
      && isPositiveInteger(value.summary_event_id)
      && isPositiveInteger(value.turn_number)
      && isBoundedText(value.label, 32);
  }
  if (value.kind === "card") {
    return hasExactKeys(value, ["kind", "card_id", "label", "line", "score"], ["card_number"])
      && isNonEmptyText(value.card_id)
      && (value.card_number === undefined || isPositiveInteger(value.card_number))
      && isBoundedText(value.label, 80);
  }
  if (value.kind === "session") {
    return hasExactKeys(value, ["kind", "session_id", "label", "line", "score"], ["sources"])
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

function hasExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

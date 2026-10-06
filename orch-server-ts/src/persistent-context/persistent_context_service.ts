import { scorePersistentCandidates, type RelevanceScore } from "../relevance/typesafe_client.js";
import type { CogitoSearchProvider } from "../cogito/cogito_routes.js";
import type {
  PersistentJevCardCandidate,
  PersistentJevObservation,
  PersistentJevSessionCandidate,
  PersistentJevTurnSummaryCandidate,
  PersistentJevUnselectedTopCard,
  PersistentJevUnselectedTopSession,
  PersistentJevUnselectedTopTurnSummary,
} from "@soulstream/wire-schema";
import type { PersistentContextCandidateRepositories } from "./persistent_context_candidates.js";
import type { PersistentContextEvaluationInput, PersistentContextEvaluationResult } from "./persistent_context_types.js";

const MAX_CANDIDATE_TEXT_BYTES = 240;
const MAX_REQUEST_BYTES = 1_000;
const MAX_SERIALIZED_STATE_BYTES = 50_000;
const MAX_REQUEST_BODY_BYTES = 100_000;

type Selected = PersistentJevObservation["selected"][number];
export type PersistentContextNullReason =
  | "not_persistent"
  | "cancelled_or_deadline"
  | "search_incomplete"
  | "no_candidates"
  | "jev_limits_exceeded"
  | "budget_exhausted"
  | "jev_failed"
  | "score_count_mismatch"
  | "unexpected_error";
type CandidateSelection =
  | Pick<PersistentJevTurnSummaryCandidate, "kind" | "session_id" | "summary_event_id" | "turn_number">
  | Pick<PersistentJevCardCandidate, "kind" | "card_id" | "card_number">
  | Pick<PersistentJevSessionCandidate, "kind" | "session_id" | "sources">;
type Candidate = {
  readonly key: string;
  readonly text: string;
  readonly selected: CandidateSelection;
  readonly label: string;
  readonly line: string;
  readonly order: number;
};

export type PersistentContextService = {
  readonly evaluatePersistentCandidates: (
    input: PersistentContextEvaluationInput,
  ) => Promise<PersistentContextEvaluationResult>;
};

export function createPersistentContextService(options: {
  readonly candidates: PersistentContextCandidateRepositories;
  readonly searchProvider: CogitoSearchProvider;
  readonly typesafeApiKey: string;
  readonly logMissingInput: (sessionId: string, elapsedMs: number) => void;
  readonly logNullReason: (reason: PersistentContextNullReason, sessionId: string, elapsedMs: number) => void;
  readonly fetchImpl?: typeof fetch;
}): PersistentContextService {
  return {
    async evaluatePersistentCandidates(input) {
      const startedAt = Date.now();
      const logNull = (reason: PersistentContextNullReason) => options.logNullReason(
        reason,
        input.sessionId,
        Math.max(0, Date.now() - startedAt),
      );
      try {
        if (!mayContinue(input)) {
          logNull("cancelled_or_deadline");
          return { observation: null };
        }
        const raw = await options.candidates.readSessionAndBoundedCandidates(
          input.sessionId,
          input.inputId,
          input.signal,
          input.deadlineAt,
        );
        if (!mayContinue(input)) {
          logNull("cancelled_or_deadline");
          return { observation: null };
        }
        if (raw.inputEventId === null) {
          options.logMissingInput(input.sessionId, Math.max(0, Date.now() - startedAt));
          return { observation: null };
        }
        if (!raw.sessionIsPersistent) {
          logNull("not_persistent");
          return { observation: null };
        }

        const summaryCounts = await options.candidates.storyReads.countTurnSummaries(
          input.sessionId,
          { beforeEventId: raw.inputEventId, signal: input.signal, deadlineAt: input.deadlineAt },
        );
        const fromTurnNumber = Math.max(1, summaryCounts.totalCount - 39);
        const turnSummaries = await options.candidates.storyReads.loadTurnSummaryRange(
          input.sessionId,
          fromTurnNumber,
          null,
          40,
          { beforeEventId: raw.inputEventId, signal: input.signal, deadlineAt: input.deadlineAt },
        );
        if (!mayContinue(input)) {
          logNull("cancelled_or_deadline");
          return { observation: null };
        }

        const request = clipUtf8(input.request, MAX_REQUEST_BYTES);
        const searched = await options.searchProvider.search({
          q: request,
          top_k: 16,
          search_session_id: true,
          include_turn_summaries: false,
          include_highlight: false,
          include_story: false,
          include_session_results: true,
          session_search_mode: "expanded",
          allowedFolderIds: raw.allowedFolderIds,
          exclude_session_request_excerpt: true,
          signal: input.signal,
          deadlineAt: input.deadlineAt,
        });
        if (!mayContinue(input)) {
          logNull("cancelled_or_deadline");
          return { observation: null };
        }
        if (searched.search_status?.session_sources?.metadata.status !== "complete") {
          logNull("search_incomplete");
          return { observation: null };
        }
        const sessionSearchCandidates = uniqueSessionCandidates(
          (searched.session_results ?? []).filter((session) => {
            const folderId = stringField(session, "folder_id", "folderId");
            return folderId !== null && raw.allowedFolderIds.includes(folderId);
          }),
          input.sessionId,
        ).slice(0, 15);
        const recentCompleted = raw.recentCompletedSessions.slice(0, 5);
        const candidates = buildCandidates({
          sessionId: input.sessionId,
          turnSummaries,
          cards: raw.cards.slice(0, 20),
          searchedSessions: sessionSearchCandidates,
          recentCompleted,
        });
        if (candidates.length === 0) {
          logNull("no_candidates");
          return { observation: null };
        }
        if (!mayContinue(input)) {
          logNull("cancelled_or_deadline");
          return { observation: null };
        }

        const items = candidates.map(({ key, text }) => ({ key, text }));
        if (!fitsJevLimits(request, items)) {
          logNull("jev_limits_exceeded");
          return { observation: null };
        }
        const remainingBudgetMs = Math.floor(input.deadlineAt - Date.now());
        if (remainingBudgetMs <= 0) {
          logNull("budget_exhausted");
          return { observation: null };
        }
        if (!mayContinue(input)) {
          logNull("cancelled_or_deadline");
          return { observation: null };
        }
        let scores: RelevanceScore[];
        try {
          scores = await scorePersistentCandidates({
            query: request,
            items,
            apiKey: options.typesafeApiKey,
            budgetMs: Math.min(3_000, remainingBudgetMs),
            signal: input.signal,
            fetchImpl: options.fetchImpl,
          });
        } catch {
          logNull(mayContinue(input) ? "jev_failed" : "cancelled_or_deadline");
          return { observation: null };
        }
        if (!mayContinue(input)) {
          logNull("cancelled_or_deadline");
          return { observation: null };
        }
        if (scores.length !== candidates.length) {
          logNull("score_count_mismatch");
          return { observation: null };
        }

        const scoreByKey = new Map(scores.map(({ key, score }) => [key, score]));
        const topRawScore = Math.max(...scores.map(({ score }) => score));
        const scoredCandidates = candidates
          .map((candidate) => ({ candidate, score: scoreByKey.get(candidate.key) }))
          .filter((entry): entry is { candidate: Candidate; score: number } => entry.score !== undefined);
        const selectedCandidates = scoredCandidates
          .filter(({ score }) => score >= 2)
          .sort((left, right) => right.score - left.score || left.candidate.order - right.candidate.order)
          .slice(0, 5);
        const selected = selectedCandidates.map(({ candidate, score }) => ({
          ...candidate.selected,
          label: candidate.label,
          line: candidate.line,
          score: Math.round(score),
          raw_score: score,
        }) as Selected);
        const selectedKeys = new Set(selectedCandidates.map(({ candidate }) => candidate.key));
        const unselectedTop = scoredCandidates
          .filter(({ candidate }) => !selectedKeys.has(candidate.key))
          .sort((left, right) => right.score - left.score || left.candidate.order - right.candidate.order)
          .slice(0, 5)
          .map(({ candidate, score }) => {
            const entry = { kind: candidate.selected.kind, label: candidate.label, raw_score: score };
            return candidate.selected.kind === "session"
              ? { ...entry, sources: candidate.selected.sources! }
              : entry;
          }) as unknown as Array<
            PersistentJevUnselectedTopTurnSummary | PersistentJevUnselectedTopCard | PersistentJevUnselectedTopSession
          >;
        const highestScore = (matches: (candidate: Candidate) => boolean): number | null => {
          const matchingScores = scoredCandidates
            .filter(({ candidate }) => matches(candidate))
            .map(({ score }) => score);
          return matchingScores.length === 0 ? null : Math.max(...matchingScores);
        };
        const observation: PersistentJevObservation = {
          input_id: input.inputId,
          selected: selected as unknown as PersistentJevObservation["selected"],
          candidate_counts: {
            turn_summaries: candidates.filter(({ selected: candidate }) => candidate.kind === "turn_summary").length,
            cards: candidates.filter(({ selected: candidate }) => candidate.kind === "card").length,
            search_sessions: candidates.filter(({ selected: candidate }) => candidate.kind === "session"
              && candidate.sources?.includes("search")).length,
            recent_completed_sessions: candidates.filter(({ selected: candidate }) => candidate.kind === "session"
              && candidate.sources?.includes("recent_completed")).length,
          },
          model: "jev-latest",
          latency_ms: Math.max(0, Date.now() - startedAt),
          top_raw_score: topRawScore,
          unselected_top: unselectedTop as unknown as PersistentJevObservation["unselected_top"],
          top_raw_scores: {
            turn_summaries: highestScore(({ selected: candidate }) => candidate.kind === "turn_summary"),
            cards: highestScore(({ selected: candidate }) => candidate.kind === "card"),
            search_sessions: highestScore(({ selected: candidate }) => candidate.kind === "session"
              && candidate.sources?.includes("search") === true),
            recent_completed_sessions: highestScore(({ selected: candidate }) => candidate.kind === "session"
              && candidate.sources?.includes("recent_completed") === true),
          },
        };
        if (!mayContinue(input)) {
          logNull("cancelled_or_deadline");
          return { observation: null };
        }
        return { observation };
      } catch {
        logNull(mayContinue(input) ? "unexpected_error" : "cancelled_or_deadline");
        return { observation: null };
      }
    },
  };
}

function buildCandidates(input: {
  sessionId: string;
  turnSummaries: readonly { eventId: number; turnNumber: number; content: string }[];
  cards: readonly { id: string; number: number | null; title: string; request: string; brief: string }[];
  searchedSessions: readonly Record<string, unknown>[];
  recentCompleted: readonly { sessionId: string; title: string; lastAssistantText: string }[];
}): Candidate[] {
  const candidates: Candidate[] = [];
  const sessions = new Map<string, { label: string; line: string; fallbackLine: string; sources: Array<"search" | "recent_completed"> }>();
  const add = (key: string, label: string, line: string, selected: CandidateSelection, fallbackLine = "") => {
    const cleanedLine = cleanCandidateLine(line);
    const cleanedFallback = cleanCandidateLine(fallbackLine);
    const cleanLine = cleanedLine || cleanedFallback;
    if (!cleanLine) return;
    const boundedLine = clipUtf8(cleanLine, MAX_CANDIDATE_TEXT_BYTES);
    const text = clipUtf8(`${label} — ${boundedLine}`, MAX_CANDIDATE_TEXT_BYTES);
    candidates.push({ key, text, selected, label, line: boundedLine, order: candidates.length });
  };

  input.turnSummaries.slice(-40).forEach((summary, index) => {
    const label = `T${summary.turnNumber}`;
    add(`turn-${index}`, label, summary.content, {
      kind: "turn_summary",
      session_id: input.sessionId,
      summary_event_id: summary.eventId,
      turn_number: summary.turnNumber,
    });
  });
  input.cards.slice(0, 20).forEach((card, index) => {
    const label = card.number === null ? clipUtf8(card.title, 80) : `#${card.number}`;
    const line = [card.title, card.request, card.brief]
      .map(cleanCandidateLine)
      .filter(Boolean)
      .join(" — ");
    add(`card-${index}`, label, line, {
      kind: "card",
      card_id: card.id,
      ...(card.number === null ? {} : { card_number: card.number }),
    }, card.title);
  });
  input.searchedSessions.forEach((session) => {
    const sessionId = stringField(session, "session_id", "sessionId");
    if (!sessionId || sessionId === input.sessionId) return;
    const title = stringField(session, "title", "display_name") ?? "이전 세션";
    sessions.set(sessionId, {
      label: clipUtf8(title, 120),
      line: stringField(session, "excerpt") ?? title,
      fallbackLine: title,
      sources: ["search"],
    });
  });
  for (const completed of input.recentCompleted) {
    if (!completed.sessionId || completed.sessionId === input.sessionId) continue;
    const current = sessions.get(completed.sessionId);
    if (current) {
      if (!current.sources.includes("recent_completed")) current.sources.push("recent_completed");
      continue;
    }
    sessions.set(completed.sessionId, {
      label: clipUtf8(completed.title || "이전 세션", 120),
      line: completed.lastAssistantText || completed.title,
      fallbackLine: completed.title,
      sources: ["recent_completed"],
    });
  }
  let sessionIndex = 0;
  for (const [sessionId, value] of sessions) {
    add(`session-${sessionIndex++}`, value.label, value.line, {
      kind: "session",
      session_id: sessionId,
      sources: value.sources as ["search" | "recent_completed"]
        | ["search" | "recent_completed", "search" | "recent_completed"],
    }, value.fallbackLine);
  }
  return candidates;
}

function uniqueSessionCandidates(
  values: readonly Record<string, unknown>[],
  currentSessionId: string,
): Record<string, unknown>[] {
  const seen = new Set([currentSessionId]);
  const result: Record<string, unknown>[] = [];
  for (const value of values) {
    const sessionId = stringField(value, "session_id", "sessionId");
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    result.push(value);
  }
  return result;
}

function fitsJevLimits(query: string, items: readonly { key: string; text: string }[]): boolean {
  const state = { request: query, candidates: items };
  const questions = Object.fromEntries(items.map(({ key, text }) => [key, {
    type: "score",
    instructions: `request 처리에 대한 아래 후보의 유관도.\n후보: ${text}`,
    criteria: [
      "무관 — 이 요청과 관계없다",
      "참고 — 있으면 약간 도움",
      "유관 — 처리 과정에 실제로 쓰인다",
      "필수 — 없으면 요청 처리가 틀리거나 누락된다",
    ],
  }]));
  const stateJson = JSON.stringify(state);
  const body = JSON.stringify({ model: "jev-latest", state, questions });
  return byteLength(stateJson) <= MAX_SERIALIZED_STATE_BYTES
    && byteLength(body) <= MAX_REQUEST_BODY_BYTES;
}

function mayContinue(input: PersistentContextEvaluationInput): boolean {
  return !input.signal.aborted && Date.now() < input.deadlineAt;
}

function clipUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let bytes = encoder.encode(value.trim());
  if (bytes.length <= maxBytes) return decoder.decode(bytes);
  bytes = bytes.subarray(0, maxBytes);
  return decoder.decode(bytes, { stream: false }).replace(/\uFFFD$/u, "").trim();
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function cleanCandidateLine(value: string): string {
  return value
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const found = value[key];
    if (typeof found === "string" && found.trim()) return found.trim();
  }
  return null;
}

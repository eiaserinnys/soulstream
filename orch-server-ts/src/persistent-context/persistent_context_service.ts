import { scorePersistentCandidates } from "../relevance/typesafe_client.js";
import type { CogitoSearchProvider } from "../cogito/cogito_routes.js";
import type {
  PersistentJevCardCandidate,
  PersistentJevObservation,
  PersistentJevSessionCandidate,
  PersistentJevTurnSummaryCandidate,
} from "@soulstream/wire-schema";
import type { PersistentContextCandidateRepositories } from "./persistent_context_candidates.js";
import type { PersistentContextEvaluationInput, PersistentContextEvaluationResult } from "./persistent_context_types.js";

const MAX_CANDIDATE_TEXT_BYTES = 240;
const MAX_REQUEST_BYTES = 1_000;
const MAX_SERIALIZED_STATE_BYTES = 50_000;
const MAX_REQUEST_BODY_BYTES = 100_000;

type Selected = PersistentJevObservation["selected"][number];
type CandidateSelection =
  | Omit<PersistentJevTurnSummaryCandidate, "score" | "label" | "line">
  | Omit<PersistentJevCardCandidate, "score" | "label" | "line">
  | Omit<PersistentJevSessionCandidate, "score" | "label" | "line">;
type Candidate = {
  readonly key: string;
  readonly text: string;
  readonly selected: CandidateSelection;
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
  readonly logMissingInput: (sessionId: string) => void;
  readonly fetchImpl?: typeof fetch;
}): PersistentContextService {
  return {
    async evaluatePersistentCandidates(input) {
      const startedAt = Date.now();
      try {
        if (!mayContinue(input)) return { observation: null };
        const raw = await options.candidates.readSessionAndBoundedCandidates(
          input.sessionId,
          input.inputId,
          input.signal,
          input.deadlineAt,
        );
        if (!mayContinue(input)) return { observation: null };
        if (raw.inputEventId === null) {
          options.logMissingInput(input.sessionId);
          return { observation: null };
        }
        if (!raw.sessionIsPersistent) return { observation: null };

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
        if (!mayContinue(input)) return { observation: null };

        const request = clipUtf8(input.request, MAX_REQUEST_BYTES);
        const searched = await options.searchProvider.search({
          q: request,
          top_k: 4,
          search_session_id: false,
          include_turn_summaries: false,
          include_highlight: false,
          include_story: false,
          include_session_results: true,
          session_search_mode: "lexical",
          allowedFolderIds: raw.allowedFolderIds,
          signal: input.signal,
          deadlineAt: input.deadlineAt,
        });
        if (!mayContinue(input) || searched.search_status?.session_sources?.metadata.status !== "complete") {
          return { observation: null };
        }
        const sessionSearchCandidates = uniqueSessionCandidates(
          searched.session_results ?? [],
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
        if (candidates.length === 0 || !mayContinue(input)) return { observation: null };

        const items = candidates.map(({ key, text }) => ({ key, text }));
        if (!fitsJevLimits(request, items)) return { observation: null };
        const remainingBudgetMs = Math.floor(input.deadlineAt - Date.now());
        if (remainingBudgetMs <= 0 || !mayContinue(input)) return { observation: null };
        const scores = await scorePersistentCandidates({
          query: request,
          items,
          apiKey: options.typesafeApiKey,
          budgetMs: Math.min(3_000, remainingBudgetMs),
          signal: input.signal,
          fetchImpl: options.fetchImpl,
        });
        if (!mayContinue(input) || scores.length !== candidates.length) return { observation: null };

        const scoreByKey = new Map(scores.map(({ key, score }) => [key, score]));
        const selected = candidates
          .map((candidate) => ({ candidate, score: scoreByKey.get(candidate.key) }))
          .filter((entry): entry is { candidate: Candidate; score: number } =>
            entry.score !== undefined && entry.score >= 2)
          .sort((left, right) => right.score - left.score || left.candidate.order - right.candidate.order)
          .slice(0, 5)
          .map(({ candidate, score }) => ({ ...candidate.selected, score }) as Selected);
        const observation: PersistentJevObservation = {
          input_id: input.inputId,
          selected: selected as unknown as PersistentJevObservation["selected"],
          candidate_counts: {
            turn_summaries: turnSummaries.length,
            cards: Math.min(20, raw.cards.length),
            search_sessions: sessionSearchCandidates.length,
            recent_completed_sessions: recentCompleted.length,
          },
          model: "jev-latest",
          latency_ms: Math.max(0, Date.now() - startedAt),
        };
        return mayContinue(input) ? { observation } : { observation: null };
      } catch {
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
  recentCompleted: readonly { sessionId: string; title: string; firstRequest: string }[];
}): Candidate[] {
  const candidates: Candidate[] = [];
  const sessions = new Map<string, { label: string; line: string; sources: Array<"search" | "recent_completed"> }>();
  const add = (key: string, label: string, line: string, selected: CandidateSelection) => {
    const boundedLine = clipUtf8(line, MAX_CANDIDATE_TEXT_BYTES);
    const text = clipUtf8(`${label} — ${boundedLine}`, MAX_CANDIDATE_TEXT_BYTES);
    candidates.push({ key, text, selected: { ...selected, label, line: boundedLine } as unknown as CandidateSelection, order: candidates.length });
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
    add(`card-${index}`, label, [card.title, card.request, card.brief].filter(Boolean).join(" — "), {
      kind: "card",
      card_id: card.id,
      ...(card.number === null ? {} : { card_number: card.number }),
    });
  });
  input.searchedSessions.forEach((session) => {
    const sessionId = stringField(session, "session_id", "sessionId");
    if (!sessionId || sessionId === input.sessionId) return;
    const title = stringField(session, "title", "display_name") ?? "이전 세션";
    sessions.set(sessionId, {
      label: clipUtf8(title, 120),
      line: stringField(session, "excerpt", "first_request", "firstRequest") ?? title,
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
      line: completed.firstRequest || completed.title,
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
    });
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

function stringField(value: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const found = value[key];
    if (typeof found === "string" && found.trim()) return found.trim();
  }
  return null;
}

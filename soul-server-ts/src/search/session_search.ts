import type { SessionDB } from "../db/session_db.js";
import {
  DEFAULT_SEARCH_CATEGORIES,
  buildSearchPreview,
  eventTypesForSearchCategories,
} from "@soulstream/search-contract";

export const DEFAULT_READABLE_SEARCH_EVENT_TYPES =
  eventTypesForSearchCategories(DEFAULT_SEARCH_CATEGORIES);

type SearchDb = Pick<
  SessionDB,
  "searchSessionHistory"
>;

const SESSION_HISTORY_SEARCH_DEADLINE_MS = 4_500;

interface SearchMatch {
  id: number;
  session_id: string;
  event_type: string;
  searchable_text: string;
  score: number;
  match_source: SearchMatchSource;
}

export type SearchMatchSource =
  | "message"
  | "turn_summary"
  | "highlight"
  | "story";

export interface SearchSessionEventsParams {
  query: string;
  sessionIds?: string[] | null;
  eventTypes?: string[] | null;
  searchSessionId?: boolean;
  includeTurnSummaries?: boolean;
  includeHighlight?: boolean;
  includeStory?: boolean;
  limit?: number;
  signal?: AbortSignal;
}

export class SessionHistorySearchDeadlineError extends Error {
  readonly statusCode = 504;

  constructor() {
    super("session history search exceeded its request deadline");
    this.name = "SessionHistorySearchDeadlineError";
  }
}

export interface SearchResultItem {
  session_id: string;
  event_id: number;
  score: number;
  preview: string;
  event_type: string;
  match_source: SearchMatchSource;
}

export async function searchSessionEvents(
  db: SearchDb,
  params: SearchSessionEventsParams,
): Promise<SearchResultItem[]> {
  const controller = new AbortController();
  const parentSignal = params.signal;
  let deadlineExpired = false;
  const onParentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const deadlineTimer = setTimeout(() => {
    deadlineExpired = true;
    controller.abort(new SessionHistorySearchDeadlineError());
  }, SESSION_HISTORY_SEARCH_DEADLINE_MS);
  const signal = controller.signal;
  const checkSearchActive = () => {
    if (signal.aborted) {
      if (deadlineExpired) throw new SessionHistorySearchDeadlineError();
      throw signal.reason instanceof Error ? signal.reason : new Error("session history search was cancelled");
    }
  };
  const query = params.query;
  const limit = params.limit ?? 10;
  const types = resolveSearchEventTypes(
    params.eventTypes,
    params.includeTurnSummaries ?? false,
  );
  const matches: SearchMatch[] = [];
  const seen = new Set<string>();

  try {
    checkSearchActive();
    const results = await db.searchSessionHistory({
      query,
      sessionIds: params.sessionIds ?? null,
      limit,
      eventTypes: types,
      searchSessionId: params.searchSessionId ?? false,
      includeHighlight: params.includeHighlight ?? false,
      includeStory: params.includeStory ?? false,
    }, signal);
    checkSearchActive();

    for (const match of results.events) {
      addReadableMatch(matches, seen, {
        ...match,
        match_source: match.event_type === "turn_summary"
          ? "turn_summary"
          : "message",
      }, types);
    }

    for (const match of results.sessionIdEvents) {
      addReadableMatch(matches, seen, {
        ...match,
        match_source: match.event_type === "turn_summary"
          ? "turn_summary"
          : "message",
      }, types);
    }

    for (const match of results.digests) {
      addReadableMatch(matches, seen, match, [
        "session_highlight",
        "session_story",
      ]);
    }
  } catch (error) {
    if (deadlineExpired) throw new SessionHistorySearchDeadlineError();
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, limit).map((m) => ({
    session_id: m.session_id,
    event_id: m.id,
    score: m.score,
    preview: buildSearchPreview(m.searchable_text, query),
    event_type: m.event_type,
    match_source: m.match_source,
  }));
}

export function resolveSearchEventTypes(
  eventTypes?: string[] | null,
  includeTurnSummaries = false,
): string[] {
  const resolved = eventTypes === undefined || eventTypes === null
    ? [...DEFAULT_READABLE_SEARCH_EVENT_TYPES]
    : [...eventTypes];
  if (includeTurnSummaries && !resolved.includes("turn_summary")) {
    resolved.push("turn_summary");
  }
  return resolved;
}

function addReadableMatch(
  matches: SearchMatch[],
  seen: Set<string>,
  match: SearchMatch,
  eventTypes: string[],
): void {
  if (!isReadableSearchMatch(match, eventTypes)) return;
  const key = `${match.session_id}:${match.id}:${match.match_source}`;
  if (seen.has(key)) return;
  seen.add(key);
  matches.push(match);
}

function isReadableSearchMatch(
  match: { event_type: string; searchable_text: string },
  eventTypes: string[],
): boolean {
  return eventTypes.includes(match.event_type) && match.searchable_text.trim().length > 0;
}

export function buildPreview(text: string, query: string): string {
  return buildSearchPreview(text, query);
}

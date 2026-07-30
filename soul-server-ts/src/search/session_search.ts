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
  "searchEvents" | "searchEventsBySessionId" | "searchSessionDigests"
>;

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
  const query = params.query;
  const limit = params.limit ?? 10;
  const types = resolveSearchEventTypes(
    params.eventTypes,
    params.includeTurnSummaries ?? false,
  );
  const matches: SearchMatch[] = [];
  const seen = new Set<string>();

  for (const match of await db.searchEvents(
    query,
    params.sessionIds ?? null,
    limit,
    types,
  )) {
    addReadableMatch(matches, seen, {
      ...match,
      match_source: match.event_type === "turn_summary"
        ? "turn_summary"
        : "message",
    }, types);
  }

  if (params.searchSessionId) {
    for (const match of await db.searchEventsBySessionId(query, types, limit)) {
      addReadableMatch(matches, seen, {
        ...match,
        match_source: match.event_type === "turn_summary"
          ? "turn_summary"
          : "message",
      }, types);
    }
  }

  if (params.includeHighlight || params.includeStory) {
    for (const match of await db.searchSessionDigests(
      query,
      params.sessionIds ?? null,
      limit,
      params.includeHighlight ?? false,
      params.includeStory ?? false,
    )) {
      addReadableMatch(matches, seen, match, [
        "session_highlight",
        "session_story",
      ]);
    }
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

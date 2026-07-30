import type { SessionDB } from "../db/session_db.js";
import {
  DEFAULT_SEARCH_CATEGORIES,
  buildSearchPreview,
  eventTypesForSearchCategories,
} from "@soulstream/search-contract";

export const DEFAULT_READABLE_SEARCH_EVENT_TYPES =
  eventTypesForSearchCategories(DEFAULT_SEARCH_CATEGORIES);

type SearchDb = Pick<SessionDB, "searchEvents" | "searchEventsBySessionId">;

interface SearchMatch {
  id: number;
  session_id: string;
  event_type: string;
  searchable_text: string;
  score: number;
}

export interface SearchSessionEventsParams {
  query: string;
  sessionIds?: string[] | null;
  eventTypes?: string[] | null;
  searchSessionId?: boolean;
  limit?: number;
}

export interface SearchResultItem {
  session_id: string;
  event_id: number;
  score: number;
  preview: string;
  event_type: string;
}

export async function searchSessionEvents(
  db: SearchDb,
  params: SearchSessionEventsParams,
): Promise<SearchResultItem[]> {
  const query = params.query;
  const limit = params.limit ?? 10;
  const types = resolveSearchEventTypes(params.eventTypes);
  const matches: SearchMatch[] = [];
  const seen = new Set<string>();

  for (const match of await db.searchEvents(
    query,
    params.sessionIds ?? null,
    limit,
    types,
  )) {
    addReadableMatch(matches, seen, match, types);
  }

  if (params.searchSessionId) {
    for (const match of await db.searchEventsBySessionId(query, types, limit)) {
      addReadableMatch(matches, seen, match, types);
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, limit).map((m) => ({
    session_id: m.session_id,
    event_id: m.id,
    score: m.score,
    preview: buildSearchPreview(m.searchable_text, query),
    event_type: m.event_type,
  }));
}

export function resolveSearchEventTypes(eventTypes?: string[] | null): string[] {
  return eventTypes === undefined || eventTypes === null
    ? [...DEFAULT_READABLE_SEARCH_EVENT_TYPES]
    : eventTypes;
}

function addReadableMatch(
  matches: SearchMatch[],
  seen: Set<string>,
  match: SearchMatch,
  eventTypes: string[],
): void {
  if (!isReadableSearchMatch(match, eventTypes)) return;
  const key = `${match.session_id}:${match.id}`;
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

import type { SessionDigestSearchMatch } from "./session_story.js";

export interface SessionEventRow {
  id: number;
  session_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  searchable_text: string;
  created_at: Date;
}

export interface SessionEventDetailRow extends SessionEventRow {
  parent_event_id: number | null;
}

export interface SessionEventSearchRow extends SessionEventRow {
  score: number;
}

export interface SessionHistorySearchParams {
  query: string;
  sessionIds: string[] | null;
  limit: number;
  eventTypes: string[] | null;
  searchSessionId: boolean;
  includeHighlight: boolean;
  includeStory: boolean;
}

export interface SessionHistorySearchResult {
  events: SessionEventSearchRow[];
  sessionIdEvents: SessionEventSearchRow[];
  digests: SessionDigestSearchMatch[];
}

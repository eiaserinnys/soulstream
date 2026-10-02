import { executeFolderHostOperation, type FolderControlPlaneHostRouteOptions } from "../folders/folder_control_plane_host_route.js";
import { describeFolderOperationError } from "../folders/folder_workspace_routes.js";
import type { searchSessionEvents } from "@soulstream/search-contract";
import type { SessionStoryView } from "@soulstream/mcp-contract";
import type { PersistenceHostRepositories } from "../control_plane/persistence_host_runtime.js";

type SessionHistorySearchResult = Awaited<ReturnType<Parameters<typeof searchSessionEvents>[0]["searchSessionHistory"]>>;

export interface McpSessionRow {
  session_id: string;
  display_name: string | null;
  status: string;
  session_type: string;
  created_at: Date;
  updated_at: Date;
  event_count: number;
  caller_session_id: string | null;
  last_event_id: number | null;
  away_summary: string | null;
  agent_id: string | null;
  node_id: string;
  folder_id: string | null;
}

/** Preserves the old host JSON roundtrip (notably undefined fields and date revival). */
export function sessionHostValue<T>(value: unknown): T {
  return revive(JSON.parse(JSON.stringify(value ?? null))) as T;
}
function revive(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map(child => revive(child));
  if (typeof value === "string" && key !== "daily_date" && /(?:_at|At|_before|Before|_expires_at)$/.test(key ?? "")) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : value;
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, revive(child, key)]));
}
async function read<T>(operation: string, invoke: () => Promise<T>): Promise<T> {
  try { return sessionHostValue<T>(await invoke()); }
  catch { throw new Error(`session-data host ${operation} failed`); }
}

/** Direct repository calls keep the worker read client's public projections and errors. */
export function sessionReadAdapter(repositories: PersistenceHostRepositories) {
  const { sessionReads, eventReads, storyReads, historySearch, sessionReadComposites } = repositories;
  return {
    getSession: (id: string) => read("get", async () => await sessionReads.getSession(id) as unknown as McpSessionRow | null),
    listSessionsSummary: (params: Parameters<typeof sessionReads.listSessionsSummary>[0]) => read("list_summary", async () =>
      await sessionReads.listSessionsSummary(params) as unknown as { sessions: McpSessionRow[]; total: number }),
    readEvents: (...args: Parameters<typeof eventReads.readEvents>) => read("event_read_page", () => eventReads.readEvents(...args)),
    countEvents: (id: string) => read("event_count", () => eventReads.countEvents(id)),
    readOneEvent: (id: string, eventId: number) => read("event_read_one", () => eventReads.readOneEvent(id, eventId)),
    getSessionStory: (id: string) => read("story", async () => await storyReads.getSessionStory(id) as SessionStoryView),
    getSessionSearchMetadata: async (ids: string[]) => new Map(await read("story_search_metadata", () => storyReads.getSessionSearchMetadata(ids))),
    countTurnSummaries: (id: string) => read("turn_summary_count", () => storyReads.countTurnSummaries(id)),
    loadTurnSummaryRange: (...args: Parameters<typeof storyReads.loadTurnSummaryRange>) => read("turn_summary_range", () => storyReads.loadTurnSummaryRange(...args)),
    searchSessionHistory: (...args: Parameters<typeof historySearch.search>): Promise<SessionHistorySearchResult> => read("history_search", async () => await historySearch.search(...args) as unknown as SessionHistorySearchResult),
    getTurnExcerpt: (id: string, max: number) => read("turn_excerpt", () => sessionReadComposites.getTurnExcerpt(id, max)),
  };
}
export type McpSessionReadAdapter = ReturnType<typeof sessionReadAdapter>;

/** The list-by-folder-name path retains the legacy folder host error envelope. */
export async function readSessionFolders(options: FolderControlPlaneHostRouteOptions) {
  try {
    return sessionHostValue<{ id: string; name: string }[]>(await executeFolderHostOperation(options, "get_all", {}));
  } catch (error) {
    const failure = describeFolderOperationError(error);
    throw new Error(`folder host get_all failed: ${failure.message}`);
  }
}

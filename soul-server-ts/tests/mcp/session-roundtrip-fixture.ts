import { createHash } from "node:crypto";
import { TaskOwnedByAnotherNodeError } from "../../src/task/task_hydration_errors.js";
import { FolderHostClient } from "../../src/folder/folder_host_client.js";
import { registerFolderControlPlaneHostRoute } from "../../../orch-server-ts/src/folders/folder_control_plane_host_route.js";
import Fastify from "fastify";
import { vi } from "vitest";
import { registerPersistenceHostRoutes } from "../../../orch-server-ts/src/control_plane/persistence_host_routes.js";
import type { PersistenceHostRepositories } from "../../../orch-server-ts/src/control_plane/persistence_host_runtime.js";
import { registerMcpHostRoutes } from "../../../orch-server-ts/src/mcp/mcp_host_routes.js";
import { registerCogitoRoutes } from "../../../orch-server-ts/src/cogito/cogito_routes.js";
import { SessionDataHostClient } from "../../src/control_plane/session_data_host_client.js";
import { SessionMutationHostClient, SessionDeliveryHostClient } from "../../src/control_plane/persistence_host_clients.js";
import { ChildCompletionConsumptionRecorder } from "../../src/task/child_completion_consumption.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import type { McpHostOptions } from "../../../orch-server-ts/src/mcp/types.js";

// Reuses the real Fastify host + HTTP client pattern from folder/card roundtrip.
// Repository ports are deterministic doubles, as in control-plane-host-routes.test.ts;
// no SQL or production database is used by this boundary comparison.
export async function createSessionRoundtripFixture() {
  const app = Fastify();
  const at = new Date("2026-10-01T00:00:00Z");
  let revisionMismatch = false;
  let failure: string | undefined;
  let partial = false;
  let storyMode = "story";
  let sessions: Record<string, any> = {};
  let observations: any[] = [];
  const notifications: unknown[] = [];
  const paths: string[] = [];
  const renameKeys: string[] = [];
  const events = [
    { id: 1, event_type: "user_message", payload: { text: "needle 사용자" }, searchable_text: "needle 사용자" },
    { id: 2, event_type: "tool_use", payload: { input: "아주 긴 도구 입력" }, searchable_text: "needle 도구" },
    { id: 3, event_type: "tool_result", payload: { output: "아주 긴 도구 결과" }, searchable_text: "needle 도구" },
    { id: 4, event_type: "assistant_message", payload: { text: "needle 완료" }, searchable_text: "needle 완료" },
  ].map(e => ({ ...e, session_id: "child", created_at: at, parent_event_id: null }));
  const summaries = [1, 2, 3].map(n => ({ eventId: n === 3 ? 4 : n, turnNumber: n,
    content: `요약 ${n}`, turnStartEventId: 1, finalResponseEventId: 4, createdAt: at }));
  const fail = (operation: string) => { if (failure === operation) throw new Error("repository unavailable"); };
  const repositories = {
    sessionReads: {
      getSession: async (id: string) => { fail("get"); return sessions[id] ?? null; },
      listSessionsSummary: async (p: any) => {
        fail("list_summary");
        const rows = Object.values(sessions).filter(s => (!p.folderId || s.folder_id === p.folderId)
          && (!p.nodeId || s.node_id === p.nodeId) && (!p.search || s.display_name?.includes(p.search)));
        return { sessions: rows.slice(p.offset, p.offset + p.limit), total: rows.length };
      },
    },
    eventReads: {
      readEvents: async (id: string, after: number, limit: number, types?: string[]) => {
        fail("event_read_page"); return events.filter(e => e.id > after && (!types || types.includes(e.event_type)))
          .slice(0, limit).map(e => ({ ...e, session_id: id }));
      },
      countEvents: async () => { fail("event_count"); return events.length; },
      readOneEvent: async (id: string, eventId: number) => { fail("event_read_one");
        const event = events.find(e => e.id === eventId); return event ? { ...event, session_id: id } : null; },
    },
    storyReads: {
      getSessionStory: async () => { fail("story"); return { highlight: storyMode === "story" ? "하이라이트" : null,
        narrative: storyMode === "story" ? "줄거리" : null,
        unfoldedTurnSummaries: storyMode === "empty" ? [] : summaries,
        narrativeThroughEventId: 2, foldCount: 1, updatedAt: at }; },
      getSessionSearchMetadata: async (ids: string[]) => { fail("story_search_metadata");
        return ids.map(id => [id, { turnCount: 3, hasTurnSummaries: true, hasStoryDigest: true, hasHighlight: true }]); },
      countTurnSummaries: async () => { fail("turn_summary_count");
        return { totalCount: 3, digestedCount: 2, undigestedCount: 1 }; },
      loadTurnSummaryRange: async (_id: string, from: number, to: number | null, limit: number) => {
        fail("turn_summary_range"); return summaries.filter(s => s.turnNumber >= from && (to === null || s.turnNumber <= to)).slice(0, limit); },
    },
    historySearch: { search: async (p: any) => { fail("history_search");
      return { events: Object.keys(sessions).filter(id => !p.sessionIds || p.sessionIds.includes(id)).flatMap(id => events
        .filter(e => p.eventTypes.includes(e.event_type)).map(e => ({ ...e, session_id: id, score: 10 - e.id }))),
        sessionIdEvents: [], digests: [] }; } },
    sessionReadComposites: { getTurnExcerpt: async (_id: string, max: number) => { fail("turn_excerpt");
      return { totalEvents: 4, turns: [{ event_id: 4, event_type: "assistant_message", text: "needle 완료".slice(0, max), created_at: at.toISOString() }] }; } },
    sessionMutations: { renameSession: async (input: any) => { fail("rename_session");
      renameKeys.push(input.idempotencyKey); sessions[input.sessionId].display_name = input.displayName; return { ok: true }; } },
    deliveries: { recordObservedChildCompletions: async (batch: any[]) => {
      fail("record_observed_child_completions");
      if (revisionMismatch) return { status: "revision_mismatch", childSessionId: batch[0].childSessionId };
      observations.push(...batch); return { status: "recorded" }; } },
  } as unknown as PersistenceHostRepositories;
  const folderService = { getAllFolders: async () => { fail("get_all"); return [{ id: "folder", name: "폴더" }]; } };
  // Legacy list_sessions resolves the folder through its existing host route.
  registerFolderControlPlaneHostRoute(app, { authBearerToken: "token", serviceProvider: async () => folderService } as any);
  registerPersistenceHostRoutes(app, { authBearerToken: "token", repositoryProvider: async () => repositories });
  const cogito = { provider: { listConnectedNodes: () => [] }, briefCollector: { reflectBrief: async () => ({}) },
    searchProvider: { search: async (params: any) => {
      if (failure === "cogito") throw new Error("search unavailable");
      return { results: [], navigation_results: [], session_results: params.q === "missing" ? [] : Object.values(sessions)
        .filter(s => !params.session_filters?.folder_id || s.folder_id === params.session_filters.folder_id)
        .slice(0, params.top_k).map(s => ({ session_id: s.session_id, title: s.display_name,
          agent_name: "로젤린", node_id: s.node_id, status: s.status, created_at: at.toISOString(), updated_at: at.toISOString(),
          folder_name: "폴더", relevance: 1, best_match: { excerpt: "needle" }, session_url: `/?session=${s.session_id}` })),
        ...(partial ? { search_status: { search: { status: "partial" as const, stage: "semantic" as const, reason: "timeout" as const }, query_expansion: { status: "skipped" as const, latency_ms: 0 } } } : {}) };
    } } };
  registerCogitoRoutes(app, cogito);
  const catalog = { deleteSession: async (id: string) => { delete sessions[id]; notifications.push({ deleted: id }); } };
  const options = { authBearerToken: "token", folders: { authBearerToken: "token", serviceProvider: async () => folderService },
    cards: { resolveAccess: () => ({ restricted: false, allowedFolderIds: [] }), provider: { listFolders: () => [], listSessionAssignments: () => ({}) } },
    sessions: { repositoryProvider: async () => repositories, cogito, catalogProvider: catalog,
      resolveAccess: () => ({ restricted: false, allowedFolderIds: [] }),
      broadcastRename: async (id: string) => { notifications.push({ renamed: id }); } },
  } as unknown as McpHostOptions;
  registerMcpHostRoutes(app, options);
  app.addHook("onRequest", async request => { paths.push(request.url); });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const orch = { baseUrl, headers: { authorization: "Bearer token" } };
  const logger = { info: vi.fn(), warn: vi.fn() } as never;
  const db = new SessionDataHostClient({ orch, logger });
  const folders = new FolderHostClient({ orch, logger });
  const mutations = new SessionMutationHostClient({ orch, logger });
  const runtime = { nodeId: "local", orch, logger, db: { ...Object.fromEntries([
    "getSession", "listSessionsSummary", "readEvents", "countEvents", "readOneEvent", "getSessionStory", "getSessionSearchMetadata",
    "countTurnSummaries", "loadTurnSummaryRange", "searchSessionHistory", "getTurnExcerpt",
  ].map(name => [name, (db as any)[name].bind(db)])), getAllFolders: () => folders.getAllFolders(), getBoardItemIdsForSession: async () => ["board-item"] },
    childCompletionConsumption: new ChildCompletionConsumptionRecorder(new SessionDeliveryHostClient({ orch, logger })),
    catalogService: { renameSession: async (id: string, displayName: string | null) => {
      await mutations.renameSession(id, displayName, `rename_session:${id}:${renameIntentHash(displayName)}`);
      notifications.push({ renamed: id });
    }, broadcastSessionDeletion: async (id: string) => { notifications.push({ deleted: id }); } },
    taskManager: { deleteTask: async (id: string) => {
      if (sessions[id]?.node_id !== "local") throw new TaskOwnedByAnotherNodeError(id, sessions[id]?.node_id, "local");
      delete sessions[id];
    } },
  } as unknown as McpRuntime;
  function reset(settings: { mismatch?: boolean; failure?: string; partial?: boolean; story?: string; caller?: string | null; status?: string } = {}) {
    revisionMismatch = settings.mismatch ?? false; failure = settings.failure; partial = settings.partial ?? false; storyMode = settings.story ?? "story";
    observations = []; paths.length = 0; notifications.length = 0; renameKeys.length = 0;
    sessions = Object.fromEntries(["parent", "child", "other"].map(id => [id, { session_id: id, display_name: id,
      status: id === "child" ? settings.status ?? "completed" : "running", session_type: "agent", created_at: at, updated_at: at,
      event_count: 4, caller_session_id: id === "child" ? settings.caller === undefined ? "parent" : settings.caller : null,
      last_event_id: 4, away_summary: null, agent_id: "roselin", node_id: id === "child" ? "remote" : "local", folder_id: "folder" }]));
  }
  return { app, runtime, options, reset, paths, notifications, renameKeys,
    observations: () => observations, sessions: () => sessions };
}

function renameIntentHash(displayName: string | null) { return createHash("sha256").update(JSON.stringify({ displayName })).digest("hex"); }

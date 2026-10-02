import { createHash } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { errorResult, jsonResult, readOrchErrorEnvelopeText } from "@soulstream/mcp-contract";
import { SERVICE_CALLER } from "../auth/service_caller.js";
import { executeCogitoSearch, type CogitoRouteOptions } from "../cogito/cogito_routes.js";
import type { PersistenceHostRepositories } from "../control_plane/persistence_host_runtime.js";
import type { SessionCatalogProvider } from "../session/session_catalog_routes.js";
import { isBoardFolderAllowed, normalizeBoardAccess, type BoardAccess } from "../board/board_access.js";
import { sessionReadAdapter } from "./session_read_adapter.js";
import { sessionQueryHandlers } from "./session_query_handlers.js";
import type { McpToolHandler } from "./types.js";

export interface SessionMcpDependencies {
  repositoryProvider: () => Promise<PersistenceHostRepositories>;
  cogito: CogitoRouteOptions;
  catalogProvider: Pick<SessionCatalogProvider, "deleteSession">;
  resolveAccess: () => BoardAccess | Promise<BoardAccess>;
  broadcastRename: (sessionId: string) => Promise<void>;
}

const sessionNameHandlers = {
  get_session_name: async (options, args) => {
    try {
      if (!options.sessions) throw new Error("session MCP dependencies are required");
      const session = await sessionReadAdapter(await options.sessions.repositoryProvider()).getSession(args.session_id as string);
      if (!session) return errorResult(`세션을 찾을 수 없습니다: ${args.session_id}`);
      return jsonResult({ session_id: args.session_id, display_name: session.display_name });
    } catch (error) { return sdkError(error); }
  },
  set_session_name: async (options, args) => {
    try {
      if (!options.sessions) throw new Error("session MCP dependencies are required");
      const sessionId = args.session_id as string;
      const trimmed = ((args.name as string | undefined) ?? "").trim();
      const displayName = trimmed.length > 0 ? trimmed : null;
      const repositories = await options.sessions.repositoryProvider();
      const session = await sessionReadAdapter(repositories).getSession(sessionId);
      if (!session) return errorResult(`세션을 찾을 수 없습니다: ${sessionId}`);
      const intentHash = createHash("sha256").update(JSON.stringify({ displayName })).digest("hex");
      try {
        await repositories.sessionMutations.renameSession({ sessionId, displayName,
          idempotencyKey: `rename_session:${sessionId}:${intentHash}` });
      } catch (error) {
        throw new Error(`session-data host rename_session failed: ${error instanceof Error ? error.message : "Persistence host operation failed"}`);
      }
      await options.sessions.broadcastRename(sessionId);
      return jsonResult({ session_id: sessionId, display_name: displayName });
    } catch (error) { return sdkError(error); }
  },
} satisfies Record<string, McpToolHandler>;

const sessionSearchHandlers = {
  search_sessions: async (options, args, context) => {
    try {
      if (!options.sessions) throw new Error("session MCP dependencies are required");
      const callerSessionId = context.principal === "external" ? undefined : context.callerSessionId ?? undefined;
      const limit = (args.top_k as number | undefined) ?? 10;
      const query = { q: args.query, top_k: String(callerSessionId ? limit + 1 : limit), include_session_results: "true",
        session_search_mode: "expanded", search_session_id: "true",
        ...(args.folder_id === undefined ? {} : { session_folder_id: args.folder_id }) };
      let response;
      try { response = await executeCogitoSearch(options.sessions.cogito, query, SERVICE_CALLER, context.signal); }
      catch (error) {
        // Fastify's default uncaught-error envelope is what the legacy worker GET receives.
        const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
        response = { statusCode, body: { statusCode, error: STATUS_CODES[statusCode], message: error instanceof Error ? error.message : String(error) } };
      }
      if (response.statusCode !== 200) {
        const statusText = STATUS_CODES[response.statusCode] ?? "";
        const detail = readOrchErrorEnvelopeText({ status: response.statusCode, statusText }, JSON.stringify(response.body));
        return errorResult(`orch GET /cogito/search failed: ${response.statusCode} ${statusText} ${detail.message}`);
      }
      const data = response.body as { session_results: Record<string, unknown>[];
        search_status?: { search?: { status?: string; reason?: string } } };
      const search = data.search_status?.search;
      const isPartial = search?.status === "partial";
      const results = callerSessionId ? data.session_results.filter(r => r.session_id !== callerSessionId).slice(0, limit) : data.session_results;
      return jsonResult({ query: args.query, status: isPartial ? "partial" : "complete", partial_reason: isPartial ? search.reason ?? null : null,
        results: results.map(result => ({ session_id: result.session_id, title: result.title, agent_name: result.agent_name,
          node_id: result.node_id, status: result.status, created_at: result.created_at, updated_at: result.updated_at,
          folder_name: result.folder_name, relevance: result.relevance ?? null,
          excerpt: (result.best_match as { excerpt?: string } | null)?.excerpt ?? null, session_url: result.session_url })) });
    } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
  },
  delete_session: async (options, args, context) => {
    try {
      if (context.principal === "external") return errorResult("delete_session is not available to external callers");
      if (!options.sessions) throw new Error("session MCP dependencies are required");
      const sessionId = args.session_id as string;
      const session = await sessionReadAdapter(await options.sessions.repositoryProvider()).getSession(sessionId);
      const access = normalizeBoardAccess(await options.sessions.resolveAccess());
      if (access.restricted) {
        const folders = await (await options.folders.serviceProvider()).getAllFolders();
        if (!session || !isBoardFolderAllowed(access, folders, session.folder_id)) return errorResult("Folder access denied");
      }
      if (session?.status === "running") return errorResult(`Session ${sessionId} on node ${session.node_id} is running; stop it before deleting it`);
      await options.sessions.catalogProvider.deleteSession(sessionId);
      return jsonResult({ ok: true, session_id: sessionId });
    } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
  },
} satisfies Record<string, McpToolHandler>;

function sdkError(error: unknown) {
  return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
}
export const sessionHandlers = { ...sessionQueryHandlers, ...sessionNameHandlers, ...sessionSearchHandlers };

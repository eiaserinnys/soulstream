import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  fetchOrchResponse,
  readOrchErrorEnvelope,
} from "../../control_plane/persistence_host_transport.js";
import { resolveEffectiveCallerSessionId } from "./caller_session.js";
import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";

const SEARCH_TIMEOUT_MS = 15_000;

type CogitoSearchResult = {
  session_id: string;
  title: string;
  agent_name: string | null;
  node_id: string | null;
  status: string | null;
  created_at: string | null;
  updated_at: string | null;
  folder_title: string | null;
  relevance?: number | null;
  best_match?: { excerpt?: string | null } | null;
  session_url: string | null;
};

type CogitoSearchResponse = {
  search_status?: {
    search?: {
      status?: string;
      reason?: "timeout" | "error" | "cancelled";
    };
  };
  session_results: CogitoSearchResult[];
};

export function registerSearchSessionsTool(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "search_sessions",
    {
      description:
        "과거 세션을 뜻으로 찾는다. 검색어가 가리키는 작업이나 대화를 한 세션을 관련도 순으로 돌려준다. "
        + "원문 이벤트 조각(특정 문장, 도구 출력)이 필요하면 search_session_history를 쓴다.",
      inputSchema: {
        query: z.string().min(1).max(500),
        top_k: z.number().int().min(1).max(30).default(10),
        folder_id: z.string().optional(),
      },
    },
    async ({ query, top_k, folder_id }, extra) => {
      const orch = runtime.orch;
      if (!orch) return errorResult("orchestrator proxy is not configured");

      const callerSessionId = resolveEffectiveCallerSessionId(undefined);
      const resultLimit = top_k ?? 10;
      const orchLimit = callerSessionId ? resultLimit + 1 : resultLimit;
      const searchParams = new URLSearchParams({
        q: query,
        top_k: String(orchLimit),
        include_session_results: "true",
        session_search_mode: "expanded",
        search_session_id: "true",
      });
      if (folder_id !== undefined) {
        searchParams.set("session_folder_id", folder_id);
      }

      const path = `/cogito/search?${searchParams.toString()}`;
      try {
        const response = await fetchOrchResponse(
          orch,
          "GET",
          path,
          undefined,
          { timeoutMs: SEARCH_TIMEOUT_MS, signal: extra.signal },
        );
        if (!response.ok) {
          const detail = await readOrchErrorEnvelope(response);
          return errorResult(
            `orch GET /cogito/search failed: ${response.status} ${response.statusText} ${detail.message}`,
          );
        }

        const data = await response.json() as CogitoSearchResponse;
        const search = data.search_status?.search;
        const isPartial = search?.status === "partial";
        const sessionResults = callerSessionId
          ? data.session_results
            .filter((result) => result.session_id !== callerSessionId)
            .slice(0, resultLimit)
          : data.session_results;
        return jsonResult({
          query,
          status: isPartial ? "partial" : "complete",
          partial_reason: isPartial ? search.reason ?? null : null,
          results: sessionResults.map((result) => ({
            session_id: result.session_id,
            title: result.title,
            agent_name: result.agent_name,
            node_id: result.node_id,
            status: result.status,
            created_at: result.created_at,
            updated_at: result.updated_at,
            folder_title: result.folder_title,
            relevance: result.relevance ?? null,
            excerpt: result.best_match?.excerpt ?? null,
            session_url: result.session_url,
          })),
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );
}

/**
 * multi_node 도구 — Python `mcp_multi_node.py` 정합.
 *
 * runtime.orch 미설정 시 도구는 등록되되 호출 시 `{error: ...}` 반환 (Codex가 도구 surface는
 * 발견하되 실패 사유를 명확히 받게).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { buildCallerInfoFromCallerSession } from "../../caller_info.js";
import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";

const NOT_CONFIGURED_MSG = "multi-node not configured";

export function registerMultiNodeTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "list_nodes",
    {
      description: "오케스트레이터에 연결된 노드 목록 조회.",
      inputSchema: {},
    },
    async () => {
      const orch = runtime.orch;
      if (!orch) return errorResult(NOT_CONFIGURED_MSG);
      try {
        const data = await fetchOrch(orch, "GET", "/api/nodes");
        return jsonResult(data);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "list_node_agents",
    {
      description: "특정 노드의 에이전트 목록 조회.",
      inputSchema: { node_id: z.string().min(1) },
    },
    async ({ node_id }) => {
      const orch = runtime.orch;
      if (!orch) return errorResult(NOT_CONFIGURED_MSG);
      try {
        const data = await fetchOrch(
          orch,
          "GET",
          `/api/nodes/${encodeURIComponent(node_id)}/agents`,
        );
        return jsonResult(data);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "create_remote_agent_session",
    {
      description:
        "다른 노드에 새 에이전트 세션을 생성한다. caller_info(v1)를 자동 조립하여 원격 노드로 전파.",
      inputSchema: {
        node_id: z.string().min(1),
        agent_id: z.string().optional(),
        prompt: z.string(),
        caller_session_id: z.string().optional(),
        folder_id: z.string().optional(),
      },
    },
    async ({ node_id, agent_id, prompt, caller_session_id, folder_id }) => {
      const orch = runtime.orch;
      if (!orch) return errorResult(NOT_CONFIGURED_MSG);

      const callerInfo = caller_session_id
        ? buildCallerInfoFromCallerSession(runtime, caller_session_id)
        : undefined;

      const body: Record<string, unknown> = {
        prompt,
        nodeId: node_id,
      };
      if (agent_id !== undefined) body.profile = agent_id;
      if (folder_id !== undefined) body.folderId = folder_id;
      if (caller_session_id !== undefined)
        body.caller_session_id = caller_session_id;
      if (callerInfo) body.caller_info = callerInfo;

      try {
        const data = await fetchOrch(orch, "POST", "/api/sessions", body);
        return jsonResult(data);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

async function fetchOrch(
  orch: { baseUrl: string; headers: Record<string, string> },
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${orch.baseUrl}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      "content-type": "application/json",
      ...orch.headers,
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`orch ${method} ${path} failed: ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

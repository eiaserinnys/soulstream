/**
 * reflect_* 도구 — TS 노드의 *자기 자신* 리플렉션.
 *
 * Python `mcp_cogito.py` 정합 — 단 TS 노드는 manifest를 별도로 보유하지 않으므로
 * 도구는 *현 프로세스의 capability/source 위치*만 반환한다.
 * 외부 서비스(다른 노드, slack 봇 등) 리플렉션은 본 카드 범위 외.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";

const PROCESS_START_MS = Date.now();

const SELF_IDENTITY = {
  name: "soul-server-ts",
  description:
    "Soulstream Codex 전담 노드 (TS) — Codex CLI Streamable HTTP MCP 진입점.",
  capabilities: [
    {
      name: "cogito",
      description: "서비스 리플렉션 데이터 조회 (MCP 도구)",
      tools: ["reflect_service", "reflect_brief", "reflect_refresh"],
    },
    {
      name: "session_query",
      description: "세션·이벤트 조회",
      tools: [
        "list_sessions",
        "list_session_events",
        "get_session_event",
        "download_session_history",
        "search_session_history",
        "get_session_summary",
      ],
    },
    {
      name: "session_mgmt",
      description: "에이전트 세션 생성·메시지·이름",
      tools: [
        "list_local_agents",
        "create_agent_session",
        "send_message_to_session",
        "get_session_name",
        "set_session_name",
      ],
    },
    {
      name: "catalog",
      description: "폴더·세션 카탈로그 mutation",
      tools: [
        "list_folders",
        "create_folder",
        "rename_folder",
        "delete_folder",
        "move_sessions_to_folder",
        "get_folder_system_prompt",
        "set_folder_system_prompt",
        "delete_session",
      ],
    },
    {
      name: "agent_config",
      description: "agents.yaml agent profile 조회·편집",
      tools: [
        "get_agents_config",
        "plan_agent_profile_update",
        "update_agent_profile",
        "set_agent_atom_contexts",
        "rollback_agents_config",
      ],
    },
    {
      name: "multi_node",
      description: "오케스트레이터 경유 다른 노드 호출",
      tools: ["list_nodes", "list_node_agents", "create_remote_agent_session"],
    },
  ],
};

export function registerReflectTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "reflect_service",
    {
      description:
        "서비스의 리플렉션 데이터를 조회한다. 본 TS 노드는 'soul-server-ts'만 반영하며 그 외 서비스는 {error, available}을 반환.",
      inputSchema: {
        service: z.string().describe("서비스 이름"),
        level: z
          .number()
          .int()
          .min(0)
          .max(3)
          .default(0)
          .describe("0=기능, 1=설정, 2=소스, 3=런타임"),
        capability: z
          .string()
          .optional()
          .describe("특정 capability만 조회 (선택)"),
      },
    },
    async ({ service, level, capability }) => {
      if (service !== SELF_IDENTITY.name) {
        return errorResult(
          `서비스를 찾을 수 없습니다: ${service}. 본 노드는 '${SELF_IDENTITY.name}'만 반영합니다.`,
        );
      }
      const lv = level ?? 0;
      const reflection = reflectSelf(runtime, lv, capability);
      return jsonResult(reflection);
    },
  );

  server.registerTool(
    "reflect_brief",
    {
      description:
        "본 TS 노드의 Level 0 브리프를 반환한다. 다른 서비스를 합치는 BriefComposer는 본 카드 범위 외.",
      inputSchema: {},
    },
    async () => {
      return jsonResult({
        services: [
          {
            name: SELF_IDENTITY.name,
            type: "internal",
            data: {
              identity: SELF_IDENTITY,
              node_id: runtime.nodeId,
            },
          },
        ],
      });
    },
  );

  server.registerTool(
    "reflect_refresh",
    {
      description:
        "Python BriefComposer만 브리프 파일을 갱신한다. 본 TS 노드는 미보유 — no-op.",
      inputSchema: {},
    },
    async () => {
      return jsonResult({
        refreshed: false,
        reason: "ts node has no brief composer",
      });
    },
  );
}

function reflectSelf(
  runtime: McpRuntime,
  level: number,
  capability?: string,
): Record<string, unknown> {
  if (level === 0) {
    return {
      identity: {
        name: SELF_IDENTITY.name,
        description: SELF_IDENTITY.description,
      },
      capabilities: capability
        ? SELF_IDENTITY.capabilities.filter((c) => c.name === capability)
        : SELF_IDENTITY.capabilities,
    };
  }
  if (level === 1) {
    return {
      configs: [
        { key: "node_id", value: runtime.nodeId },
        { key: "agents_config_path", value: runtime.agentsConfigPath },
        { key: "mcp_capability_count", value: SELF_IDENTITY.capabilities.length },
      ],
    };
  }
  if (level === 2) {
    return {
      sources: [
        { module: "mcp/server.ts", role: "MCP server factory + 도구 등록" },
        { module: "mcp/transport.ts", role: "Streamable HTTP transport" },
        { module: "mcp/tools/*", role: "각 capability별 도구 핸들러" },
        { module: "agent_registry.ts", role: "agents.yaml schema/load/write" },
        { module: "task/task_manager.ts", role: "세션 lifecycle" },
        { module: "engine/codex_adapter.ts", role: "Codex SDK 어댑터" },
      ],
    };
  }
  // level 3 — runtime
  return {
    status: "healthy",
    node_id: runtime.nodeId,
    pid: process.pid,
    uptime_seconds: Math.floor((Date.now() - PROCESS_START_MS) / 1000),
    agent_count: runtime.agentRegistry.list().length,
    active_task_count: runtime.taskManager.listTasks().length,
  };
}

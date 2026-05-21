/**
 * agents.yaml 도구 — agent profile 정본을 MCP에서 읽고 편집한다.
 *
 * 파일 쓰기 후 같은 AgentRegistry 인스턴스를 reload하여, 새 세션 생성 경로가 즉시
 * 갱신된 profile을 보도록 한다. 이미 실행 중인 세션은 시작 당시 profile을 유지한다.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  AgentAtomContextSchema,
  AgentProfileSchema,
  readAgentsConfigRaw,
  replaceAgentProfileInConfig,
  setAgentAtomContextsInConfig,
} from "../../agent_registry.js";
import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";

export function registerAgentConfigTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "get_agents_config",
    {
      description:
        "agents.yaml 설정 조회. include_raw=true면 원본 YAML도 반환한다.",
      inputSchema: {
        include_raw: z.boolean().default(false),
      },
    },
    async ({ include_raw }) => {
      try {
        const { raw, parsed } = readAgentsConfigRaw(runtime.agentsConfigPath);
        return jsonResult({
          config_path: runtime.agentsConfigPath,
          agents: parsed.agents,
          ...(include_raw ? { raw_yaml: raw } : {}),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "update_agent_profile",
    {
      description:
        "agents.yaml의 단일 agent profile을 교체한다. create_if_missing=true면 새 profile을 추가한다.",
      inputSchema: {
        profile: AgentProfileSchema,
        create_if_missing: z.boolean().default(false),
      },
    },
    async ({ profile, create_if_missing }) => {
      try {
        const updated = replaceAgentProfileInConfig(
          runtime.agentsConfigPath,
          profile,
          create_if_missing ?? false,
        );
        runtime.agentRegistry.replace(updated.agents);
        return jsonResult({
          ok: true,
          config_path: runtime.agentsConfigPath,
          agent_count: updated.agents.length,
          agent: updated.agents.find((p) => p.id === profile.id),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "set_agent_atom_contexts",
    {
      description:
        "agents.yaml의 agent.atom_contexts를 교체한다. 각 항목은 atom node_id, bfs depth, titles_only를 지정한다.",
      inputSchema: {
        agent_id: z.string().min(1),
        atom_contexts: z.array(AgentAtomContextSchema).default([]),
      },
    },
    async ({ agent_id, atom_contexts }) => {
      try {
        const updated = setAgentAtomContextsInConfig(
          runtime.agentsConfigPath,
          agent_id,
          atom_contexts ?? [],
        );
        runtime.agentRegistry.replace(updated.agents);
        return jsonResult({
          ok: true,
          config_path: runtime.agentsConfigPath,
          agent: updated.agents.find((p) => p.id === agent_id),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

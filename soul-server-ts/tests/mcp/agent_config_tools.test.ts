import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import type { AgentConfigService } from "../../src/agent_config_service.js";
import type { AgentProfile } from "../../src/agent_registry.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { registerAgentConfigTools } from "../../src/mcp/tools/agent_config.js";

describe("get_agents_config", () => {
  it("overlays DB identity fields without returning resolved MCP secrets", async () => {
    const yamlAgentsSdk: NonNullable<AgentProfile["agents_sdk"]> = {
      entry_agent: "root",
      agents: [{
        id: "root",
        name: "Root",
        instructions: "instructions",
        handoffs: [],
        tools: [],
        hosted_tools: [],
        mcp_servers: [],
      }],
      guardrails: { input_blocklist: [], output_blocklist: [] },
    };
    const yamlProfile = {
      id: "roselin",
      name: "YAML Roselin",
      backend: "openai-agents",
      workspace_dir: "/tmp/roselin",
      mcp_profile: "roselin-mcp",
      agents_sdk: yamlAgentsSdk,
    } as AgentProfile;
    const effectiveProfile = {
      ...yamlProfile,
      name: "DB Roselin",
      atom_contexts: [{ node_id: "db-node" }],
      aliases: [{ id: "db-alias" }],
      default_preset: "db-preset",
      agents_sdk: {
        ...yamlAgentsSdk,
        agents: [{
          ...yamlAgentsSdk.agents[0]!,
          mcp_servers: [
            {
              type: "streamable_http",
              name: "secret-http",
              url: "https://mcp.example.test",
              headers: { Authorization: "header-secret-value" },
            },
            {
              type: "stdio",
              name: "secret-stdio",
              command: "mcp",
              env: { API_TOKEN: "env-secret-value" },
            },
          ],
        }],
      },
    } as AgentProfile;
    let handler: ((args: { include_raw: boolean }) => Promise<CallToolResult>) | undefined;
    const server = {
      registerTool: (
        name: string,
        _definition: unknown,
        callback: (args: unknown) => Promise<CallToolResult>,
      ) => {
        if (name === "get_agents_config") {
          handler = callback as (args: { include_raw: boolean }) => Promise<CallToolResult>;
        }
      },
    } as unknown as McpServer;
    const runtime = {
      agentsConfigPath: "agents.yaml",
      agentConfigService: {
        readRaw: () => ({ raw: "yaml-source", parsed: { agents: [yamlProfile] } }),
      } as unknown as AgentConfigService,
      agentProfileSource: {
        list: async () => [{
          profile: effectiveProfile,
          source: "db" as const,
          stale: false,
          hasPortrait: false,
          portraitSource: "none" as const,
        }],
        resolve: async () => undefined,
        state: () => ({ stale: false, checkedAt: null, lastError: null, counts: { db: 1, yaml: 0 } }),
      },
    } as unknown as McpRuntime;
    registerAgentConfigTools(server, runtime);

    const response = await handler!({ include_raw: true });

    expect(response.structuredContent).toMatchObject({
      agents: [{
        id: "roselin",
        name: "DB Roselin",
        source: "db",
        stale: false,
        atom_contexts: [{ node_id: "db-node" }],
        aliases: [{ id: "db-alias" }],
        default_preset: "db-preset",
        agents_sdk: yamlProfile.agents_sdk,
      }],
      yaml_agents: [{ id: "roselin", name: "YAML Roselin" }],
      raw_yaml: "yaml-source",
    });
    const serialized = JSON.stringify(response.structuredContent);
    expect(serialized).not.toContain("header-secret-value");
    expect(serialized).not.toContain("env-secret-value");
  });
});

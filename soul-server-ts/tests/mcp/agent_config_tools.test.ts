import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import type { AgentConfigService } from "../../src/agent_config_service.js";
import type { AgentProfile } from "../../src/agent_registry.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { registerAgentConfigTools } from "../../src/mcp/tools/agent_config.js";

describe("get_agents_config", () => {
  it("shows effective profiles with their source and keeps YAML behind include_raw", async () => {
    const yamlProfile = { id: "roselin", name: "YAML Roselin" } as AgentProfile;
    const effectiveProfile = { id: "roselin", name: "DB Roselin" } as AgentProfile;
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
      agents: [{ id: "roselin", name: "DB Roselin", source: "db", stale: false }],
      yaml_agents: [{ id: "roselin", name: "YAML Roselin" }],
      raw_yaml: "yaml-source",
    });
  });
});

import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

import { AgentProfileSchema } from "../../src/agent_registry.js";
import { McpConfigService } from "../../src/mcp_config_service.js";

it("accepts multiple unnamed inline MCP servers in one agent", () => {
  const values = [randomUUID(), randomUUID()];
  const profile = AgentProfileSchema.parse({
    id: "test", name: "Test", backend: "openai-agents", workspace_dir: "/tmp",
    agents_sdk: { entry_agent: "a", agents: [{
      id: "a", name: "A", instructions: "test",
      mcp_servers: values.map((value, index) => ({
        type: "streamable_http", url: `https://server${index}.example.test/mcp`,
        headers: { "X-Key": value },
      })),
    }] },
  });
  const resolved = new McpConfigService({ agentsConfigPath: "/unused/agents.yaml" })
    .resolveAgentProfile(profile);
  const servers = resolved.agents_sdk!.agents[0]!.mcp_servers;
  expect(servers).toHaveLength(2);
  expect(servers.map((server) => server.name)).toEqual([undefined, undefined]);
  expect(servers.every((server, index) => server.headers?.["X-Key"] === values[index])).toBe(true);
});

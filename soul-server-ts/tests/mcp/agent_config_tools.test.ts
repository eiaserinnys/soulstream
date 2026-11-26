import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { AgentConfigService } from "../../src/agent_config_service.js";
import { AgentRegistry } from "../../src/agent_registry.js";
import type { AgentProfile } from "@soulstream/agent-profile-contract";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { registerAgentConfigTools } from "../../src/mcp/tools/agent_config.js";
import { makeTempDirSync } from "../helpers/temp_dir.js";

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
      backend: "codex",
      workspace_dir: "/tmp/roselin",
      mcp_profile: "roselin-mcp",
      agents_sdk: yamlAgentsSdk,
    } as AgentProfile;
    const effectiveProfile = {
      ...yamlProfile,
      name: "DB Roselin",
      atom_contexts: [{ node_id: "db-node", depth: 3, titles_only: false }],
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

describe("local agent profile patch tools", () => {
  it("plans and applies partial patches and returns absolute config paths", async () => {
    const dir = makeTempDirSync("agent-config-mcp-");
    const configPath = path.join(dir, "agents.yaml");
    const relativePath = path.relative(process.cwd(), configPath);
    fs.writeFileSync(configPath, "agents:\n  - id: agent\n    name: Original\n    backend: codex\n    workspace_dir: /tmp/agent\n    default_preset: preset\n    model: old\n");
    const registry = new AgentRegistry([]);
    const agentConfigService = new AgentConfigService({ configPath: relativePath, snapshotRoot: path.join(dir, "snapshots"), agentRegistry: registry });
    const runtime = { agentsConfigPath: path.resolve(relativePath), agentConfigService, agentRegistry: registry } as unknown as McpRuntime;
    const server = new McpServer({ name: "agent-config-test", version: "1" });
    const client = new Client({ name: "agent-config-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    registerAgentConfigTools(server, runtime);
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const get = await client.callTool({ name: "get_agents_config", arguments: {} });
      expect(get.structuredContent).toMatchObject({ config_path: configPath });
      const args = { profile: { id: "agent", name: "Changed", model: null }, include_text_diff: true };
      const plan = await client.callTool({ name: "plan_agent_profile_update", arguments: args });
      const apply = await client.callTool({ name: "update_agent_profile", arguments: args });
      expect(plan.structuredContent).toMatchObject({ ok: true, config_path: configPath,
        semantic_changes: [{ after: { id: "agent", name: "Changed", default_preset: "preset" } }] });
      expect(apply.structuredContent).toMatchObject({ ok: true, config_path: configPath,
        agent: { id: "agent", name: "Changed", default_preset: "preset" } });
      expect((apply.structuredContent as any).agent).not.toHaveProperty("model");
      const invalid = await client.callTool({ name: "update_agent_profile", arguments: { profile: { id: "agent", name: null } } });
      expect(invalid.isError).toBe(true);
      const beforeUnknown = fs.readFileSync(configPath, "utf8");
      const unknown = await client.callTool({ name: "update_agent_profile", arguments: {
        profile: { id: "agent", description: "unknown" },
      } });
      expect(unknown.isError).toBe(true);
      expect(JSON.stringify(unknown.content)).toContain("description");
      expect(fs.readFileSync(configPath, "utf8")).toBe(beforeUnknown);
    } finally {
      await client.close();
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("central MCP agent bindings", () => {
  it("shows effective binding and rejects local binding edits", async () => {
    const { McpConfigService } = await import("../../src/mcp_config_service.js");
    const dir = makeTempDirSync("agent-central-");
    const agentsConfigPath = path.join(dir, "agents.yaml");
    fs.writeFileSync(agentsConfigPath, "agents:\n  - id: agent\n    name: Agent\n    backend: codex\n    workspace_dir: /tmp/agent\n    mcp_profile: local\n");
    const registry = new AgentRegistry([]);
    const mcpConfigService = new McpConfigService({ agentsConfigPath, modePath: path.join(dir, "marker.json") });
    const snapshot = { registry: { servers: [] }, profiles: { profiles: [{ id: "central" }] }, agent_bindings: { agent: "central" } };
    await mcpConfigService.applyCentralSync({ revision: 5, runtime: snapshot, display: snapshot });
    const runtime = { agentsConfigPath, agentRegistry: registry, mcpConfigService } as unknown as McpRuntime;
    const server = new McpServer({ name: "central-test", version: "1" });
    const client = new Client({ name: "central-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    registerAgentConfigTools(server, runtime);
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      const get = await client.callTool({ name: "get_agents_config", arguments: {} });
      expect(get.structuredContent).toMatchObject({ agents: [{ id: "agent", mcp_profile: "central" }], mcp_config: { mode: "central", revision: 5 } });
      for (const name of ["set_agent_mcp_profile", "plan_agent_mcp_profile_update"]) {
        const result = await client.callTool({ name, arguments: { agent_id: "agent", mcp_profile: "local" } });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ code: "MCP_CENTRAL_MODE", error: "중앙 설정을 쓰는 노드입니다. 대시보드 설정 > 에이전트 > MCP에서 바꿉니다." });
      }
    } finally { await client.close(); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

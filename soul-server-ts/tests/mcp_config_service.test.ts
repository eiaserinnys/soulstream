import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentProfileSchema } from "../src/agent_registry.js";
import {
  defaultMcpProfilesPath,
  defaultMcpRegistryPath,
  McpConfigService,
} from "../src/mcp_config_service.js";

describe("McpConfigService", () => {
  let tempDir: string;
  let agentsConfigPath: string;
  let registryPath: string;
  let profilesPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-config-service-"));
    agentsConfigPath = path.join(tempDir, "agents.yaml");
    registryPath = path.join(tempDir, "mcp-registry.yaml");
    profilesPath = path.join(tempDir, "mcp-profiles.yaml");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("derives default registry/profile paths beside agents.yaml", () => {
    expect(defaultMcpRegistryPath(agentsConfigPath)).toBe(registryPath);
    expect(defaultMcpProfilesPath(agentsConfigPath)).toBe(profilesPath);
  });

  it("missing registry/profile files are empty config for existing inline-only agents", () => {
    const service = new McpConfigService({ agentsConfigPath });
    const profile = AgentProfileSchema.parse({
      id: "agents-inline",
      name: "Agents Inline",
      backend: "openai-agents",
      workspace_dir: "/tmp/agents",
      agents_sdk: {
        entry_agent: "triage",
        agents: [
          {
            id: "triage",
            name: "Triage",
            instructions: "Route work.",
            mcp_servers: [
              {
                type: "stdio",
                name: "inline-docs",
                command: "node",
                args: ["server.js"],
              },
            ],
          },
        ],
      },
    });

    expect(service.listRegistry().servers).toEqual([]);
    expect(service.listProfiles().profiles).toEqual([]);
    expect(service.resolveAgentProfile(profile)).toEqual(profile);
  });

  it("resolves mcp_profile servers and hosted tools into OpenAI Agents runtime config", () => {
    fs.writeFileSync(
      registryPath,
      [
        "servers:",
        "  - id: docs",
        "    type: streamable_http",
        "    url: https://docs.example.com/mcp",
        "    headers:",
        "      Authorization:",
        "        env: DOCS_AUTH",
        "",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      profilesPath,
      [
        "profiles:",
        "  - id: research",
        "    name: Research",
        "    description: Search and docs",
        "    mcp_servers: [docs]",
        "    hosted_tools:",
        "      - type: web_search",
        "        search_context_size: low",
        "",
      ].join("\n"),
      "utf-8",
    );
    const service = new McpConfigService({
      agentsConfigPath,
      processEnv: { DOCS_AUTH: "Bearer secret" },
    });
    const profile = AgentProfileSchema.parse({
      id: "agents-research",
      name: "Agents Research",
      backend: "openai-agents",
      workspace_dir: "/tmp/agents",
      mcp_profile: "research",
      agents_sdk: {
        entry_agent: "triage",
        agents: [
          {
            id: "triage",
            name: "Triage",
            instructions: "Route work.",
          },
        ],
      },
    });

    const resolved = service.resolveAgentProfile(profile);

    expect(resolved.agents_sdk?.agents[0]?.mcp_servers).toEqual([
      {
        type: "streamable_http",
        name: "docs",
        url: "https://docs.example.com/mcp",
        headers: { Authorization: "Bearer secret" },
      },
    ]);
    expect(resolved.agents_sdk?.agents[0]?.hosted_tools).toEqual([
      { type: "web_search", search_context_size: "low" },
    ]);
    expect(service.listRegistry().servers[0]?.headers?.Authorization).toEqual({
      env: "DOCS_AUTH",
      resolved: true,
    });
  });

  it("redacts hosted MCP authorization and sensitive headers from listProfiles output", () => {
    fs.writeFileSync(
      profilesPath,
      [
        "profiles:",
        "  - id: hosted",
        "    hosted_tools:",
        "      - type: hosted_mcp",
        "        server_label: hosted-docs",
        "        server_url: https://hosted.example.com/mcp",
        "        authorization: Bearer hosted-secret",
        "        headers:",
        "          Authorization: Bearer header-secret",
        "          X-API-Key: api-key-secret",
        "          X-Trace-Id: trace-id",
        "",
      ].join("\n"),
      "utf-8",
    );
    const service = new McpConfigService({ agentsConfigPath });

    const [profile] = service.listProfiles().profiles;
    const [hostedTool] = profile?.hosted_tools as Array<Record<string, unknown>>;

    expect(hostedTool.authorization).toEqual({ redacted: true });
    expect(hostedTool.headers).toEqual({
      Authorization: { redacted: true },
      "X-API-Key": { redacted: true },
      "X-Trace-Id": "trace-id",
    });
    expect(JSON.stringify(profile)).not.toContain("hosted-secret");
    expect(JSON.stringify(profile)).not.toContain("header-secret");
    expect(JSON.stringify(profile)).not.toContain("api-key-secret");
  });

  it("inline mcp_servers and hosted_tools override profile defaults by stable key", () => {
    fs.writeFileSync(
      registryPath,
      [
        "servers:",
        "  - id: docs",
        "    type: streamable_http",
        "    url: https://profile.example.com/mcp",
        "",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      profilesPath,
      [
        "profiles:",
        "  - id: research",
        "    mcp_servers: [docs]",
        "    hosted_tools:",
        "      - type: web_search",
        "        search_context_size: low",
        "",
      ].join("\n"),
      "utf-8",
    );
    const service = new McpConfigService({ agentsConfigPath });
    const profile = AgentProfileSchema.parse({
      id: "agents-research",
      name: "Agents Research",
      backend: "openai-agents",
      workspace_dir: "/tmp/agents",
      mcp_profile: "research",
      agents_sdk: {
        entry_agent: "triage",
        agents: [
          {
            id: "triage",
            name: "Triage",
            instructions: "Route work.",
            mcp_servers: [
              {
                type: "streamable_http",
                name: "docs",
                url: "https://inline.example.com/mcp",
              },
            ],
            hosted_tools: [
              {
                type: "web_search",
                search_context_size: "high",
              },
            ],
          },
        ],
      },
    });

    const resolved = service.resolveAgentProfile(profile);

    expect(resolved.agents_sdk?.agents[0]?.mcp_servers).toEqual([
      {
        type: "streamable_http",
        name: "docs",
        url: "https://inline.example.com/mcp",
      },
    ]);
    expect(resolved.agents_sdk?.agents[0]?.hosted_tools).toEqual([
      { type: "web_search", search_context_size: "high" },
    ]);
  });

  it("preserves multiple unnamed inline MCP servers when a profile is also present", () => {
    fs.writeFileSync(
      profilesPath,
      ["profiles:", "  - id: research", ""].join("\n"),
      "utf-8",
    );
    const service = new McpConfigService({ agentsConfigPath });
    const profile = AgentProfileSchema.parse({
      id: "agents-research",
      name: "Agents Research",
      backend: "openai-agents",
      workspace_dir: "/tmp/agents",
      mcp_profile: "research",
      agents_sdk: {
        entry_agent: "triage",
        agents: [
          {
            id: "triage",
            name: "Triage",
            instructions: "Route work.",
            mcp_servers: [
              {
                type: "streamable_http",
                url: "https://one.example.com/mcp",
              },
              {
                type: "streamable_http",
                url: "https://two.example.com/mcp",
              },
            ],
          },
        ],
      },
    });

    const resolved = service.resolveAgentProfile(profile);

    expect(resolved.agents_sdk?.agents[0]?.mcp_servers).toEqual([
      {
        type: "streamable_http",
        url: "https://one.example.com/mcp",
      },
      {
        type: "streamable_http",
        url: "https://two.example.com/mcp",
      },
    ]);
  });

  it("fails explicitly when a referenced server secret env var is missing", () => {
    fs.writeFileSync(
      registryPath,
      [
        "servers:",
        "  - id: docs",
        "    type: streamable_http",
        "    url: https://docs.example.com/mcp",
        "    headers:",
        "      Authorization:",
        "        env: DOCS_AUTH",
        "",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      profilesPath,
      [
        "profiles:",
        "  - id: research",
        "    mcp_servers: [docs]",
        "",
      ].join("\n"),
      "utf-8",
    );
    const service = new McpConfigService({ agentsConfigPath, processEnv: {} });
    const profile = AgentProfileSchema.parse({
      id: "agents-research",
      name: "Agents Research",
      backend: "openai-agents",
      workspace_dir: "/tmp/agents",
      mcp_profile: "research",
      agents_sdk: {
        entry_agent: "triage",
        agents: [{ id: "triage", name: "Triage", instructions: "Route work." }],
      },
    });

    expect(() => service.resolveAgentProfile(profile)).toThrow(
      /MCP registry server docs header Authorization env DOCS_AUTH is not set/,
    );
  });
});

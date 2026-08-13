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

import { makeTempDirSync } from "./helpers/temp_dir.js";

describe("McpConfigService", () => {
  let tempDir: string;
  let agentsConfigPath: string;
  let registryPath: string;
  let profilesPath: string;

  beforeEach(() => {
    tempDir = makeTempDirSync("mcp-config-service-");
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
    expect(service.resolveAgentProfile(profile)).toBe(profile);
  });

  it("redacts sensitive URL query values from registry listings without changing runtime URLs", () => {
    const runtimeUrl =
      "https://mcp.example.test/mcp?exaApiKey=fake-exa-key&tools=web_search_exa,get_code_context_exa";
    fs.writeFileSync(
      registryPath,
      [
        "servers:",
        "  - id: exa",
        "    type: streamable_http",
        `    url: ${runtimeUrl}`,
        "",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      profilesPath,
      [
        "profiles:",
        "  - id: research",
        "    mcp_servers: [exa]",
        "",
      ].join("\n"),
      "utf-8",
    );
    const service = new McpConfigService({ agentsConfigPath });
    const profile = AgentProfileSchema.parse({
      id: "agents-research",
      name: "Agents Research",
      backend: "claude",
      workspace_dir: "/tmp/agents",
      mcp_profile: "research",
    });

    expect(service.listRegistry().servers[0]?.url).toBe(
      "https://mcp.example.test/mcp?exaApiKey=<redacted>&tools=web_search_exa,get_code_context_exa",
    );
    expect(service.resolveMcpProfile(profile)?.mcp_servers[0]?.url).toBe(runtimeUrl);
  });

  it("leaves queryless registry URLs unchanged in listings", () => {
    fs.writeFileSync(
      registryPath,
      [
        "servers:",
        "  - id: docs",
        "    type: streamable_http",
        "    url: https://docs.example.test/mcp",
        "",
      ].join("\n"),
      "utf-8",
    );
    const service = new McpConfigService({ agentsConfigPath });

    expect(service.listRegistry().servers[0]?.url).toBe(
      "https://docs.example.test/mcp",
    );
  });

  it("keeps existing registry header and env sanitization behavior", () => {
    fs.writeFileSync(
      registryPath,
      [
        "servers:",
        "  - id: local",
        "    type: stdio",
        "    command: node",
        "    args: [server.js]",
        "    env:",
        "      API_TOKEN: fake-env-value",
        "      LOG_LEVEL: info",
        "    headers:",
        "      Authorization: Bearer fake-header-value",
        "      X-Trace-Id: trace-123",
        "",
      ].join("\n"),
      "utf-8",
    );
    const service = new McpConfigService({ agentsConfigPath });

    expect(service.listRegistry().servers[0]?.env).toEqual({
      API_TOKEN: { redacted: true },
      LOG_LEVEL: "info",
    });
    expect(service.listRegistry().servers[0]?.headers).toEqual({
      Authorization: { redacted: true },
      "X-Trace-Id": "trace-123",
    });
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

  it("resolves mcp_profile servers independently of the agent backend", () => {
    fs.writeFileSync(
      registryPath,
      [
        "servers:",
        "  - id: soulstream",
        "    type: streamable_http",
        "    url: http://127.0.0.1:3105/mcp",
        "    headers:",
        "      Authorization:",
        "        env: SOULSTREAM_MCP_AUTH",
        "",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      profilesPath,
      [
        "profiles:",
        "  - id: full",
        "    mcp_servers: [soulstream]",
        "",
      ].join("\n"),
      "utf-8",
    );
    const service = new McpConfigService({
      agentsConfigPath,
      processEnv: { SOULSTREAM_MCP_AUTH: "Bearer secret" },
    });
    const profile = AgentProfileSchema.parse({
      id: "claude-profile",
      name: "Claude Profile",
      backend: "claude",
      workspace_dir: "/tmp/claude",
      mcp_profile: "full",
    });

    expect(service.resolveMcpProfile(profile)).toEqual({
      mcp_servers: [
        {
          type: "streamable_http",
          name: "soulstream",
          url: "http://127.0.0.1:3105/mcp",
          headers: { Authorization: "Bearer secret" },
        },
      ],
      hosted_tools: [],
    });
    expect(service.resolveAgentProfile(profile)).toBe(profile);
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
        "        server_url: https://hosted.example.com/mcp?authToken=fake-hosted-url&mode=readonly",
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

    expect(hostedTool.server_url).toBe(
      "https://hosted.example.com/mcp?authToken=<redacted>&mode=readonly",
    );
    expect(hostedTool.authorization).toEqual({ redacted: true });
    expect(hostedTool.headers).toEqual({
      Authorization: { redacted: true },
      "X-API-Key": { redacted: true },
      "X-Trace-Id": "trace-id",
    });
    expect(JSON.stringify(profile)).not.toContain("fake-hosted-url");
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

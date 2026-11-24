import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentProfileSchema } from "@soulstream/agent-profile-contract";
import { previewAgentMcp } from "../src/mcp_central/agent_preview.js";
import { loadBundledIsolationPolicy } from "../src/security/session_isolation_policy.js";
import { McpConfigService } from "../src/mcp_config_service.js";
import { McpConfigCommands } from "../src/upstream/mcp_config_commands.js";
import { UnknownAgentProfileError } from "../src/upstream/task_runtime_commands.js";
import { CommandDispatcher } from "../src/upstream/dispatcher.js";
import { AgentRegistry } from "../src/agent_registry.js";
import pino from "pino";

const agent = AgentProfileSchema.parse({ id: "a", name: "A", backend: "codex", workspace_dir: "/tmp/a", mcp_profile: "p" });
const policy = loadBundledIsolationPolicy().policy.localMcp;
const server = { id: "atom", name: "catalog", type: "streamable_http", url: "https://example.test/mcp" };

describe("agent MCP preview", () => {
  it("preserves registry IDs separately from transport names and reports SDK blocking", () => {
    const result = previewAgentMcp({ agent, mode: "central", revision: 4, profileId: "p", servers: [server],
      codexMode: "sdk", isolationEnabled: true, nodeId: "test", localMcpPolicy: policy });
    expect(result.normal.runnable).toBe(false);
    expect(result.restricted.runnable).toBe(false);
    expect(result.normal.servers).toMatchObject([{ server_id: "atom", name: "catalog" }]);
  });

  it("uses the restricted session sanitizer and retains the required internal server", () => {
    const result = previewAgentMcp({ agent: { ...agent, backend: "claude" }, mode: "central", revision: 4,
      profileId: "p", servers: [server, { id: "local", name: "local", type: "streamable_http", url: "http://127.0.0.1:1234/mcp" }],
      codexMode: "app-server", isolationEnabled: true, nodeId: "test", localMcpPolicy: policy });
    expect(result.restricted.servers).toEqual(expect.arrayContaining([
      expect.objectContaining({ server_id: "soulstream", included: true }),
      expect.objectContaining({ server_id: "local", included: false }),
    ]));
  });

  it("uses backend selectors for SSE and OpenCode tool restrictions", () => {
    const sse = { id: "legacy", name: "legacy", type: "sse", url: "https://example.test/sse" };
    for (const backend of ["codex", "antigravity"] as const) {
      const result = previewAgentMcp({ agent, backend, mode: "local", revision: 0, servers: [sse], codexMode: "app-server",
        isolationEnabled: true, nodeId: "test", localMcpPolicy: policy });
      expect(result.normal.servers).toMatchObject([{ server_id: "legacy", included: false, excluded_reason: expect.any(String) }]);
    }
    const result = previewAgentMcp({ agent, backend: "opencode", mode: "local", revision: 0, servers: [server], allowlist: { catalog: [] },
      codexMode: "app-server", isolationEnabled: true, nodeId: "test", localMcpPolicy: policy });
    expect(result.normal.servers).toMatchObject([{ server_id: "atom", included: false }]);
  });

  it("uses display data for current and virtual profiles, and rejects unknown agents", async () => {
    const service = new McpConfigService({ agentsConfigPath: "/tmp/preview-agents.yaml", processEnv: {} });
    const snapshot = { registry: { servers: [server] }, profiles: { profiles: [{ id: "p", mcp_servers: ["atom"] }] }, agent_bindings: { a: "p" } };
    const runtime = { ...snapshot, registry: { servers: [{ ...server, name: "fake-runtime-value" }] } };
    await service.applyCentralSync({ revision: 4, runtime, display: snapshot });
    const commands = new McpConfigCommands(service, () => {}, undefined, { tasks: { resolveNewSessionAgent: async id => {
      if (id !== "a") throw new UnknownAgentProfileError(id);
      return { profile: agent, hasDbPortrait: false, fromSource: false };
    } }, context: { nodeId: "test", codexMode: "app-server", isolationEnabled: true, localMcpPolicy: () => policy } });
    const current = await commands.preview({ requestId: "1", agent_id: "a" });
    expect(current.data.normal.servers).toMatchObject([{ server_id: "atom", name: "catalog", included: true }]);
    expect(JSON.stringify(current)).not.toContain("fake-runtime-value");
    expect(JSON.stringify(current)).not.toContain('"icon"');
    const virtual = await commands.preview({ requestId: "2", agent_id: "a", mcp_profile_id: "virtual", servers: [{ server_id: "atom", name: "alternate", type: "streamable_http" }] });
    expect(virtual.data.normal.servers).toMatchObject([{ server_id: "atom", name: "alternate" }]);
    await expect(commands.preview({ requestId: "3", agent_id: "missing" })).rejects.toMatchObject({ code: "MCP_AGENT_NOT_FOUND" });
    const portable = new McpConfigService({ agentsConfigPath: "/tmp/preview-agents.yaml", isPortableNode: true });
    await expect(new McpConfigCommands(portable, undefined).preview({})).rejects.toMatchObject({ code: "MCP_PORTABLE_NODE" });
  });

  it("uses the actual Claude workspace fallback when no profile is bound", async () => {
    const dir = mkdtempSync(join(tmpdir(), "preview-claude-"));
    try {
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { external: { type: "sse", url: "https://example.test/mcp" } } }));
      const service = new McpConfigService({ agentsConfigPath: join(dir, "agents.yaml"), processEnv: {} });
      const claude = { ...agent, backend: "claude" as const, workspace_dir: dir, mcp_profile: undefined };
      const commands = new McpConfigCommands(service, () => {}, undefined, { tasks: { resolveNewSessionAgent: async () => ({ profile: claude, hasDbPortrait: false, fromSource: false }) },
        context: { nodeId: "test", codexMode: "app-server", isolationEnabled: true, localMcpPolicy: () => policy } });
      const result = await commands.preview({ requestId: "1", agent_id: "a" });
      expect(result.data.normal.servers).toMatchObject([{ server_id: "external", name: "external", type: "sse", included: true }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("evaluates environment templates from the display URL for isolation", async () => {
    const service = new McpConfigService({ agentsConfigPath: "/tmp/preview-agents.yaml", processEnv: { PREVIEW_HOST: "public.example" } });
    const snapshot = (url: string) => ({ registry: { servers: [{ id: "web", type: "streamable_http", url }] },
      profiles: { profiles: [{ id: "p", mcp_servers: ["web"] }] }, agent_bindings: { a: "p" } });
    await service.applyCentralSync({ revision: 1, runtime: snapshot("https://public.example/mcp"), display: snapshot("https://{{env:PREVIEW_HOST}}/mcp") });
    const commands = new McpConfigCommands(service, () => {}, undefined, { tasks: { resolveNewSessionAgent: async () => ({ profile: { ...agent, backend: "claude" }, hasDbPortrait: false, fromSource: false }) },
      context: { nodeId: "test", codexMode: "app-server", isolationEnabled: true, localMcpPolicy: () => policy } });
    const result = await commands.preview({ requestId: "1", agent_id: "a" });
    expect(result.data.restricted.servers).toContainEqual(expect.objectContaining({ server_id: "web", included: true }));
  });

  it("uses the configured default preset backend for preview", async () => {
    const service = new McpConfigService({ agentsConfigPath: "/tmp/preview-agents.yaml", processEnv: {} });
    const snapshot = { registry: { servers: [server] }, profiles: { profiles: [{ id: "p", mcp_servers: ["atom"] }] }, agent_bindings: { a: "p" } };
    await service.applyCentralSync({ revision: 1, runtime: snapshot, display: snapshot });
    const commands = new McpConfigCommands(service, () => {}, undefined, { tasks: { resolveNewSessionAgent: async () => ({ profile: { ...agent, default_preset: "fixture-preset" }, hasDbPortrait: false, fromSource: false }) },
      catalog: { resolve: () => ({ backend: "claude" }) as never },
      context: { nodeId: "test", codexMode: "sdk", isolationEnabled: true, localMcpPolicy: () => policy } });
    const result = await commands.preview({ requestId: "1", agent_id: "a" });
    expect(result.data).toMatchObject({ effective_backend: "claude", default_preset: "fixture-preset", normal: { runnable: true } });
  });

  it("dispatches the preview command through the session profile source", async () => {
    const service = new McpConfigService({ agentsConfigPath: "/tmp/preview-agents.yaml", processEnv: {} });
    const snapshot = { registry: { servers: [server] }, profiles: { profiles: [{ id: "p", mcp_servers: ["atom"] }] }, agent_bindings: { a: "p" } };
    await service.applyCentralSync({ revision: 4, runtime: snapshot, display: snapshot });
    const send = vi.fn(async (_value: unknown) => {});
    const dispatcher = new CommandDispatcher({ send, logger: pino({ enabled: false }), nodeId: "test", agentRegistry: new AgentRegistry([agent]),
      taskManager: {} as never, taskExecutor: {} as never, reflectionRuntime: { mcpConfigService: service } as never,
      agentProfileSource: { resolve: async () => ({ profile: agent, portraitSource: "yaml" }) } as never,
      mcpPreviewContext: { nodeId: "test", codexMode: "app-server", isolationEnabled: true, localMcpPolicy: () => policy } });
    await dispatcher.dispatch({ type: "preview_agent_mcp", requestId: "preview", agent_id: "a" });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "preview_agent_mcp", requestId: "preview", success: true,
      data: expect.objectContaining({ applied_revision: 4, normal: expect.objectContaining({ servers: [expect.objectContaining({ server_id: "atom", name: "catalog" })] }) }) }));
  });

  it("does not forward values from profile resolution failures", async () => {
    const service = new McpConfigService({ agentsConfigPath: "/tmp/preview-agents.yaml", processEnv: {} });
    const commands = new McpConfigCommands(service, () => {}, undefined, { tasks: { resolveNewSessionAgent: async () => { throw new Error("fake-secret-value"); } },
      context: { nodeId: "test", codexMode: "app-server", isolationEnabled: false, localMcpPolicy: () => policy } });
    await expect(commands.preview({ requestId: "1", agent_id: "a" })).rejects.toMatchObject({ code: "MCP_PREVIEW_FAILED", message: "MCP preview failed" });
  });
});

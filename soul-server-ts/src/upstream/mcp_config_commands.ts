import { z } from "zod";
import type { McpConfigService } from "../mcp_config_service.js";
import { CommandDispatchError } from "./command_family.js";
import { testMcpServer } from "../mcp_central/server_tester.js";
import { previewAgentMcp } from "../mcp_central/agent_preview.js";
import { loadMcpServers } from "../engine/claude_sdk_mcp_options.js";
import { resolveModelPresetSelection } from "../task/task_model_preset.js";
import { UnknownAgentProfileError, type TaskRuntimeCommands } from "./task_runtime_commands.js";
import type { ModelCatalog } from "../model_catalog.js";
import type { IsolationPolicy } from "../security/session_isolation_contract.js";

const SyncSchema = z.object({ type: z.literal("mcp_central_sync"), requestId: z.string().min(1),
  revision: z.number().int().nonnegative(), mode: z.never().optional(),
  runtime: z.unknown().refine((value) => value !== undefined),
  display: z.unknown().refine((value) => value !== undefined) });
const TestSchema = z.object({ requestId: z.string().min(1), timeout_ms: z.number().int().positive().max(13000).optional(),
  server: z.object({ id: z.string().min(1), name: z.string().min(1), type: z.enum(["stdio", "sse", "streamable_http"]), config: z.record(z.string(), z.unknown()) }) });
const PreviewSchema = z.object({ requestId: z.string().min(1), agent_id: z.string().min(1), mcp_profile_id: z.string().min(1).optional(),
  servers: z.array(z.object({ server_id: z.string(), name: z.string(), type: z.enum(["stdio", "sse", "streamable_http"]) }).strict()).optional() });
export type PreviewContext = { nodeId: string; codexMode: string; isolationEnabled: boolean; localMcpPolicy: () => IsolationPolicy["localMcp"] };

export class McpConfigCommands {
  constructor(private readonly service: McpConfigService | undefined,
    private readonly rebuild: (() => void) | undefined,
    private readonly previewDeps?: { tasks: Pick<TaskRuntimeCommands, "resolveNewSessionAgent">; catalog?: Pick<ModelCatalog, "resolve">; context: PreviewContext }) {}

  async sync(input: unknown) {
    if (this.service?.isPortableNode()) throw new CommandDispatchError("Portable nodes cannot receive central MCP configuration", "MCP_PORTABLE_NODE");
    const parsed = SyncSchema.safeParse(input);
    if (!parsed.success) throw new CommandDispatchError("Invalid central MCP sync request", "INVALID_MCP_CENTRAL_SYNC");
    if (!this.service || !this.rebuild) throw new CommandDispatchError("MCP configuration service unavailable");
    try {
      await this.service.applyCentralSync(parsed.data);
    } catch {
      // Payload validation errors can contain values: never forward or log them.
      throw new CommandDispatchError("Invalid central MCP configuration or marker write failed", "INVALID_MCP_CENTRAL_SYNC");
    }
    this.rebuild();
    return { type: "mcp_central_sync", requestId: parsed.data.requestId, success: true,
      data: { applied_revision: parsed.data.revision } };
  }

  async test(input: unknown) {
    if (this.service?.isPortableNode()) throw new CommandDispatchError("Portable nodes cannot receive central MCP configuration", "MCP_PORTABLE_NODE");
    const parsed = TestSchema.safeParse(input);
    if (!parsed.success) throw new CommandDispatchError("Invalid MCP test request", "MCP_INVALID_INPUT");
    if (!this.service) throw new CommandDispatchError("MCP configuration service unavailable");
    const data = await testMcpServer(parsed.data.server, this.service.testEnvironment(), parsed.data.timeout_ms);
    return { type: "test_mcp_server", requestId: parsed.data.requestId, success: true, data };
  }

  async preview(input: unknown) {
    if (this.service?.isPortableNode()) throw new CommandDispatchError("Portable nodes cannot receive central MCP configuration", "MCP_PORTABLE_NODE");
    const parsed = PreviewSchema.safeParse(input);
    if (!parsed.success) throw new CommandDispatchError("Invalid MCP preview request", "MCP_INVALID_INPUT");
    if (!this.service || !this.previewDeps) throw new CommandDispatchError("MCP preview unavailable");
    let agent;
    try { agent = (await this.previewDeps.tasks.resolveNewSessionAgent(parsed.data.agent_id)).profile; }
    catch (error) {
      if (error instanceof UnknownAgentProfileError) throw new CommandDispatchError("Agent not found", "MCP_AGENT_NOT_FOUND");
      throw error;
    }
    const preset = resolveModelPresetSelection({}, agent, this.previewDeps.catalog);
    const profileId = parsed.data.mcp_profile_id ?? this.service.effectiveAgentMcpProfileId(agent);
    const registry = this.service.listRegistry().servers;
    const profile = this.service.listProfiles().profiles.find(item => item.id === profileId);
    const ids = parsed.data.mcp_profile_id ? parsed.data.servers?.map(server => server.server_id) ?? []
      : Array.isArray(profile?.mcp_servers) ? profile.mcp_servers as string[] : [];
    let servers = ids.flatMap(id => {
      const entry = registry.find(item => item.id === id);
      if (!entry || typeof entry.type !== "string") return [];
      const virtual = parsed.data.servers?.find(item => item.server_id === id);
      return [{ ...entry, id, name: virtual?.name ?? (typeof entry.name === "string" ? entry.name : id), type: virtual?.type ?? entry.type }];
    });
    if (profileId === undefined && (preset?.backend ?? agent.backend) === "claude") {
      const fallback = loadMcpServers(agent.workspace_dir, { debug() {} }) ?? {};
      servers = Object.entries(fallback).flatMap(([name, config]) => {
        if (!config || typeof config !== "object") return [];
        const kind = "type" in config ? config.type : "stdio";
        const type = kind === "http" ? "streamable_http" : kind ?? "stdio";
        if (type !== "streamable_http" && type !== "stdio" && type !== "sse") return [];
        return [{ ...config, id: name, name, type }];
      });
    }
    const status = this.service.configStatus();
    const context = this.previewDeps.context;
    const data = previewAgentMcp({ agent, mode: status.mode, revision: status.revision, profileId,
      servers, backend: preset?.backend, defaultPreset: agent.default_preset, allowlist: preset?.mcp_tool_allowlist?.[agent.id],
      codexMode: context.codexMode, isolationEnabled: context.isolationEnabled, nodeId: context.nodeId, localMcpPolicy: context.localMcpPolicy() });
    return { type: "preview_agent_mcp", requestId: parsed.data.requestId, success: true, data };
  }

}

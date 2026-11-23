import { z } from "zod";
import { readAgentsConfig } from "../agent_registry.js";
import type { McpConfigService } from "../mcp_config_service.js";
import { CommandDispatchError } from "./command_family.js";

const SyncSchema = z.discriminatedUnion("mode", [
  z.object({ type: z.literal("mcp_central_sync"), requestId: z.string().min(1), revision: z.number().int().nonnegative(), mode: z.literal("central"), runtime: z.unknown().refine((value) => value !== undefined), display: z.unknown().refine((value) => value !== undefined) }),
  z.object({ type: z.literal("mcp_central_sync"), requestId: z.string().min(1), revision: z.number().int().nonnegative(), mode: z.literal("local"), runtime: z.never().optional(), display: z.never().optional() }),
]);
const ExportSchema = z.object({ type: z.literal("mcp_local_export"), requestId: z.string().min(1) });

export class McpConfigCommands {
  constructor(private readonly service: McpConfigService | undefined,
    private readonly agentsConfigPath: string | undefined,
    private readonly rebuild: (() => void) | undefined) {}

  async sync(input: unknown) {
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
      data: { applied_mode: parsed.data.mode, applied_revision: parsed.data.revision } };
  }

  export(input: unknown) {
    const parsed = ExportSchema.safeParse(input);
    if (!parsed.success) throw new CommandDispatchError("Invalid local MCP export request", "INVALID_MCP_LOCAL_EXPORT");
    if (!this.service || !this.agentsConfigPath) throw new CommandDispatchError("MCP configuration service unavailable");
    if (this.service.configStatus().mode === "central") throw new CommandDispatchError("Central MCP configuration is active", "MCP_NODE_CENTRAL_ACTIVE");
    const agent_mcp_profiles = Object.fromEntries(readAgentsConfig(this.agentsConfigPath).agents
      .filter((agent) => agent.mcp_profile).map((agent) => [agent.id, agent.mcp_profile]));
    return { type: "mcp_local_export", requestId: parsed.data.requestId, success: true,
      data: { ...this.service.exportLocal(), agent_mcp_profiles } };
  }
}

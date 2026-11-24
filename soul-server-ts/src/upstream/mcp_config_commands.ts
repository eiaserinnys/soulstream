import { z } from "zod";
import type { McpConfigService } from "../mcp_config_service.js";
import { CommandDispatchError } from "./command_family.js";
import { testMcpServer } from "../mcp_central/server_tester.js";

const SyncSchema = z.object({ type: z.literal("mcp_central_sync"), requestId: z.string().min(1),
  revision: z.number().int().nonnegative(), mode: z.never().optional(),
  runtime: z.unknown().refine((value) => value !== undefined),
  display: z.unknown().refine((value) => value !== undefined) });
const TestSchema = z.object({ requestId: z.string().min(1), timeout_ms: z.number().int().positive().max(13000).optional(),
  server: z.object({ id: z.string().min(1), name: z.string().min(1), type: z.enum(["stdio", "sse", "streamable_http"]), config: z.record(z.string(), z.unknown()) }) });

export class McpConfigCommands {
  constructor(private readonly service: McpConfigService | undefined,
    private readonly rebuild: (() => void) | undefined) {}

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

}

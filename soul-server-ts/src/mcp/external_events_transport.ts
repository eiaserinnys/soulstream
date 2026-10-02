import type { FastifyInstance } from "fastify";
import { createMcpHandler, Server, ProtocolError, type ListToolsResult, type CallToolResult } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { eventDefinition, subscribeSchema, identitySchema } from "../external_events/contracts.js";
import { checkMcpAuth } from "./auth.js";
import { buildMcpServer } from "./server.js";
import { guardMcpToolCallRequest } from "./tool_access.js";
import { withMcpRequestContext } from "./request_context.js";
import type { McpRuntime } from "./runtime.js";
import type { McpRouteConfig } from "./transport.js";

/** Official MCP2 serving entry, confined to the credential-bound external route. */
export function registerExternalEventsRoutes(app: FastifyInstance, runtime: McpRuntime, config: McpRouteConfig) {
  const service = runtime.externalEvents;
  if (!service || config.principal?.authority !== "external" || !config.auth.requireAuth) {
    throw new Error("External Events require an authenticated dedicated external ingress");
  }
  const context = { principal: config.principal };
  async function legacy<T>(action: (client: Client) => Promise<T>): Promise<T> {
    return withMcpRequestContext(context, async () => {
      const server = buildMcpServer(runtime);
      const client = new Client({ name: "external-events-tool-bridge", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport); await client.connect(clientTransport);
        return await action(client);
      } catch (error) {
        if (error instanceof McpError) throw new ProtocolError(error.code, error.message);
        throw error;
      } finally { await client.close(); await server.close(); }
    });
  }
  const handler = createMcpHandler(({ era }) => {
    // Events is an extension capability. SDK2's wire preserves it; its legacy
    // capability typings/client convenience getter currently omit this field.
    const capabilities = { tools: {}, ...(era === "modern" ? { events: {} } : {}) };
    const server = new Server({ name: "soul-server-ts", version: "0.0.1" }, { capabilities });
    server.setRequestHandler("tools/list", async request => {
      // SDK1 declares JSON Schema properties as object, SDK2 as JSONValue.
      // Both endpoints exchange the same JSON schema; registrations stay in SDK1.
      return await legacy(client => client.listTools(request.params)) as unknown as ListToolsResult;
    });
    server.setRequestHandler("tools/call", async request => {
      const blocked = withMcpRequestContext(context, () => guardMcpToolCallRequest(runtime, request));
      if (blocked) return blocked as CallToolResult;
      return legacy(async client => {
        const tools = await client.listTools();
        const tool = tools.tools.find(tool => tool.name === request.params.name);
        const result = CallToolResultSchema.parse(await client.callTool(request.params));
        return server.projectCallToolResult(result as CallToolResult, tool?.outputSchema);
      });
    });
    if (era === "modern") {
      server.setRequestHandler("events/list", { params: z.object({ cursor: z.string().optional() }) }, async () => ({ events: [eventDefinition] }));
      server.setRequestHandler("events/subscribe", { params: subscribeSchema }, async params => {
        try { return await service.subscribe(params); }
        catch { throw new ProtocolError(-32015, "Callback verification or subscription storage failed", { reason: "challenge_failed" }); }
      });
      server.setRequestHandler("events/unsubscribe", { params: identitySchema }, params => service.unsubscribe(params));
    }
    return server;
  });
  const nodeHandler = toNodeHandler(handler);
  app.route({ method: ["POST", "GET", "DELETE"], url: config.path, handler: async (request, reply) => {
    const auth = checkMcpAuth(config.auth, request.headers);
    if (!auth.ok) return reply.code(auth.status ?? 401).send({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } });
    reply.hijack();
    await withMcpRequestContext(context, () => nodeHandler(request.raw, reply.raw, request.body));
  } });
  return () => handler.close();
}

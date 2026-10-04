import { AsyncLocalStorage } from "node:async_hooks";
import { credentialOwner } from "../external_events/service.js";
import { OwnedAgentError } from "../owned-agents/types.js";
import type { FastifyInstance } from "fastify";
import { createMcpHandler, Server, ProtocolError, type ListToolsResult, type CallToolResult } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { checkMcpAuth, type McpAuthConfig } from "@soulstream/mcp-contract";
import { eventDefinition, subscribeSchema, identitySchema } from "../external_events/contracts.js";
import { buildExternalMcpServer, guardExternalToolCall } from "./external_ingress_server.js";
import { resolveMcpExecutionOptions } from "./mcp_host_routes.js";
import type { McpCallContext, McpHostOptions } from "./types.js";

export interface ExternalIngressConfig {
  path: string;
  nodeId: string;
  source: string;
  displayName: string;
  auth: McpAuthConfig;
  ownedAgents?: import("../owned-agents/service.js").OwnedAgentService;
}

/** Dedicated credential-bound endpoint; worker forward bodies cannot supply this identity. */
export function registerExternalEventsRoutes(app: FastifyInstance, options: McpHostOptions, config: ExternalIngressConfig) {
  if (!config.auth.requireAuth) throw new Error("External Events require an authenticated dedicated external ingress");
  const executionOptions = resolveMcpExecutionOptions(app, options);
  const service = options.externalLlm?.service;
  const requestScope = new AsyncLocalStorage<{ context: McpCallContext; eventsOwner: string }>();
  const baseContext: McpCallContext = {
    principal: "external", callerSessionId: null, nodeId: config.nodeId,
    externalCaller: { source: config.source, displayName: config.displayName },
    callerInfo: { source: config.source, agent_node: config.nodeId, display_name: config.displayName, user_id: null, avatar_url: null },
  };
  async function legacy<T>(action: (client: Client) => Promise<T>): Promise<T> {
    const server = buildExternalMcpServer(executionOptions, requestScope.getStore()!.context);
    const client = new Client({ name: "external-events-canonical-bridge", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      return await action(client);
    } catch (error) {
      if (error instanceof McpError) throw new ProtocolError(error.code, error.message);
      throw error;
    } finally { await client.close(); await server.close(); }
  }
  const handler = createMcpHandler(({ era }) => {
    const capabilities = { tools: {}, resources: {}, ...(era === "modern" && service ? { events: {} } : {}) };
    const server = new Server({ name: "soul-server-ts", version: "0.0.1" }, { capabilities });
    server.setRequestHandler("tools/list", async request => await legacy(client => client.listTools(request.params)) as unknown as ListToolsResult);
    server.setRequestHandler("tools/call", async request => {
      const blocked = guardExternalToolCall(request.params.name, request.params.arguments);
      if (blocked) return blocked as CallToolResult;
      return legacy(async client => {
        const tools = await client.listTools();
        const tool = tools.tools.find(tool => tool.name === request.params.name);
        const result = CallToolResultSchema.parse(await client.callTool(request.params));
        return server.projectCallToolResult(result as CallToolResult, tool?.outputSchema);
      });
    });
    server.setRequestHandler("resources/list", request => legacy(client => client.listResources(request.params)));
    server.setRequestHandler("resources/read", request => legacy(client => client.readResource(request.params)));
    server.setRequestHandler("resources/templates/list", request => legacy(client => client.listResourceTemplates(request.params)));
    if (era === "modern" && service) {
      server.setRequestHandler("events/list", { params: z.object({ cursor: z.string().optional() }) }, async () => ({ events: [eventDefinition] }));
      server.setRequestHandler("events/subscribe", { params: subscribeSchema }, async params => {
        try { return await service.scoped(requestScope.getStore()!.eventsOwner).subscribe(params); }
        catch { throw new ProtocolError(-32015, "Callback verification or subscription storage failed", { reason: "challenge_failed" }); }
      });
      server.setRequestHandler("events/unsubscribe", { params: identitySchema }, params => service.scoped(requestScope.getStore()!.eventsOwner).unsubscribe(params));
    }
    return server;
  });
  const nodeHandler = toNodeHandler(handler);
  app.route({ method: ["POST", "GET", "DELETE"], url: config.path, handler: async (request, reply) => {
    let ownedAgent: McpCallContext["ownedAgent"];
    const authorization = request.headers.authorization;
    const token = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    try {
      // Check Host separately: central credentials need not match the legacy configured token.
      const auth = checkMcpAuth({ ...config.auth, bearerToken: token || config.auth.bearerToken }, request.headers);
      if (!auth.ok || !token) throw new OwnedAgentError(auth.status ?? 401, "Unauthorized");
      if (config.ownedAgents) ownedAgent = await config.ownedAgents.authenticate(token) ?? undefined;
      else if (!checkMcpAuth(config.auth, request.headers).ok) throw new OwnedAgentError(401, "Unauthorized");
    } catch (error) {
      const status = error instanceof OwnedAgentError ? error.statusCode : 503;
      return reply.code(status).send({ jsonrpc: "2.0", id: null, error: { code: -32001,
        message: status === 503 ? "Credential verification temporarily unavailable" : "Unauthorized" } });
    }
    const context: McpCallContext = ownedAgent ? { ...baseContext, ownedAgent,
      callerInfo: { ...baseContext.callerInfo, agent_id: ownedAgent.agentId, external_agent_id: ownedAgent.agentId,
        email: ownedAgent.ownerEmail, user_id: ownedAgent.ownerEmail } } : baseContext;
    reply.hijack();
    await requestScope.run({ context, eventsOwner: credentialOwner(config.path, token) },
      () => nodeHandler(request.raw, reply.raw, request.body));
  } });
  return () => handler.close();
}

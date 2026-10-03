import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerExternalLlmTools } from "../../soul-server-ts/src/mcp/tools/external_llm.js";
import { withMcpRequestContext } from "../../soul-server-ts/src/mcp/request_context.js";
import type { McpRuntime } from "../../soul-server-ts/src/mcp/runtime.js";
import { registerMcpHostRoutes } from "../src/mcp/mcp_host_routes.js";
import { executeMcpTool } from "../src/mcp/tool_executor.js";
import { unusedClusterDependencies } from "./mcp-cluster-unused-fixture.js";

// Old host request schema at 288401c7. The rolling-update contract keeps this field.
const oldRequestSchema = z.object({
  args: z.record(z.string(), z.unknown()),
  context: z.object({ principal: z.enum(["internal", "external"]), caller_session_id: z.string().nullable(), node_id: z.string().min(1),
    callerInfo: z.record(z.string(), z.unknown()).optional(),
    execution: z.object({ registrationId: z.string().min(1), executionCommandId: z.string().min(1) }).strict().optional() }),
});
const oldWorkerBody = { args: {}, context: { principal: "internal", caller_session_id: "sender", node_id: "worker" } };
afterEach(() => vi.unstubAllGlobals());

it("accepts a new worker forward at the old host and an old worker body at the new host", async () => {
  const options = { ...unusedClusterDependencies, authBearerToken: "test-host", board: undefined as never,
    cards: undefined as never, folders: undefined as never, externalLlm: { getSession: async () => ({}) } };
  const server = new McpServer({ name: "worker-version-compat", version: "test" });
  registerExternalLlmTools(server, { nodeId: "worker", orch: { baseUrl: "http://orch.test", headers: { authorization: "Bearer test-host" } } } as unknown as McpRuntime);
  const client = new Client({ name: "compat", version: "test" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const app = Fastify();
  registerMcpHostRoutes(app, options);
  let forwarded: unknown;
  vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
    forwarded = JSON.parse(init.body as string);
    const oldAccepted = oldRequestSchema.parse(forwarded);
    const result = await executeMcpTool(options, "list_external_llm_recipients", oldAccepted.args, {
      principal: oldAccepted.context.principal, callerSessionId: oldAccepted.context.caller_session_id, nodeId: oldAccepted.context.node_id,
    });
    return new Response(JSON.stringify(result));
  }));
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await withMcpRequestContext({ callerSessionId: "sender" }, () => client.callTool({ name: "list_external_llm_recipients", arguments: {} }));
    expect(forwarded).toEqual(oldWorkerBody);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ recipients: [] });
    const response = await app.inject({ method: "POST", url: "/api/mcp/host/list_external_llm_recipients",
      headers: { authorization: "Bearer test-host" }, payload: oldWorkerBody });
    expect(response.statusCode).toBe(200);
    expect(response.json().structuredContent).toEqual({ recipients: [] });
  } finally {
    await client.close(); await server.close(); await app.close();
  }
});

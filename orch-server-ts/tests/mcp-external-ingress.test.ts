import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from "@modelcontextprotocol/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mcpToolDefinitions, LIVE_CARD_RESOURCE } from "@soulstream/mcp-contract";
import inventory from "./fixtures/mcp_external_tool_inventory.json" with { type: "json" };
import { widgetHtml } from "../../plugins/chatgpt-card-renderer/src/widget-html.js";
import { registerExternalEventsRoutes } from "../src/mcp/external_events_transport.js";
import * as executor from "../src/mcp/tool_executor.js";
import type { McpHostOptions } from "../src/mcp/types.js";
import { createApp } from "../src/app.js";
import { parseOrchServerConfig } from "../src/config.js";
import { ExternalEventsService, credentialOwner } from "../src/external_events/service.js";
import { unusedClusterDependencies } from "./mcp-cluster-unused-fixture.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const ingress = { path: "/dot", nodeId: "test-node", source: "dot", displayName: "Dot ingress",
  auth: { requireAuth: true, bearerToken: "test-dot", allowedHosts: [] as string[] } };
async function web(options = {} as McpHostOptions, config = ingress as import("../src/mcp/external_events_transport.js").ExternalIngressConfig) {
  const app = Fastify();
  const close = registerExternalEventsRoutes(app, options, config);
  await app.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(async () => { await close(); await app.close(); });
  const address = app.server.address(); if (!address || typeof address === "string") throw new Error("No TCP port");
  return { app, url: new URL(`http://127.0.0.1:${address.port}/dot`) };
}
function connect(era: "modern", url: URL): Promise<ModernClient>;
function connect(era: "legacy", url: URL): Promise<Client>;
function connect(era: "modern" | "legacy", url: URL): Promise<Client | ModernClient>;
async function connect(era: "modern" | "legacy", url: URL) {
  const client = era === "modern"
    ? new ModernClient({ name: "orch-dot-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } })
    : new Client({ name: "orch-dot-test", version: "1" });
  const options = { requestInit: { headers: { Authorization: "Bearer test-dot", "x-soulstream-agent-session-id": "forged" } } };
  await client.connect(era === "modern" ? new ModernTransport(url, options) : new StreamableHTTPClientTransport(url, options));
  cleanup.push(() => client.close()); return client;
}
function assertInventory(tools: { name: string }[], era: "modern" | "legacy" = "legacy") {
  const definitions = mcpToolDefinitions.filter(d => d.audience === "all");
  expect(tools).toHaveLength(63);
  expect(tools.map(t => t.name)).toEqual(definitions.map(d => d.name));
  expect(tools.map(t => t.name).sort()).toEqual(inventory.map(t => t.name));
  expect(inventory).toHaveLength(63);
  for (const tool of tools) {
    const expected = inventory.find(t => t.name === tool.name)!;
    // SDK2 modern list projection omits SDK1 execution.taskSupport. Compare every
    // field required by the brief; legacy retains and compares the whole item.
    const { execution: _execution, ...modernExpected } = expected as typeof expected & { execution?: unknown };
    expect(tool).toEqual(era === "modern" ? modernExpected : expected);
  }
}
describe("orchestrator dedicated external MCP ingress", () => {
  it("is absent by default", async () => {
    const app = createApp({ config: parseOrchServerConfig({ environment: "test", databaseUrl: "unused", authBearerToken: "test" }) });
    cleanup.push(() => app.close());
    expect((await app.inject({ method: "POST", url: "/dot", payload: {} })).statusCode).toBe(404);
  });
  it("uses dedicated auth through the real app and leaves dashboard auth intact", async () => {
    const resolveTokenAccess = vi.fn(async () => ({ ok: false as const, statusCode: 401, detail: "dashboard rejected" }));
    const app = createApp({ config: parseOrchServerConfig({ environment: "test", databaseUrl: "unused", authBearerToken: "internal" }),
      productionAuth: { resolveTokenAccess }, externalIngress: ingress,
      mcpHostRoutes: { ...unusedClusterDependencies, board: undefined as never, cards: undefined as never,
        cluster: { ...unusedClusterDependencies.cluster, readSession: async () => null },
        folders: undefined as never, authBearerToken: "internal" },
    });
    cleanup.push(() => app.close());
    const denied = await app.inject({ method: "POST", url: "/dot", payload: {}, headers: { authorization: "Bearer wrong" } });
    expect(denied.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } });
    expect(resolveTokenAccess).not.toHaveBeenCalled();
    await app.inject({ method: "POST", url: "/api/mcp/host/get_folder", payload: {} });
    expect(resolveTokenAccess).toHaveBeenCalledTimes(1);
  });
  it.each(["modern", "legacy"] as const)("%s preserves every public definition and live resource", async era => {
    const { url } = await web(); const client = await connect(era, url);
    const { tools } = await client.listTools(); assertInventory(tools, era);
    expect(tools.some(t => t.name === "send_to_external_llm")).toBe(false);
    expect((await client.listResources()).resources).toEqual(expect.arrayContaining([expect.objectContaining({ uri: LIVE_CARD_RESOURCE })]));
    expect(await client.readResource({ uri: LIVE_CARD_RESOURCE })).toMatchObject({ contents: [{ uri: LIVE_CARD_RESOURCE,
      mimeType: "text/html;profile=mcp-app", text: widgetHtml,
      _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } } }] });
    expect(await client.listResourceTemplates()).toMatchObject({ resourceTemplates: [] });
    await expect(client.readResource({ uri: "ui://missing" })).rejects.toMatchObject({ code: -32602 });
  });
  it("resolves the same lazy board service for real external and internal tool execution", async () => {
    const document = { id: "document", title: "문서", body: "본문", version: 1 };
    const getMarkdownDocument = vi.fn(async () => document);
    const createService = vi.fn(() => ({}));
    const app = createApp({ config: parseOrchServerConfig({ environment: "test", databaseUrl: "unused", authBearerToken: "internal" }),
      externalIngress: ingress,
      mcpHostRoutes: { ...unusedClusterDependencies, authBearerToken: "internal",
        cluster: { ...unusedClusterDependencies.cluster, readSession: async () => null },
        board: { host: { authBearerToken: "internal", createService, projectionHost: { getMarkdownDocument } } },
      } as unknown as McpHostOptions,
    });
    cleanup.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address(); if (!address || typeof address === "string") throw new Error("No TCP port");
    const client = await connect("modern", new URL(`http://127.0.0.1:${address.port}/dot`));
    expect(await client.callTool({ name: "get_markdown_document", arguments: { document_id: "document" } })).toMatchObject({ structuredContent: document });
    const internal = await app.inject({ method: "POST", url: "/api/mcp/host/get_markdown_document", headers: { authorization: "Bearer internal" },
      payload: { args: { document_id: "document" }, context: { principal: "internal", caller_session_id: "session", node_id: "other-node" } } });
    expect(internal.json()).toMatchObject({ structuredContent: document });
    expect(createService).toHaveBeenCalledTimes(1);
    expect(getMarkdownDocument).toHaveBeenCalledTimes(2);
  });
  it("detects a changed description in the inventory comparator", async () => {
    const { url } = await web(); const client = await connect("legacy", url);
    const { tools } = await client.listTools();
    expect(() => assertInventory([{ ...tools[0]!, description: "changed" }, ...tools.slice(1)])).toThrow();
  });
  it("executes with only ingress-owned external identity and blocks destructive calls", async () => {
    const execute = vi.spyOn(executor, "executeMcpTool").mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const { url } = await web(); const client = await connect("modern", url);
    await client.callTool({ name: "get_folder", arguments: { folder_id: "folder", caller_session_id: "forged" } });
    expect(execute).toHaveBeenCalledWith(expect.anything(), "get_folder", expect.anything(), {
      principal: "external", callerSessionId: null, nodeId: "test-node", externalCaller: { source: "dot", displayName: "Dot ingress" },
      callerInfo: { source: "dot", display_name: "Dot ingress", agent_node: "test-node", user_id: null, avatar_url: null } });
    execute.mockClear();
    expect(await client.callTool({ name: "batch_page_operations", arguments: { page_id: "seed", expected_version: 1, idempotency_key: "batch-key", operations: [{ op: "delete_block_subtree", block_id: "seed-block" }] } })).toMatchObject({ isError: true,
      content: [{ type: "text", text: 'MCP tool "batch_page_operations" is not available to external LLM callers' }] });
    expect(await client.callTool({ name: "send_to_external_llm", arguments: { recipient_id: "recipient", text: "hello" } })).toMatchObject({ isError: true });
    expect(execute).not.toHaveBeenCalled();
  });
  it("rejects every internal-only definition before execution", async () => {
    const execute = vi.spyOn(executor, "executeMcpTool");
    const { url } = await web(); const client = await connect("modern", url);
    const { tools } = await client.listTools();
    for (const definition of mcpToolDefinitions.filter(d => d.audience === "internal")) {
      expect(tools.some(t => t.name === definition.name), definition.name).toBe(false);
      const result = await client.callTool({ name: definition.name, arguments: {} });
      expect(result, definition.name).toMatchObject({ isError: true, content: [{ type: "text", text: `MCP error -32602: Tool ${definition.name} not found` }] });
      expect(execute, definition.name).not.toHaveBeenCalled();
    }
  });
  it("modern Events subscribe, internal list/send, unsubscribe share one store; legacy has no Events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-dot-wire-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const post = vi.fn(async (_url: string, body: string) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }));
    const service = await ExternalEventsService.open({ path: join(dir, "state.json"), owner: credentialOwner(ingress.path, ingress.auth.bearerToken), post });
    const options = { externalLlm: { service, getSession: async () => ({}) } } as unknown as McpHostOptions;
    const { url } = await web(options); const client = await connect("modern", url);
    const resultSchema = z.object({}).passthrough();
    const subscription = { name: "soulstream.message.created", arguments: { recipient_label: "Dot" },
      delivery: { mode: "webhook", url: "https://receiver.example/events", secret: `whsec_${Buffer.alloc(32, 8).toString("base64")}` } };
    expect(await client.request({ method: "events/list", params: {} }, resultSchema)).toMatchObject({ events: [{ name: subscription.name }] });
    const created = await client.request({ method: "events/subscribe", params: subscription }, resultSchema);
    const context = { principal: "internal" as const, callerSessionId: "sender", nodeId: "other-node" };
    expect(await executor.executeMcpTool(options, "list_external_llm_recipients", {}, context)).toMatchObject({ structuredContent: { recipients: [{ recipient_id: created.id }] } });
    expect(await executor.executeMcpTool(options, "send_to_external_llm", { recipient_id: created.id, text: "hello" }, context)).toMatchObject({ structuredContent: { status: "accepted_by_receiver" } });
    await client.request({ method: "events/unsubscribe", params: subscription }, resultSchema);
    expect(service.recipients()).toEqual([]);
    const legacy = await connect("legacy", url);
    await expect(legacy.request({ method: "events/list", params: {} }, resultSchema)).rejects.toThrow();
    post.mockResolvedValue({ status: 500, body: "{}" });
    await expect(client.request({ method: "events/subscribe", params: subscription }, resultSchema)).rejects.toMatchObject({ code: -32015 });
  });
  it.each([["test-dot", "wrong.example", 403], ["wrong", "localhost", 401]] as const)("preserves auth failure (%s %s)", async (token, host, status) => {
    const app = Fastify(); const close = registerExternalEventsRoutes(app, {} as McpHostOptions, { ...ingress, auth: { ...ingress.auth, allowedHosts: ["localhost"] } });
    cleanup.push(async () => { await close(); await app.close(); });
    const response = await app.inject({ method: "POST", url: "/dot", headers: { authorization: `Bearer ${token}`, host }, payload: {} });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } });
  });
  it("modern request-scoped Events retain registered dot ids and isolate new key subscriptions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owned-dot-events-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const post = vi.fn(async (_url: string, body: string) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }));
    const service = await ExternalEventsService.open({ path: join(dir, "state.json"), owner: credentialOwner(ingress.path, ingress.auth.bearerToken), post });
    const subscription = { name: "soulstream.message.created", arguments: { recipient_label: "Dot" },
      delivery: { mode: "webhook", url: "https://receiver.example/events", secret: `whsec_${Buffer.alloc(32, 8).toString("base64")}` } };
    const legacy = await service.subscribe(subscription);
    const ownedAgents = { authenticate: async (token: string) => ({ agentId: token === "test-dot" ? "dot" : "new-agent", credentialId: "credential", ownerEmail: "person@example.test" }) } as never;
    const { url } = await web({ externalLlm: { service, getSession: async () => ({}) } } as unknown as McpHostOptions, { ...ingress, ownedAgents });
    const dot = await connect("modern", url);
    const peer = new ModernClient({ name: "peer", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await peer.connect(new ModernTransport(url, { requestInit: { headers: { authorization: "Bearer new-test-key" } } })); cleanup.push(() => peer.close());
    const result = z.object({}).passthrough();
    expect((await dot.request({ method: "events/subscribe", params: subscription }, result)).id).toBe(legacy.id);
    await peer.request({ method: "events/unsubscribe", params: subscription }, result);
    expect(service.recipients()[0]!.recipient_id).toBe(legacy.id);
    const created = await peer.request({ method: "events/subscribe", params: subscription }, result);
    expect(created.id).not.toBe(legacy.id);
    expect(service.allRecipients()).toHaveLength(2);
    await peer.request({ method: "events/unsubscribe", params: subscription }, result);
    expect(service.allRecipients().map(r => r.recipient_id)).toEqual([legacy.id]);
  });
});

// The retired worker SDK rejected this exact baseline before forwarding.
it("keeps the old external batch delete input rejected by the executor", async () => {
  const result = await executor.executeMcpTool({} as never, "batch_page_operations", {
    page_id: "seed", expected_version: 1, idempotency_key: "batch-key", operations: [{ op: "delete_block_subtree", block_id: "seed-block" }],
  }, { principal: "external", callerSessionId: null, nodeId: "test-node" });
  expect(result.isError).toBe(true);
});

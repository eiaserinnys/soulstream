import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from "@modelcontextprotocol/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildServer } from "../../src/server.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import * as canonicalServer from "../../src/mcp/server.js";
import { LIVE_CARD_RESOURCE } from "../../src/mcp/tools/live_card_view.js";
import { widgetHtml } from "../../../plugins/chatgpt-card-renderer/src/widget-html.js";
import { AgentRegistry } from "../../src/agent_registry.js";
import { ExternalEventsService, credentialOwner } from "../../src/external_events/service.js";
import { withMcpRequestContext, INTERNAL_MCP_PRINCIPAL } from "../../src/mcp/request_context.js";
import { parseEnv } from "../../src/config.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";

const secret = `whsec_${Buffer.alloc(32, 8).toString("base64")}`;
const subscription = { name: "soulstream.message.created", arguments: { recipient_label: "primary-dot" },
  delivery: { mode: "webhook", url: "https://receiver.example/events", secret } };
const cleanup: (() => Promise<unknown>)[] = [];
const canonicalBuildMcpServer = buildMcpServer;
async function expectLiveCards(client: Client | ModernClient) {
  expect((await client.listResources()).resources).toEqual(expect.arrayContaining([
    expect.objectContaining({ uri: LIVE_CARD_RESOURCE }),
  ]));
  expect(await client.readResource({ uri: LIVE_CARD_RESOURCE })).toMatchObject({ contents: [{
    uri: LIVE_CARD_RESOURCE, mimeType: "text/html;profile=mcp-app", text: widgetHtml,
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
  }] });
  expect((await client.listTools()).tools).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "show_live_card_view", _meta: {
      ui: { resourceUri: LIVE_CARD_RESOURCE }, "openai/outputTemplate": LIVE_CARD_RESOURCE,
    } }),
    expect.objectContaining({ name: "list_live_cards", _meta: {
      ui: { visibility: ["app", "model"] }, "openai/widgetAccessible": true,
    } }),
  ]));
}
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function runtime() {
  const dir = await mkdtemp(join(tmpdir(), "mcp-events-wire-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const post = vi.fn(async (_url: string, body: string) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }));
  return {
    nodeId: "test-node", agentsConfigPath: "unused",
    db: { getSession: vi.fn(async (id: string) => id === "real-session" ? { agent_session_id: id } : null) },
    agentRegistry: new AgentRegistry([]), taskManager: { listTasks: () => [] }, logger: pino({ level: "silent" }),
    externalEvents: await ExternalEventsService.open({ path: join(dir, "private", "state.json"), owner: credentialOwner("/dot", "dot-token"), post }),
  } as unknown as McpRuntime;
}
async function web() {
  const rt = await runtime();
  const app = await buildServer({ host: "127.0.0.1", port: 0, nodeId: rt.nodeId, logger: rt.logger,
    mcp: { runtime: rt, path: "/mcp", auth: { requireAuth: true, bearerToken: "internal-token", allowedHosts: [] }, statelessTransport: true,
      externalIngress: { path: "/dot", source: "dot", displayName: "Dot ingress", auth: { requireAuth: true, bearerToken: "dot-token", allowedHosts: [] } } } });
  await app.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(async () => { await app.closeMcp?.(); await app.close(); await app.internalMcpServer?.close(); });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("No TCP port");
  return { rt, base: `http://127.0.0.1:${address.port}` };
}
describe("dedicated MCP2 ingress with SDK1 canonical tool bridge", () => {
  it.each(["modern", "legacy"] as const)("%s preserves canonical resources, templates and UI metadata", async era => {
    const uri = "ui://test-fixtures/external-events/cards.html";
    const ui = { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } };
    // Keep the fixture distinct from the real resource; both use the canonical
    // SDK1 registry and the same bridge.
    const factory = vi.spyOn(canonicalServer, "buildMcpServer").mockImplementation(runtime => {
      const server = canonicalBuildMcpServer(runtime);
      server.registerResource("live-card-fixture", uri, { _meta: { ui } }, async () => ({
        contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: "<html>cards</html>", _meta: { ui } }],
      }));
      server.registerResource("card-template-fixture", new ResourceTemplate("ui://soulstream/cards/{name}", { list: undefined }),
        { _meta: { ui } }, async templateUri => ({ contents: [{ uri: templateUri.href, text: "template cards", _meta: { ui } }] }));
      return server;
    });
    cleanup.push(async () => { factory.mockRestore(); });
    const { base } = await web();
    const client = era === "modern"
      ? new ModernClient({ name: "resource-wire", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } })
      : new Client({ name: "resource-wire", version: "1" });
    const options = { requestInit: { headers: { Authorization: "Bearer dot-token" } } };
    const url = new URL(`${base}/dot`);
    await client.connect(era === "modern" ? new ModernTransport(url, options) : new StreamableHTTPClientTransport(url, options));
    cleanup.push(() => client.close());
    expect(client.getServerCapabilities()).toMatchObject({ resources: {} });
    await expectLiveCards(client);
    expect((await client.listResources()).resources).toEqual(expect.arrayContaining([expect.objectContaining({ uri, _meta: { ui } })]));
    expect(await client.readResource({ uri })).toMatchObject({ contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: "<html>cards</html>", _meta: { ui } }] });
    expect(await client.listResourceTemplates()).toMatchObject({ resourceTemplates: [{ uriTemplate: "ui://soulstream/cards/{name}", _meta: { ui } }] });
    expect(await client.readResource({ uri: "ui://soulstream/cards/test" })).toMatchObject({ contents: [{ text: "template cards", _meta: { ui } }] });
  });
  it("real pinned MCP2 client discovers and round-trips tools and Events", async () => {
    const { rt, base } = await web(); const responses: Record<string, unknown>[] = [];
    const client = new ModernClient({ name: "wire-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(new ModernTransport(new URL(`${base}/dot`), {
      requestInit: { headers: { Authorization: "Bearer dot-token", "x-soulstream-agent-session-id": "forged-session" } },
      fetch: async (url, init) => { const result = await fetch(url, init); const copy = await result.clone().text();
        if (copy.startsWith("{")) responses.push(JSON.parse(copy)); return result; },
    })); cleanup.push(() => client.close());
    expect(client.getProtocolEra()).toBe("modern");
    expect(responses[0]).toMatchObject({ result: { supportedVersions: ["2026-07-28"], capabilities: { events: {} }, resultType: "complete" } });
    const tools = await client.listTools();
    expect(tools.tools.some(tool => tool.name === "reflect_refresh")).toBe(true);
    expect(tools.tools.some(tool => tool.name === "send_to_external_llm")).toBe(false);
    expect((await client.callTool({ name: "reflect_refresh", arguments: {} })).isError).not.toBe(true);
    await expectLiveCards(client);
    expect(await client.listResourceTemplates()).toMatchObject({ resourceTemplates: [] });
    await expect(client.readResource({ uri: "ui://missing/resource" })).rejects.toMatchObject({ code: -32602 });
    const resultSchema = z.object({}).passthrough();
    expect(await client.request({ method: "events/list", params: {} }, resultSchema)).toMatchObject({ events: [{ name: subscription.name }] });
    const created = await client.request({ method: "events/subscribe", params: subscription }, resultSchema);
    expect(created).toMatchObject({ id: expect.stringMatching(/^sub_/), cursor: null, truncated: false });
    expect(rt.externalEvents!.recipients()).toHaveLength(1);
    expect(await client.callTool({ name: "send_to_external_llm", arguments: { recipient_id: created.id, text: "not allowed" } })).toMatchObject({ isError: true });
    await client.request({ method: "events/unsubscribe", params: subscription }, resultSchema);
    expect(rt.externalEvents!.recipients()).toHaveLength(0);
    expect((await fetch(`${base}/dot`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer internal-token" }, body: '{}' })).status).toBe(401);
  });
  it("SDK1 initialize/list/call still works on dedicated and generic routes, Events stays dedicated", async () => {
    const { base } = await web();
    for (const [path, token] of [["/dot", "dot-token"], ["/mcp", "internal-token"]]) {
      const client = new Client({ name: "legacy-test", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(base + path), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      cleanup.push(() => client.close());
      expect((await client.listTools()).tools.some(tool => tool.name === "reflect_refresh")).toBe(true);
      expect((await client.callTool({ name: "reflect_refresh", arguments: {} })).isError).not.toBe(true);
      if (path === "/dot") {
        await expectLiveCards(client);
        expect(await client.listResourceTemplates()).toMatchObject({ resourceTemplates: [] });
        await expect(client.readResource({ uri: "ui://missing/resource" })).rejects.toMatchObject({ code: -32602 });
      }
      await expect(client.request({ method: "events/list", params: {} }, z.object({}).passthrough())).rejects.toThrow();
    }
  });
});
describe("internal tools authentication and optional Events config", () => {
  it("requires internal principal and a real context session; returns safe delivery states", async () => {
    const rt = await runtime(); const subscribed = await rt.externalEvents!.subscribe(subscription);
    async function call(context: Parameters<typeof withMcpRequestContext>[0], name: string, args = {}) {
      return withMcpRequestContext(context, async () => {
        const server = buildMcpServer(rt); const client = new Client({ name: "internal-test", version: "1" });
        const [a, b] = InMemoryTransport.createLinkedPair();
        try { await server.connect(b); await client.connect(a); return await client.callTool({ name, arguments: args }); }
        finally { await client.close(); await server.close(); }
      });
    }
    expect((await call({}, "list_external_llm_recipients")).isError).toBe(true);
    expect((await call({ principal: INTERNAL_MCP_PRINCIPAL, callerSessionId: "fake" }, "send_to_external_llm", { recipient_id: subscribed.id, text: "hello" })).isError).toBe(true);
    const context = { principal: INTERNAL_MCP_PRINCIPAL, callerSessionId: "real-session" };
    const list = await call(context, "list_external_llm_recipients");
    expect(JSON.stringify(list)).not.toContain("receiver.example"); expect(JSON.stringify(list)).not.toContain(secret);
    expect(await call(context, "send_to_external_llm", { recipient_id: "missing", text: "hello" })).toMatchObject({ structuredContent: { status: "not_sent" } });
    expect(await call(context, "send_to_external_llm", { recipient_id: subscribed.id, text: "hello" })).toMatchObject({ structuredContent: { status: "accepted_by_receiver" } });
  });
  it("enables only with an absolute state file and authenticated dedicated ingress", () => {
    const common = { SOULSTREAM_NODE_ID: "test-node", SOULSTREAM_UPSTREAM_URL: "ws://localhost:5200/ws/node", EVENT_OUTBOX_DIR: "/tmp/events-config-test" };
    expect(parseEnv(common).MCP_EXTERNAL_EVENTS_STATE_FILE).toBeUndefined();
    expect(() => parseEnv({ ...common, MCP_EXTERNAL_EVENTS_STATE_FILE: "relative.json" })).toThrow(/absolute/);
    expect(() => parseEnv({ ...common, MCP_EXTERNAL_EVENTS_STATE_FILE: "/var/lib/example/state.json" })).toThrow(/MCP_EXTERNAL_INGRESS_ENABLED/);
  });
});

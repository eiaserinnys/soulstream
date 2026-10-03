import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerExternalLlmTools } from "../../src/mcp/tools/external_llm.js";
import * as forwarding from "../../src/mcp/orchestrator_tools.js";
import { withMcpRequestContext, INTERNAL_MCP_PRINCIPAL } from "../../src/mcp/request_context.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import Fastify from "fastify";
import { registerMcpHostRoutes } from "../../../orch-server-ts/src/mcp/mcp_host_routes.js";
import { unusedClusterDependencies } from "../../../orch-server-ts/tests/mcp-cluster-unused-fixture.js";
import type { McpHostOptions } from "../../../orch-server-ts/src/mcp/types.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup(store: boolean) {
  // Same registerTool capture as the existing MCP tool unit harnesses.
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const server = { registerTool: (name: string, _config: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => handlers.set(name, handler) } as unknown as McpServer;
  const service = { recipients: vi.fn(() => [{ recipient_id: "recipient" }]), send: vi.fn(async () => ({ ok: true, status: "accepted_by_receiver" })) };
  const runtime = { nodeId: "other-node", db: { getSession: vi.fn(async () => ({})) },
    ...(store ? { externalEvents: service } : {}) } as unknown as McpRuntime;
  return { handlers, server, runtime, service };
}
describe("external LLM tools execute where the subscription store lives", () => {
  it.each([true, false])("store present=%s chooses exactly one owner", async store => {
    const h = setup(store); const forward = vi.spyOn(forwarding, "forwardOrchestratorTool").mockResolvedValue({ content: [{ type: "text", text: "forwarded" }] });
    await withMcpRequestContext({ principal: INTERNAL_MCP_PRINCIPAL, callerSessionId: "sender" }, async () => {
      registerExternalLlmTools(h.server, h.runtime);
      await h.handlers.get("list_external_llm_recipients")!({});
      await h.handlers.get("send_to_external_llm")!({ recipient_id: "recipient", text: "hello" });
    });
    expect(forward).toHaveBeenCalledTimes(store ? 0 : 2);
    expect(h.service.recipients).toHaveBeenCalledTimes(store ? 1 : 0);
    expect(h.service.send).toHaveBeenCalledTimes(store ? 1 : 0);
    if (!store) expect(h.runtime.db.getSession).not.toHaveBeenCalled();
  });
  it("never registers the tools for an external caller", () => {
    const h = setup(false);
    withMcpRequestContext({ principal: { authority: "external", source: "dot", displayName: "Dot" } }, () => registerExternalLlmTools(h.server, h.runtime));
    expect(h.handlers.size).toBe(0);
  });
  it("forwards an internal session on another node through the service host with identical results", async () => {
    const local = setup(true); const remote = setup(false);
    const app = Fastify();
    const getSession = vi.fn(async (id: string) => id === "sender" ? {} : null);
    registerMcpHostRoutes(app, { ...unusedClusterDependencies, board: undefined as never, cards: undefined as never, folders: undefined as never,
      authBearerToken: "test-host", externalLlm: { getSession, service: local.service } } as unknown as McpHostOptions);
    remote.runtime.orch = { baseUrl: "http://orchestrator.test", headers: { Authorization: "Bearer test-host" } };
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const response = await app.inject({ method: "POST", url: new URL(url).pathname,
        headers: init.headers as Record<string, string>, payload: init.body as string });
      return new Response(response.body, { status: response.statusCode });
    });
    vi.stubGlobal("fetch", fetch);
    try {
      await withMcpRequestContext({ principal: INTERNAL_MCP_PRINCIPAL, callerSessionId: "sender" }, async () => {
        registerExternalLlmTools(local.server, local.runtime); registerExternalLlmTools(remote.server, remote.runtime);
        for (const name of ["list_external_llm_recipients", "send_to_external_llm"]) {
          const args = { recipient_id: "recipient", text: "hello" };
          expect(await remote.handlers.get(name)!(args)).toEqual(await local.handlers.get(name)!(args));
        }
      });
      expect(getSession).toHaveBeenCalledWith("sender");
      expect(JSON.parse(fetch.mock.calls[1]![1].body as string).context).toMatchObject({ node_id: "other-node", principal: "internal", caller_session_id: "sender" });
    } finally { await app.close(); }
  });
  it("rejects an unauthenticated principal before forwarding", async () => {
    const h = setup(false); const forward = vi.spyOn(forwarding, "forwardOrchestratorTool");
    await withMcpRequestContext({}, async () => {
      registerExternalLlmTools(h.server, h.runtime);
      for (const name of ["list_external_llm_recipients", "send_to_external_llm"]) {
        expect(await h.handlers.get(name)!({ recipient_id: "recipient", text: "hello" })).toMatchObject({ isError: true, structuredContent: { error: "internal_principal_required" } });
      }
    });
    expect(forward).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  InMemoryNodeRegistry,
  NodeCommandTransportHub,
  RuntimeSessionEventHub,
  SessionCommandRouter,
  SessionCommandTransportBridge,
  createApp,
  createLiveExecuteProxyRouteProvider,
  parseOrchServerConfig,
  type ExecuteProxyProvider,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

function fakeProvider(): ExecuteProxyProvider {
  return {
    executeNew: vi.fn(async () => ({ agentSessionId: "sess-new", nodeId: "node-new", events: [] })),
    executeResume: vi.fn(async () => ({ agentSessionId: "sess-old", nodeId: "node-old", events: [] })),
  };
}

describe("execute proxy attachment input", () => {
  it("passes attachment ids and paths for new requests and hands the request to the provider", async () => {
    const provider = fakeProvider();
    const app = createApp({ config, executeProxyRoutes: { provider } });
    try {
      const response = await app.inject({ method: "POST", url: "/api/execute", payload: {
        prompt: "", profile: "codex-agent",
        attachmentIds: ["att-1"], attachment_paths: ["/incoming/pending/a.png"],
      } });

      expect(response.statusCode).toBe(200);
      expect(provider.executeNew).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "",
          attachment_ids: ["att-1"],
          attachment_paths: ["/incoming/pending/a.png"],
        }),
        expect.objectContaining({ headers: expect.any(Object), url: "/api/execute" }),
      );
      expect(provider.executeNew).toHaveBeenCalledWith(
        expect.not.objectContaining({ attachment_bindings: expect.anything() }),
        expect.anything(),
      );
    } finally { await app.close(); }
  });

  it("passes attachment ids and paths for resume requests and hands the request to the provider", async () => {
    const provider = fakeProvider();
    const app = createApp({ config, executeProxyRoutes: { provider } });
    try {
      const response = await app.inject({ method: "POST", url: "/api/execute", payload: {
        prompt: "", agent_session_id: "sess-old",
        attachment_ids: ["att-1", "att-2"], attachmentPaths: ["/incoming/pending/a.png"],
      } });

      expect(response.statusCode).toBe(200);
      expect(provider.executeResume).toHaveBeenCalledWith(
        {
          agent_session_id: "sess-old",
          prompt: "",
          attachment_ids: ["att-1", "att-2"],
          attachment_paths: ["/incoming/pending/a.png"],
        },
        expect.objectContaining({ url: "/api/execute" }),
      );
    } finally { await app.close(); }
  });

  it.each([
    ["new", { profile: "codex-agent" }],
    ["resume", { agent_session_id: "sess-old" }],
  ])("rejects externally supplied bindings and malformed ids on %s requests", async (_mode, base) => {
    const provider = fakeProvider();
    const app = createApp({ config, executeProxyRoutes: { provider } });
    try {
      for (const extra of [
        { attachment_ids: ["att-1"], attachment_bindings: [] },
        { attachment_ids: ["att-1"], attachmentBindings: [] },
        { attachment_ids: [""] },
        { attachmentIds: "att-1" },
      ]) {
        const response = await app.inject({ method: "POST", url: "/api/execute", payload: {
          prompt: "hello", ...base, ...extra,
        } });
        expect(response.statusCode).toBe(422);
      }
      expect(provider.executeNew).not.toHaveBeenCalled();
      expect(provider.executeResume).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("gives the live provider the real route request and never promotes body caller_info to the actor", async () => {
    const registry = new InMemoryNodeRegistry({
      nowMs: () => 1_700_000_000_000,
      requestIdGenerator: ({ sequence, commandType, nowMs }) => `cmd-${commandType}-${sequence}-${nowMs}`,
    });
    const transports = new NodeCommandTransportHub();
    const router = new SessionCommandRouter({ registry });
    const bridge = new SessionCommandTransportBridge({ registry, transports });
    const sessionEventHub = new RuntimeSessionEventHub();
    const connectionId = registry.registerNode({
      type: "node_register", node_id: "node-codex", host: "127.0.0.1", port: 4105,
      agents: [{ id: "codex-agent", backend: "codex" }],
      capabilities: { max_concurrent: 8, runner_inventory_v1: true },
      supported_backends: ["codex"],
    }).node.connectionId;
    registry.receiveNodeMessage("node-codex", { type: "runner_inventory", running_session_ids: [] });
    const sent: Record<string, unknown>[] = [];
    transports.attach({ nodeId: "node-codex", connectionId, transport: { send: (data) => {
      const message = JSON.parse(data) as Record<string, unknown>;
      sent.push(message);
      sessionEventHub.dispatchNodeRegistryEvents(registry.receiveNodeMessage({ nodeId: "node-codex", connectionId }, {
        type: "session_created", requestId: message.requestId, agentSessionId: message.agentSessionId,
      }));
      sessionEventHub.dispatchNodeRegistryEvents(registry.receiveNodeMessage({ nodeId: "node-codex", connectionId }, {
        type: "event", agentSessionId: message.agentSessionId, event: { type: "complete", result: "done" },
      }));
    } } });
    const seen: unknown[] = [];
    const provider = createLiveExecuteProxyRouteProvider({
      registry, router, bridge, sessionEventHub, generateSessionId: () => "generated-session",
      admitAttachmentInput: async (request, input) => {
        seen.push({ request, input });
        return { attachment_ids: ["att-1"], attachment_paths: [], attachment_bindings: [] };
      },
    });
    const app = createApp({ config, executeProxyRoutes: { provider } });
    try {
      const response = await app.inject({ method: "POST", url: "/api/execute", payload: {
        prompt: "", profile: "codex-agent", attachment_ids: ["att-1"],
        caller_info: { source: "slack", user_id: "owner-user", email: "owner@example.com" },
      } });

      expect(response.statusCode).toBe(200);
      expect(seen).toHaveLength(1);
      const { request, input } = seen[0] as { request: Record<string, unknown>; input: Record<string, unknown> };
      expect(request).toMatchObject({ method: "POST", url: "/api/execute" });
      expect(input).toEqual({ sessionId: "generated-session", nodeId: "node-codex", attachmentIds: ["att-1"] });
      expect(sent[0]).toMatchObject({ type: "create_session", prompt: "", attachment_ids: ["att-1"] });
    } finally { await app.close(); }
  });
});

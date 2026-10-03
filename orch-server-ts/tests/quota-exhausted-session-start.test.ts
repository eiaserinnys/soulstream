import { describe, expect, it, vi } from "vitest";
import { createApp, InMemoryNodeRegistry, NodeCommandTransportHub, PerNodeSessionCache,
  SessionCommandRouter, SessionCommandTransportBridge } from "../src/index.js";
import { ModelPresetAvailabilityService } from "../src/model/model_preset_availability.js";
import { executeMcpTool } from "../src/mcp/tool_executor.js";
import type { McpHostOptions } from "../src/mcp/types.js";
import type { UsageSummarySnapshot } from "../src/usage/usage_summary_service.js";

/** The real availability service, route, router and bridge deliver a command to a fake node. */
function harness(reason: "quota" | "env" | "auth" = "quota") {
  const registry = new InMemoryNodeRegistry({ sessionCache: new PerNodeSessionCache() });
  const registration = registry.registerNode({
    type: "node_register", node_id: "quota-node", supported_backends: ["codex"],
    agents: [{ id: "roselin", backend: "codex", default_preset: "codex-6.1-sol" }],
    model_presets: [{ id: "codex-6.1-sol", label: "Codex - 6.1 Sol", backend: "codex",
      available: reason !== "env", ...(reason === "env" ? { reason: "env_unresolved" } : {}),
      usage_provider: "codex", usage_model_id: "gpt-6.1-sol" }],
  });
  registry.receiveNodeMessage("quota-node", { type: "runner_inventory", running_session_ids: [] });
  const summary: UsageSummarySnapshot = { generatedAt: new Date().toISOString(), collectedAt: null,
    nodes: [{ nodeId: "quota-node", fetchedAt: null, stale: false, staleSince: null,
      providers: { claude: null, gemini: null, codex: {
        status: reason === "auth" ? "not_configured" : "auto",
        weeklyRemainingPercent: 0, weeklyResetAt: null, shortRemainingPercent: 0, shortResetAt: null,
        quotas: [{ id: "codex:weekly", label: "7일", window: "7d", model: null,
          remainingPercent: 0, resetAt: null }],
      } } }] };
  const availability = new ModelPresetAvailabilityService(registry, { getSummary: () => summary });
  const transports = new NodeCommandTransportHub();
  const sent: Record<string, unknown>[] = [];
  transports.attach({ nodeId: "quota-node", connectionId: registration.node.connectionId,
    transport: { send: data => {
      const command = JSON.parse(data);
      sent.push(command);
      registry.receiveNodeMessage("quota-node", { type: "session_created",
        requestId: command.requestId, agentSessionId: command.agentSessionId });
    } } });
  const sessions = { router: new SessionCommandRouter({ registry }),
    bridge: new SessionCommandTransportBridge({ registry, transports }), modelPresetAvailability: availability };
  const app = createApp({ config: { environment: "test", databaseUrl: "postgresql://test/test",
    authBearerToken: "test-token" }, sessionCommandRoutes: sessions });
  return { availability, sent, app, sessions };
}

describe("zero quota session creation", () => {
  it.each([true, false])("HTTP forwards the preset with explicit selection=%s", async explicit => {
    const h = harness();
    try {
      expect(h.availability.listForNode("quota-node")?.[0]).toMatchObject({
        available: true, reason: "quota_exhausted", usage_warning: false });
      const response = await h.app.inject({ method: "POST", url: "/api/sessions",
        payload: { prompt: "크레딧으로 실행", nodeId: "quota-node", profile: "roselin",
          ...(explicit ? { model_preset: "codex-6.1-sol" } : {}) } });
      expect(response.statusCode).toBe(201);
      expect(h.sent[0]).toMatchObject({ type: "create_session", model_preset: "codex-6.1-sol" });
    } finally { await h.app.close(); }
  });
  it("remote MCP forwards the exhausted model through the production route", async () => {
    const h = harness();
    try {
      const options = { cluster: { sessions: h.sessions, logger: { warn: vi.fn() } } } as unknown as McpHostOptions;
      const result = await executeMcpTool(options, "create_remote_agent_session",
        { node_id: "quota-node", agent_id: "roselin", model_preset: "codex-6.1-sol",
          prompt: "크레딧으로 실행", folder_id: null },
        { principal: "internal", callerSessionId: "parent", nodeId: "quota-node" });
      expect(result.isError).not.toBe(true);
      expect(h.sent[0]).toMatchObject({ type: "create_session", model_preset: "codex-6.1-sol" });
    } finally { await h.app.close(); }
  });
  it.each(["env", "auth"] as const)("keeps %s failure blocked before sending", async reason => {
    const h = harness(reason);
    try {
      const response = await h.app.inject({ method: "POST", url: "/api/sessions",
        payload: { prompt: "실행", nodeId: "quota-node", profile: "roselin" } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("MODEL_PRESET_UNAVAILABLE");
      expect(h.sent).toEqual([]);
    } finally { await h.app.close(); }
  });
});

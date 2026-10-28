import { describe, expect, it, vi } from "vitest";
import { createApp, InMemoryNodeRegistry, NodeCommandTransportHub, PerNodeSessionCache,
  SessionCommandRouter, SessionCommandTransportBridge } from "../src/index.js";
import { ModelPresetAvailabilityService } from "../src/model/model_preset_availability.js";
import { executeMcpTool } from "../src/mcp/tool_executor.js";
import type { McpHostOptions } from "../src/mcp/types.js";
import { NodeEventIngressController } from "../src/node/event_ingress_controller.js";
import type { EventAppendBatch, EventIngressEnvelope } from "../src/node/event_ingress_types.js";
import { UsageSummaryService, type UsageSummarySnapshot } from "../src/usage/usage_summary_service.js";

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
  let now = new Date("2026-10-12T03:00:00.000Z");
  const summary: UsageSummarySnapshot = { generatedAt: now.toISOString(), collectedAt: null,
    nodes: [{ nodeId: "quota-node", fetchedAt: null, stale: false, staleSince: null,
      providers: { claude: null, antigravity: null, codex: {
        status: reason === "auth" ? "not_configured" : "auto",
        weeklyRemainingPercent: 0, weeklyResetAt: null, shortRemainingPercent: 0, shortResetAt: null,
        quotas: [{ id: "codex:weekly", label: "7일", window: "7d", model: null,
          remainingPercent: 0, resetAt: null }],
      } } }] };
  const transports = new NodeCommandTransportHub();
  const sent: Record<string, unknown>[] = [];
  const bridge = new SessionCommandTransportBridge({ registry, transports });
  const usageMemory = new UsageSummaryService({
    registry,
    bridge,
    pollIntervalMs: 300_000,
    sharedAccountGroups: [],
    now: () => now,
  });
  const availability = new ModelPresetAvailabilityService(registry, {
    getSummary: () => summary,
    getLimitRejection: (nodeId, provider) => usageMemory.getLimitRejection(nodeId, provider),
    getClaudePoolAccountsForAvailability: (_nodeId, accounts) => accounts,
  }, () => now);
  transports.attach({ nodeId: "quota-node", connectionId: registration.node.connectionId,
    transport: { send: data => {
      const command = JSON.parse(data);
      sent.push(command);
      registry.receiveNodeMessage("quota-node", { type: "session_created",
        requestId: command.requestId, agentSessionId: command.agentSessionId });
    } } });
  const sessions = { router: new SessionCommandRouter({ registry }), bridge, modelPresetAvailability: availability };
  const acks: Record<string, unknown>[] = [];
  let sourceSeq = 0;
  let eventId = 100;
  const ingress = new NodeEventIngressController({
    nodeId: "quota-node",
    connectionId: registration.node.connectionId,
    isCurrentConnection: () => true,
    committer: {
      commitBatch: vi.fn(async (_nodeId, batch) => batch.events.map((envelope: EventIngressEnvelope) => ({
        envelope,
        eventId: ++eventId,
        duplicateReceipt: false,
      }))),
    },
    receiveCommittedEvent: () => [],
    publish: () => undefined,
    send: frame => acks.push(frame),
    close: () => undefined,
    logError: () => undefined,
    logWarn: () => undefined,
    onCommittedProviderEvent: input => usageMemory.observeProviderExecution(input),
  });
  const appendProviderEvent = async (eventType: string, payload: unknown, createdAt: string) => {
    const seq = ++sourceSeq;
    const streamId = "018f47b7-c6de-7d64-9c8d-0b62cbbb2e10";
    const batch: EventAppendBatch = {
      type: "event_append_batch",
      protocol_version: 1,
      stream_id: streamId,
      first_seq: seq,
      events: [{
        stream_id: streamId,
        source_seq: seq,
        session_id: "session-a",
        event_type: eventType,
        payload,
        searchable_text: "",
        created_at: createdAt,
        semantic_dedupe_key: null,
        session_effect: null,
        payload_hash: "a".repeat(64),
      }],
    };
    ingress.enqueue(batch as unknown as Record<string, unknown>);
    await ingress.drain();
  };
  const app = createApp({ config: { environment: "test", databaseUrl: "postgresql://test/test",
    authBearerToken: "test-token" }, sessionCommandRoutes: sessions,
    nodeAgentProfileRoutes: { provider: {} as never, modelPresetProvider: availability } });
  return { availability, sent, app, sessions, usageMemory, appendProviderEvent, acks };
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
  it("blocks a new session after a committed provider rejection and releases after success", async () => {
    const h = harness();
    try {
      await h.appendProviderEvent("error", {
        type: "error",
        error_code: "codex_usage_limit_exceeded",
        rate_limit_type: "seven_day_primary",
        resets_at: "2026-10-12T04:00:00.000Z",
      }, "2026-10-12T02:59:00.000Z");

      const rejectedList = await h.app.inject({ method: "GET", url: "/api/nodes/quota-node/model-presets" });
      expect(rejectedList.statusCode).toBe(200);
      expect(rejectedList.json().model_presets[0]).toMatchObject({
        available: false,
        reason: "limit_rejected",
        reason_label: "7일 한도 거부 중",
        resets_at: "2026-10-12T04:00:00.000Z",
      });

      const rejectedCreate = await h.app.inject({ method: "POST", url: "/api/sessions",
        payload: { prompt: "실행", nodeId: "quota-node", profile: "roselin" } });
      expect(rejectedCreate.statusCode).toBe(400);
      expect(rejectedCreate.json().error.message).toBe(
        "Model preset 'codex-6.1-sol' is unavailable on node quota-node: 7일 한도 거부 중 (resets_at: 2026-10-12T04:00:00.000Z)",
      );
      expect(h.sent).toEqual([]);

      await h.appendProviderEvent("complete", {
        type: "complete",
        raw_event_type: "turn/completed",
        status: "completed",
      }, "2026-10-12T03:01:00.000Z");

      const releasedList = await h.app.inject({ method: "GET", url: "/api/nodes/quota-node/model-presets" });
      expect(releasedList.json().model_presets[0]).toMatchObject({ available: true, reason: "quota_exhausted" });
      const allowedCreate = await h.app.inject({ method: "POST", url: "/api/sessions",
        payload: { prompt: "실행", nodeId: "quota-node", profile: "roselin" } });
      expect(allowedCreate.statusCode).toBe(201);
      expect(h.sent).toHaveLength(1);
      expect(h.acks).toHaveLength(2);
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

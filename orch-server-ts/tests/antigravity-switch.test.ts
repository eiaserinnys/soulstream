import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

import { InMemoryNodeRegistry, type NodeRegistrationPayload } from "../src/node/registry.js";
import { selectNodeForSessionCreate, SessionCreateNodeSelectionError } from "../src/session/session_create_node_selector.js";
import { buildSessionBackendCatalog } from "../src/runtime/live_session_serialization.js";
import { ModelPresetAvailabilityService, ModelPresetAvailabilityError } from "../src/model/model_preset_availability.js";
import { PersistentDefaultsSettings } from "../src/settings/persistent_defaults_settings.js";
import { UsageSummaryService, type UsageSummaryBridge } from "../src/usage/usage_summary_service.js";
import { registerAgentLoginRoutes } from "../src/node/agent_login_routes.js";
import { registerEphemeralLlmRoutes } from "../src/llm/ephemeral_llm_routes.js";
import { UsageLimitFallbackTurnSummarizer } from "../src/turn-summary/turn_summary_usage_limit_fallback.js";
import { createLiveExecuteProxyRouteProvider } from "../src/runtime/live_execute_proxy_route_provider.js";
import { createClaudeAuthHarness } from "./node-claude-auth-test-helpers.js";
import { repositoryModelCatalog } from "./helpers/model_catalog.js";

const catalog = repositoryModelCatalog();
const agyPresetIds = catalog.snapshot().presets.filter(preset => preset.backend === "antigravity").map(preset => preset.id);
const agyPreset = agyPresetIds[0]!;

function advertisement(): NodeRegistrationPayload {
  const presets = catalog.snapshot().presets.filter(p => p.backend === "claude" || p.backend === "antigravity");
  return {
    type: "node_register",
    node_id: "node-a",
    agents: [{ id: "roselin", backend: "claude", default_preset: "claude-opus" }],
    capabilities: { agent_login_v1: true },
    supported_backends: ["claude", "antigravity"],
    model_presets: presets.map(p => ({
      id: p.id, label: p.label, backend: p.backend, available: true, usage_provider: p.backend,
    })),
  } as NodeRegistrationPayload;
}

function switchedRegistry() {
  const state = { enabled: false };
  const registry = new InMemoryNodeRegistry({ antigravityEnabled: () => state.enabled });
  registry.registerNode(advertisement());
  return { registry, state };
}

const noUsage = {
  getSummary: () => ({ generatedAt: "", collectedAt: null, nodes: [] }),
  getLimitRejection: () => null,
  getClaudePoolAccountsForAvailability: () => [],
} as never;

describe("a switched-off Antigravity looks absent, and comes back without re-registration", () => {
  it("hides the presets from the node's model list until the switch turns on", () => {
    const { registry, state } = switchedRegistry();
    const service = new ModelPresetAvailabilityService(registry, noUsage, catalog);
    const ids = () => service.listForNode("node-a")!.map(preset => preset.id);
    expect(ids().some(id => agyPresetIds.includes(id))).toBe(false);
    expect(ids()).toContain("claude-opus");
    expect(registry.getConnectedNode("node-a")!.supportedBackends).toEqual(["claude"]);
    state.enabled = true;
    expect(agyPresetIds.every(id => ids().includes(id))).toBe(true);
    expect(registry.getConnectedNode("node-a")!.supportedBackends).toEqual(["claude", "antigravity"]);
  });

  it("keeps labelling sessions that ran on Antigravity from the stored advertisement", () => {
    const { registry } = switchedRegistry();
    const entries = buildSessionBackendCatalog(registry);
    expect(entries.filter(entry => entry.kind === "preset" && entry.backend === "antigravity")).not.toHaveLength(0);
  });

  it("does not answer an Antigravity preset from the catalogue fallback for a node that never connected", () => {
    const registry = new InMemoryNodeRegistry({ antigravityEnabled: () => false });
    const service = new ModelPresetAvailabilityService(registry, noUsage, catalog);
    expect(() => service.resolveStaticForNode("never-connected", agyPreset, { requireAvailable: false }))
      .toThrow(ModelPresetAvailabilityError);
    expect(service.resolveStaticForNode("never-connected", "claude-opus", { requireAvailable: false }).backend).toBe("claude");
  });
});

describe("with the switch off", () => {
  it("rejects creating a session on an Antigravity preset", () => {
    const { registry } = switchedRegistry();
    expect(() => selectNodeForSessionCreate(registry, { nodeId: "node-a", modelPresetId: agyPreset }))
      .toThrow(SessionCreateNodeSelectionError);
    expect(selectNodeForSessionCreate(registry, { nodeId: "node-a", modelPresetId: "claude-opus" }).backend).toBe("claude");
  });

  it("makes a PAS created without a model start on claude-opus and hides Antigravity from the PAS defaults", async () => {
    const source = catalog.snapshot();
    expect(agyPresetIds).toContain(source.persistent_defaults.model_preset);
    const state = { enabled: false };
    const settings = new PersistentDefaultsSettings(async () => { throw new Error("no db"); }, catalog, vi.fn(), () => state.enabled);
    const defaults = settings.snapshot().persistent_defaults;
    expect(defaults.model_preset).toBe("claude-opus");
    expect(defaults.fallback_models.map(entry => entry.model_preset)).not.toEqual(expect.arrayContaining(agyPresetIds));
    const visible = await settings.get();
    expect(visible.value.model_preset).toBe("claude-opus");
    await expect(settings.put({
      value: { model_preset: agyPreset, fallback_models: [] }, expectedVersion: 0, updatedBy: "admin",
    })).rejects.toMatchObject({ statusCode: 422 });
    state.enabled = true;
    expect(settings.snapshot().persistent_defaults.model_preset).toBe(source.persistent_defaults.model_preset);
  });

  it("reports antigravity as null in the usage summary and never asks a node for its usage", async () => {
    const { registry } = switchedRegistry();
    const sent: Array<string | undefined> = [];
    const limits = { status: "auto", weeklyUsedPercent: 10, weeklyResetAt: 1_753_100_000, shortUsedPercent: 10, shortResetAt: 1_753_000_000, quotas: [] };
    const bridge = { sendPendingCommand: vi.fn(async ({ command }: { command: { message: { provider?: string } } }) => {
      sent.push(command.message.provider);
      return command.message.provider === undefined
        ? { success: true, data: { providers: { claude: limits, codex: limits, antigravity: limits, opencode_go: limits } } }
        : { success: true, data: limits };
    }) } as unknown as UsageSummaryBridge;
    const service = new UsageSummaryService({ registry, bridge, pollIntervalMs: 300_000, sharedAccountGroups: [] });
    await service.collectOnce();
    await service.refreshNode("node-a");
    const fresh = new UsageSummaryService({ registry, bridge, pollIntervalMs: 300_000, sharedAccountGroups: [] });
    await fresh.refreshNode("node-a");
    expect(sent).not.toContain("antigravity");
    expect(sent).not.toContain(undefined);
    for (const summary of [service.getSummary(), fresh.getSummary()]) {
      expect(summary.nodes[0]!.providers.antigravity).toBeNull();
      expect(summary.nodes[0]!.providers.claude).toMatchObject({ status: "auto" });
    }
  });

  it("answers 409 ANTIGRAVITY_DISABLED to starting an Antigravity login and still starts Codex", async () => {
    const { registry } = switchedRegistry();
    registry.registerNode({ ...advertisement(), supported_backends: ["claude", "codex", "antigravity"] });
    const sendPendingCommand = vi.fn(async () => ({ success: true, data: { state: "url_ready" } }));
    const app = Fastify();
    registerAgentLoginRoutes(app, { registry, bridge: { sendPendingCommand } as never, usageSummary: { refreshNode: vi.fn() } as never });
    const blocked = await app.inject({ method: "POST", url: "/api/nodes/node-a/agent-logins/antigravity" });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: "ANTIGRAVITY_DISABLED" });
    expect(sendPendingCommand).not.toHaveBeenCalled();
    expect((await app.inject({ method: "POST", url: "/api/nodes/node-a/agent-logins/codex" })).statusCode).toBe(202);
    await app.close();
  });

  it("does not forward Antigravity usage through the node provider-usage routes", async () => {
    const harness = createClaudeAuthHarness();
    harness.registry.isAntigravityEnabled = () => false;
    const blocked = await harness.app.inject({ method: "GET", url: "/api/nodes/fake-node/provider-usage/antigravity" });
    expect(blocked.statusCode).toBe(409);
    const snapshot = await harness.app.inject({ method: "GET", url: "/api/nodes/fake-node/provider-usage" });
    expect(snapshot.statusCode).toBe(200);
    expect(harness.sent.filter(message => message.type === "provider_usage_get").map(message => message.provider))
      .toEqual(["claude", "codex", "opencode_go"]);
    expect(snapshot.json().providers.antigravity).toMatchObject({ status: "not_configured" });
    await harness.app.close();
  });

  it("answers 503 ANTIGRAVITY_UNAVAILABLE to an ephemeral Antigravity request", async () => {
    const generate = vi.fn();
    const app = Fastify();
    registerEphemeralLlmRoutes(app, {
      authBearerToken: "service-token", nodeCredentials: null, generator: { generate },
      antigravityGenerator: { generate }, antigravityEnabled: () => false,
    });
    const response = await app.inject({ method: "POST", url: "/api/llm/ephemeral",
      headers: { authorization: "Bearer service-token" },
      payload: { prompt: "hello", model: "gemini-4-argon", backend: "antigravity", reasoning_effort: "high" } });
    expect(response.statusCode).toBe(503);
    expect(JSON.stringify(response.json())).toContain("ANTIGRAVITY_UNAVAILABLE");
    expect(generate).not.toHaveBeenCalled();
    await app.close();
  });

  it("skips the Antigravity fallback for a turn summary that hit the Codex usage limit", async () => {
    const limitError = Object.assign(new Error("codex exec exited 1: You've hit your usage limit."), { code: "CODEX_USAGE_LIMIT" });
    const fallback = { generate: vi.fn() };
    const primary = { summarize: vi.fn(async () => { throw limitError; }), generate: vi.fn(async () => { throw limitError; }) };
    const summarizer = new UsageLimitFallbackTurnSummarizer({ primary: primary as never, fallback, antigravityEnabled: () => false });
    await expect(summarizer.generate("prompt", { fallbackModel: "gemini-3.8-flash", reasoningEffort: "low" } as never)).rejects.toBe(limitError);
    expect(fallback.generate).not.toHaveBeenCalled();
  });

  it("refuses to resume a finished ordinary Antigravity session", async () => {
    const { registry } = switchedRegistry();
    const provider = createLiveExecuteProxyRouteProvider({
      registry, router: {} as never, bridge: {} as never, sessionEventHub: { subscribe: () => () => undefined } as never, modelCatalog: catalog,
      persistentResume: {
        getSession: async () => ({ status: "completed", model_preset: agyPreset, node_id: "node-a", metadata: {} }),
        updateSession: async () => undefined, listAgentProfiles: async () => undefined,
      },
    });
    await expect(provider.executeResume!({ agent_session_id: "s1", prompt: "again" } as never, undefined as never))
      .rejects.toMatchObject({ statusCode: 409, detail: { error: { code: "ANTIGRAVITY_DISABLED" } } });
  });
});

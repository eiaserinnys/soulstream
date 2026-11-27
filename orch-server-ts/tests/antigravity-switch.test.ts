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
import { ModelChainTurnSummarizer } from "../src/turn-summary/turn_summary_model_chain.js";
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

  it("hides agents whose backend is Antigravity from the node snapshot, while the stored advertisement keeps them", () => {
    const state = { enabled: false };
    const registry = new InMemoryNodeRegistry({ antigravityEnabled: () => state.enabled });
    registry.registerNode({
      ...advertisement(),
      agents: [
        { id: "roselin", backend: "claude", default_preset: "claude-opus" },
        { id: "gem", backend: "antigravity", default_preset: agyPreset },
      ],
    } as NodeRegistrationPayload);
    const ids = (nodes: Array<{ agents: unknown[] }>) => nodes[0]!.agents.map(agent => (agent as { id: string }).id);
    expect(ids([registry.getConnectedNode("node-a")!])).toEqual(["roselin"]);
    expect(ids(registry.listConnectedNodes())).toEqual(["roselin"]);
    expect(ids([registry.getConnectedNodeAdvertised("node-a")!])).toEqual(["roselin", "gem"]);
    state.enabled = true;
    expect(ids([registry.getConnectedNode("node-a")!])).toEqual(["roselin", "gem"]);
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

  it("falls back to the catalogue defaults without Antigravity when the stored defaults hold nothing else", async () => {
    const stored = { value: { model_preset: agyPreset, fallback_models: [] }, version: 2 };
    const settings = new PersistentDefaultsSettings(async () => (async () => [stored]) as never, catalog, vi.fn(), () => false);
    await settings.refresh();
    const catalogDefaults = catalog.snapshot().persistent_defaults;
    const expectedFallbacks = catalogDefaults.fallback_models.filter(entry => !agyPresetIds.includes(entry.model_preset));
    for (const shown of [settings.snapshot().persistent_defaults, (await settings.get()).value]) {
      expect(agyPresetIds).not.toContain(shown.model_preset);
      expect(shown.fallback_models.map(entry => entry.model_preset)).not.toEqual(expect.arrayContaining(agyPresetIds));
      expect([shown.model_preset, ...shown.fallback_models.map(entry => entry.model_preset)])
        .toEqual(expect.arrayContaining(expectedFallbacks.map(entry => entry.model_preset)));
    }
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

  it("skips the Antigravity stage and goes on to codex when claude hit its usage limit", async () => {
    const claudeLimit = Object.assign(new Error("hit your usage limit"), { code: "CLAUDE_USAGE_LIMIT" });
    const claude = { generate: vi.fn(async () => { throw claudeLimit; }) };
    const antigravity = { generate: vi.fn() };
    const codexResult = { content: "요약", model: "gpt-5.6-luna", latencyMs: 1, attempts: 1 };
    const codex = { generate: vi.fn(async () => codexResult) };
    const chain = new ModelChainTurnSummarizer({
      claude: claude as never, antigravity: antigravity as never, codex: codex as never, antigravityEnabled: () => false,
    });
    const config = {
      preferredStages: [{ backend: "claude", model: "sonnet" }, { backend: "antigravity", model: "gemini-4-hydrogen" }],
      reasoningEffort: "low", model: "gpt-5.6-luna", timeoutMs: 1, maxAttempts: 1, fallbackTimeoutMs: 2,
    } as never;
    await expect(chain.generate("prompt", config)).resolves.toBe(codexResult);
    expect(antigravity.generate).not.toHaveBeenCalled();
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

  describe("resuming a finished persistent Antigravity session", () => {
    function persistentHarness(fallbackModels: Array<{ model_preset: string; reasoning_effort: string | null }>) {
      const { registry } = switchedRegistry();
      const updates: Array<Record<string, unknown>> = [];
      const row: Record<string, unknown> = {
        session_id: "pas-1", agent_id: "roselin", node_id: "node-a", status: "completed", termination_reason: null,
        model_preset: agyPreset, model: "m", reasoning_effort: null, claude_session_id: "native",
        metadata: [
          { type: "persistent_session", value: { enabled: true } },
          { type: "persistent_settings", value: {
            default_model: { model_preset: agyPreset, reasoning_effort: null }, fallback_models: fallbackModels,
          } },
          { type: "persistent_generation", value: { number: 1 } },
        ],
      };
      const provider = createLiveExecuteProxyRouteProvider({
        registry, router: {} as never, bridge: {} as never, sessionEventHub: { subscribe: () => () => undefined } as never,
        modelCatalog: catalog, modelPresetAvailability: new ModelPresetAvailabilityService(registry, noUsage, catalog),
        persistentResume: {
          getSession: async () => row,
          updateSession: async (input: Record<string, unknown>) => { updates.push(input); },
          listAgentProfiles: async () => ({ roselin: {} }),
        },
      } as never);
      registry.sessionCache.upsertFromSessionCreated({
        nodeId: "node-a", connectionId: registry.getConnectedNode("node-a")!.connectionId,
        message: { type: "session_created", session: { agent_session_id: "pas-1", status: "completed" } },
        nowMs: 1_700_000_000_000,
      } as never);
      return { provider, updates };
    }
    const resume = (provider: ReturnType<typeof persistentHarness>["provider"]) =>
      provider.executeResume!({ agent_session_id: "pas-1", prompt: "again" } as never, undefined as never);

    it("hands over to a stored non-Antigravity candidate instead of refusing", async () => {
      const { provider, updates } = persistentHarness([{ model_preset: "claude-opus", reasoning_effort: null }]);
      await expect(resume(provider)).rejects.not.toMatchObject({ detail: { error: { code: "ANTIGRAVITY_DISABLED" } } });
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ modelPreset: "claude-opus" });
    });

    it("answers 409 ANTIGRAVITY_DISABLED when the stored settings leave no candidate other than Antigravity", async () => {
      const { provider, updates } = persistentHarness([]);
      await expect(resume(provider)).rejects.toMatchObject({ statusCode: 409, detail: { error: { code: "ANTIGRAVITY_DISABLED" } } });
      expect(updates).toEqual([]);
    });
  });
});

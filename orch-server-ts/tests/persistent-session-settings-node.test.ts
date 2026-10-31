import { describe, expect, it } from "vitest";

import {
  parsePersistentSettingsPatch,
  readStoredPersistentSettings,
  readPersistentPendingTarget,
} from "@soulstream/wire-schema/persistent-session-settings";
import { persistentSessionSettingsTools } from "@soulstream/mcp-contract";
import { InMemoryNodeRegistry } from "../src/node/registry.js";
import { RuntimeSessionEventHub } from "../src/runtime/session_event_hub.js";
import { createLiveExecuteProxyRouteProvider } from "../src/runtime/live_execute_proxy_route_provider.js";

describe("persistent session model node selection", () => {
  it("trims node ids and distinguishes the same preset on different nodes", () => {
    const parsed = parsePersistentSettingsPatch({
      fallback_models: [
        { model_preset: "claude-opus", reasoning_effort: "medium", node_id: " eias-linegames-wsl " },
        { model_preset: "claude-opus", reasoning_effort: "medium", node_id: "eias-linegames" },
      ],
    });

    expect(parsed).toEqual({
      ok: true,
      value: {
        fallback_models: [
          { model_preset: "claude-opus", reasoning_effort: "medium", node_id: "eias-linegames-wsl" },
          { model_preset: "claude-opus", reasoning_effort: "medium", node_id: "eias-linegames" },
        ],
      },
    });
  });

  it("rejects duplicate candidates on the same node and blank node ids", () => {
    expect(parsePersistentSettingsPatch({ fallback_models: [
      { model_preset: "claude-opus", node_id: "node-a" },
      { model_preset: "claude-opus", node_id: " node-a " },
    ] })).toMatchObject({ ok: false });
    expect(parsePersistentSettingsPatch({ default_model: {
      model_preset: "claude-opus", node_id: "  ",
    } })).toMatchObject({ ok: false });
  });

  it("preserves node ids when reading stored settings and pending targets", () => {
    expect(readStoredPersistentSettings([
      { type: "persistent_settings", value: {
        default_model: { model_preset: "gemini-4-argon", node_id: "eias-linegames-wsl" },
        fallback_models: [
          { model_preset: "claude-opus", node_id: "eias-linegames-wsl" },
          { model_preset: "codex-6.1-sol", node_id: "eias-linegames" },
        ],
      } },
    ])).toMatchObject({
      default_model: { model_preset: "gemini-4-argon", node_id: "eias-linegames-wsl" },
      fallback_models: [
        { model_preset: "claude-opus", node_id: "eias-linegames-wsl" },
        { model_preset: "codex-6.1-sol", node_id: "eias-linegames" },
      ],
    });
    expect(readPersistentPendingTarget([{ type: "persistent_generation", value: {
      pending: { target_model_preset: "codex-6.1-sol", target_node_id: "eias-linegames" },
    } }])).toEqual({
      target_model_preset: "codex-6.1-sol",
      target_reasoning_effort: null,
      target_node_id: "eias-linegames",
    });
  });

  it("accepts node_id in the strict MCP tool model schema", () => {
    const schema = persistentSessionSettingsTools.update_persistent_session_settings.config.inputSchema;
    expect(schema.default_model.parse({
      model_preset: "gemini-4-argon", reasoning_effort: "medium", node_id: "eias-linegames-wsl",
    })).toMatchObject({ node_id: "eias-linegames-wsl" });
    expect(() => schema.default_model.parse({
      model_preset: "gemini-4-argon", node_id: "eias-linegames-wsl", unexpected: true,
    })).toThrow();
  });

  it("retries through Argon limit_hit, Opus limit_hit, and Sol success", async () => {
    const registry = new InMemoryNodeRegistry();
    const connected = new Map<string, { nodeId: string; connectionId: string }>();
    for (const nodeId of ["eias-linegames-wsl", "eias-linegames"]) {
      const node = registry.registerNode({
        type: "node_register",
        node_id: nodeId,
        host: "127.0.0.1",
        port: 4105,
        agents: [{ id: "pas-agent", backend: "claude" }],
        capabilities: {},
        supported_backends: ["claude", "codex", "antigravity"],
      });
      connected.set(nodeId, { nodeId, connectionId: node.node.connectionId });
    }
    const row: Record<string, unknown> = {
      session_id: "pas-fallback-chain",
      agent_id: "pas-agent",
      node_id: "eias-linegames-wsl",
      status: "completed",
      termination_reason: null,
      model_preset: "gemini-4-argon",
      model: "gemini-4-argon",
      reasoning_effort: "high",
      claude_session_id: "native-argon",
      metadata: [
        { type: "persistent_session", value: { enabled: true } },
        { type: "persistent_settings", value: {
          default_model: {
            model_preset: "gemini-4-argon", reasoning_effort: "high", node_id: "eias-linegames-wsl",
          },
          fallback_models: [
            { model_preset: "claude-opus", reasoning_effort: "high", node_id: "eias-linegames-wsl" },
            { model_preset: "codex-6.1-sol", reasoning_effort: "medium", node_id: "eias-linegames" },
          ],
        } },
        { type: "persistent_generation", value: { number: 4 } },
      ],
    };
    const staticPresets = new Map([
      ["gemini-4-argon", { id: "gemini-4-argon", label: "Argon", backend: "antigravity" as const,
        model: "gemini-4-argon", available: true, usage_provider: "antigravity" as const }],
      ["claude-opus", { id: "claude-opus", label: "Opus", backend: "claude" as const,
        model: "opus", available: true, usage_provider: "claude" as const }],
      ["codex-6.1-sol", { id: "codex-6.1-sol", label: "Sol", backend: "codex" as const,
        model: "gpt-6.1-sol", available: true, usage_provider: "codex" as const }],
    ]);
    const sessionEventHub = new RuntimeSessionEventHub();
    const attempts: Array<{ nodeId: string; deliveryId: unknown }> = [];
    registry.sessionCache.upsertFromSessionCreated({
      nodeId: "eias-linegames-wsl",
      connectionId: connected.get("eias-linegames-wsl")!.connectionId,
      message: { type: "session_created", session: { agent_session_id: "pas-fallback-chain", status: "completed" } },
      nowMs: Date.now(),
    });
    const provider = createLiveExecuteProxyRouteProvider({
      registry,
      sessionEventHub,
      router: {
        routeExistingSessionPendingCommand: async (command: Record<string, unknown>) => ({
          node: connected.get(String(row.node_id))!,
          command,
        }),
      } as never,
      bridge: {
        sendPendingCommand: async (routed: { node: { nodeId: string }; command: Record<string, unknown> }) => {
          const nodeId = routed.node.nodeId;
          const attempt = attempts.length + 1;
          attempts.push({ nodeId, deliveryId: routed.command.delivery_id });
          if (attempt < 3) {
            row.status = "error";
            row.termination_reason = "limit_hit";
            sessionEventHub.publish({ nodeId, data: {
              agentSessionId: "pas-fallback-chain",
              event: { type: "complete", termination_reason: "limit_hit" },
            } });
          } else {
            sessionEventHub.publish({ nodeId, data: {
              agentSessionId: "pas-fallback-chain",
              event: { type: "complete", result: "Sol completed" },
            } });
          }
          return { type: "intervene_ack", status: "ok", outcome: "queued" };
        },
      } as never,
      modelPresetAvailability: {
        resolveStaticForNode: (_nodeId: string, presetId: string) => staticPresets.get(presetId)!,
        requireAvailable: (_nodeId: string, presetId: string) => ({
          ...staticPresets.get(presetId)!,
          reason: null,
          reason_label: null,
          resets_at: null,
          usage_warning: false,
          weekly_headroom: null,
        }),
      },
      persistentResume: {
        getSession: async () => row,
        updateSession: async (input) => {
          Object.assign(row, {
            node_id: input.nodeId,
            model_preset: input.modelPreset,
            model: input.model,
            reasoning_effort: input.reasoningEffort,
            claude_session_id: input.claudeSessionId,
            metadata: input.metadata,
          });
        },
        listAgentProfiles: async () => ({ "pas-agent": {} }),
      },
    });

    const result = await provider.executeResume({
      agent_session_id: "pas-fallback-chain",
      prompt: "continue",
      source: "execute-proxy",
      delivery_id: "delivery-argon",
    });
    if (!("body" in result)) throw new Error("Expected a streaming execute response");
    let body = "";
    for await (const chunk of result.body) body += String(chunk);

    expect(attempts.map(({ nodeId }) => nodeId)).toEqual([
      "eias-linegames-wsl",
      "eias-linegames-wsl",
      "eias-linegames",
    ]);
    expect(attempts[0]?.deliveryId).toBe("delivery-argon");
    expect(attempts[1]?.deliveryId).not.toBe("delivery-argon");
    expect(attempts[2]?.deliveryId).not.toBe("delivery-argon");
    expect(attempts[1]?.deliveryId).not.toBe(attempts[2]?.deliveryId);
    expect(row).toMatchObject({
      node_id: "eias-linegames",
      model_preset: "codex-6.1-sol",
      model: "gpt-6.1-sol",
      reasoning_effort: "medium",
    });
    expect(body).toContain('"result":"Sol completed"');
    expect(body).not.toContain('"termination_reason":"limit_hit"');
  });
});

import { describe, expect, it } from "vitest";

import { serializeSessionRow } from "../src/runtime/live_session_serialization.js";
import { InMemoryNodeRegistry } from "../src/node/registry.js";

describe("serializeSessionRow predecessor contract", () => {
  it("exposes the additive predecessorSessionId field", () => {
    expect(serializeSessionRow({
      session_id: "sess-next",
      predecessor_session_id: "sess-previous",
      created_at: new Date("2026-07-14T00:00:00.000Z"),
      updated_at: new Date("2026-07-14T00:00:00.000Z"),
    })).toMatchObject({
      agentSessionId: "sess-next",
      predecessorSessionId: "sess-previous",
    });
  });

  it("exposes the persisted preset/model and lets the preset backend override the profile backend", () => {
    const registry = new InMemoryNodeRegistry();
    registry.registerNode({
      type: "node_register",
      node_id: "node-a",
      host: "127.0.0.1",
      port: 4105,
      agents: [{ id: "agent-a", name: "Agent A", backend: "claude" }],
      supported_backends: ["claude", "codex"],
      model_presets: [{
        id: "codex-5.6-sol",
        label: "Codex - 5.6 Sol",
        backend: "codex",
        available: true,
      }],
    });

    expect(serializeSessionRow({
      session_id: "sess-a",
      node_id: "node-a",
      agent_id: "agent-a",
      model_preset: "codex-5.6-sol",
      model: "gpt-5.6-codex",
      created_at: new Date("2026-07-14T00:00:00.000Z"),
      updated_at: new Date("2026-07-14T00:00:00.000Z"),
    }, { registry })).toMatchObject({
      modelPreset: "codex-5.6-sol",
      modelLabel: "Codex - 5.6 Sol",
      model: "gpt-5.6-codex",
      backend: "codex",
    });
  });

  it("keeps the stored legacy agent id untouched but displays its canonical profile", () => {
    const registry = new InMemoryNodeRegistry();
    registry.registerNode({
      type: "node_register",
      node_id: "node-a",
      agents: [{
        id: "seosoyoung",
        name: "서소영",
        backend: "codex",
        portrait_url: "/api/agents/seosoyoung/portrait",
        aliases: [{ id: "seosoyoung-opus", default_preset: "claude-opus" }],
      }],
      supported_backends: ["claude", "codex"],
    });

    expect(serializeSessionRow({
      session_id: "sess-legacy",
      node_id: "node-a",
      agent_id: "seosoyoung-opus",
      created_at: new Date("2026-07-14T00:00:00.000Z"),
      updated_at: new Date("2026-07-14T00:00:00.000Z"),
    }, { registry })).toMatchObject({
      agentId: "seosoyoung",
      agentName: "서소영",
      agentPortraitUrl: "/api/nodes/node-a/agents/seosoyoung/portrait",
      backend: "codex",
    });
  });
});

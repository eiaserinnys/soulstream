import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { serializeSessionRow } from "../src/runtime/live_session_serialization.js";
import { InMemoryNodeRegistry } from "../src/node/registry.js";

const callerIdentityFixture = JSON.parse(
  readFileSync(
    new URL(
      "../../packages/wire-schema/fixtures/caller_identity_selection.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  cases: Array<{
    name: string;
    metadata: unknown;
    serializedUser: Record<string, unknown>;
  }>;
};

describe("serializeSessionRow predecessor contract", () => {
  it("projects report metadata and the explicit central cache value", () => {
    expect(serializeSessionRow({session_id:'pas',metadata:[{type:'persistent_report',value:{entries:[{key:'r',title:'보고'}]}}]})).toHaveProperty('persistentReport',[{key:'r',title:'보고'}]);
    expect(serializeSessionRow({session_id:'pas',persistent_report:[],metadata:[{type:'persistent_report',value:{entries:[{key:'stale'}]}}]})).toHaveProperty('persistentReport',[]);
    const thread=[{id:'c1',question_id:'q1',author_kind:'user',body:'되묻기',created_at:'2026-11-12T00:00:00.000Z',session_id:'s'}];
    expect(serializeSessionRow({session_id:'pas',metadata:[{type:'persistent_report',value:{entries:[{key:'cq_q1',question_thread:thread}]}}]}))
      .toHaveProperty('persistentReport',[{key:'cq_q1',question_thread:thread}]);
  });
  it("exposes the authoritative cardId and handles unlinked sessions", () => {
    expect(serializeSessionRow({ session_id: "linked", card_id: "card-one" })).toMatchObject({ cardId: "card-one" });
    expect(serializeSessionRow({ session_id: "unlinked" })).toMatchObject({ cardId: null });
  });
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

  it("exposes persistent as a boolean derived from session metadata", () => {
    expect(serializeSessionRow({ session_id: "persistent", metadata: [
      { type: "persistent_session", value: { enabled: true } },
    ] })).toMatchObject({ persistent: true });
    expect(serializeSessionRow({ session_id: "not-persistent" })).toMatchObject({ persistent: false });
    expect(serializeSessionRow({ session_id: "disabled", metadata: [
      { type: "persistent_session", value: { enabled: false } },
    ] })).toMatchObject({ persistent: false });
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
    }, {
      registry,
      agentPortraitUrl: (agentId) => agentId === "seosoyoung" ? `/api/agent-portraits/seosoyoung?v=${"b".repeat(64)}` : "",
    })).toMatchObject({
      agentId: "seosoyoung",
      agentName: "서소영",
      agentPortraitUrl: `/api/agent-portraits/seosoyoung?v=${"b".repeat(64)}`,
      backend: "codex",
    });
  });

  it("uses DB identity fields and aliases while retaining YAML execution fields", () => {
    const registry = new InMemoryNodeRegistry();
    registry.registerNode({
      type: "node_register",
      node_id: "node-a",
      agents: [{
        id: "agent-a",
        name: "YAML Agent",
        backend: "codex",
        aliases: ["yaml-alias"],
      }],
      supported_backends: ["codex"],
    });

    expect(serializeSessionRow({
      session_id: "sess-db",
      node_id: "node-a",
      agent_id: "db-alias",
      created_at: new Date("2026-08-07T00:00:00.000Z"),
      updated_at: new Date("2026-08-07T00:00:00.000Z"),
    }, {
      registry,
      agentProfiles: [{
        agentId: "agent-a",
        name: "DB Agent",
        defaultPreset: null,
        aliases: ["db-alias"],
        hasPortrait: true,
      }],
      agentPortraitUrl: (agentId) => `/api/agent-portraits/${agentId}?v=${"c".repeat(64)}`,
    })).toMatchObject({
      agentId: "agent-a",
      agentName: "DB Agent",
      agentPortraitUrl: `/api/agent-portraits/agent-a?v=${"c".repeat(64)}`,
      backend: "codex",
    });
  });

  it("builds the portrait address from the central list, not from the node that runs the session", () => {
    const registry = new InMemoryNodeRegistry();
    for (const nodeId of ["node-a", "node-b"]) {
      registry.registerNode({
        type: "node_register",
        node_id: nodeId,
        agents: [{ id: "blossom", name: "Blossom", backend: "claude" }],
        supported_backends: ["claude"],
      });
    }
    const agentPortraitUrl = (agentId: string) => agentId === "blossom" ? `/api/agent-portraits/blossom?v=${"d".repeat(64)}` : "";
    const row = (nodeId: string, agentId: string) => serializeSessionRow({
      session_id: `s-${nodeId}-${agentId}`,
      node_id: nodeId,
      agent_id: agentId,
      agent_portrait_url: "/api/nodes/x/agents/y/portrait",
      created_at: new Date("2026-11-25T00:00:00.000Z"),
      updated_at: new Date("2026-11-25T00:00:00.000Z"),
    }, { registry, agentPortraitUrl });

    expect(row("node-a", "blossom").agentPortraitUrl).toBe(`/api/agent-portraits/blossom?v=${"d".repeat(64)}`);
    expect(row("node-b", "blossom").agentPortraitUrl).toBe(`/api/agent-portraits/blossom?v=${"d".repeat(64)}`);
    // 중앙에 초상이 없는 에이전트는 행이 가진 값을 그대로 둔다.
    expect(serializeSessionRow({
      session_id: "s-none", node_id: "node-a", agent_id: "nobody",
      created_at: new Date("2026-11-25T00:00:00.000Z"), updated_at: new Date("2026-11-25T00:00:00.000Z"),
    }, { registry, agentPortraitUrl }).agentPortraitUrl).toBeNull();
  });

  it("matches the shared caller identity selection fixture at the serialized boundary", () => {
    const registry = new InMemoryNodeRegistry();
    registry.registerNode({
      type: "node_register",
      node_id: "node-contract",
      user: { name: "Node owner", hasPortrait: true },
    });

    for (const testCase of callerIdentityFixture.cases) {
      expect(serializeSessionRow({
        session_id: "session-" + testCase.name,
        node_id: "node-contract",
        metadata: testCase.metadata,
        created_at: new Date("2026-09-22T00:00:00.000Z"),
        updated_at: new Date("2026-09-22T00:00:00.000Z"),
      }, { registry }), testCase.name).toMatchObject(testCase.serializedUser);
    }
  });
});

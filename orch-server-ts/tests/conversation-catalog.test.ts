import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConversationCatalog, type ConversationModelReply, type ConversationProfilesReply } from "../src/conversation/conversation_catalog.js";

const modelsFixture = JSON.parse(readFileSync(new URL("./fixtures/conversation-v1/models.json", import.meta.url), "utf8")) as ConversationModelReply;
const profilesFixture = JSON.parse(readFileSync(new URL("./fixtures/conversation-v1/profiles.json", import.meta.url), "utf8")) as ConversationProfilesReply;

describe("conversation catalog", () => {
  it("reads both additive response fixtures as their response types", () => {
    expect(modelsFixture.models[1]).toMatchObject({
      id: "preset-b", available: false, reason: "한도 거부 중", reason_code: "limit_rejected",
      resets_at: "2026-10-30T22:06:34Z", group: { id: "node-a", label: "node-a" },
    });
    expect(profilesFixture.profiles[1]).toMatchObject({
      id: "profile-b", available: false, reason: "노드 연결 끊김",
    });
  });

  it("lists nodes in stable order and marks limited, disconnected, and profile-missing models", async () => {
    const catalog = new ConversationCatalog({
      defaultNodeId: "node-a",
      listNodes: () => [
        { nodeId: "node-c", connected: false },
        { nodeId: "node-b", connected: true },
        { nodeId: "node-a", connected: true },
      ],
      listKnownForNode: (nodeId) => ({
        "node-a": [
          { id: "preset-a", label: "Preset A", available: true, reason: null, reason_label: null, resets_at: null },
          { id: "preset-b", label: "Preset B", available: false, reason: "limit_rejected", reason_label: "한도 거부 중", resets_at: "2026-10-30T22:06:34Z" },
        ],
        "node-b": [{ id: "preset-a", label: "Preset A", available: true, reason: null, reason_label: null, resets_at: null }],
        "node-c": [{ id: "preset-z", label: "Preset Z", available: false, reason: null, reason_label: null, resets_at: null }],
      } as Record<string, any>)[nodeId],
      listAgentProfiles: async (nodeId) => ({
        "node-a": { "profile-a": { name: "Profile A" } },
        "node-b": { "profile-b": { name: "Profile B" } },
        "node-c": undefined,
      } as Record<string, any>)[nodeId],
    });

    const models = await catalog.models("profile-a");
    expect(models.models.map((model) => model.id)).toEqual([
      "preset-a", "preset-b", "n1:node-b:preset-a", "n1:node-c:preset-z",
    ]);
    expect(models.models[1]).toMatchObject({
      available: false, reason: "한도 거부 중", reason_code: "limit_rejected", resets_at: "2026-10-30T22:06:34Z",
    });
    expect(models.models[2]).toMatchObject({
      available: false, reason: "이 노드에 프로필 없음", reason_code: "profile_unavailable",
    });
    expect(models.models[3]).toMatchObject({
      available: false, reason: "노드 연결 끊김", reason_code: "offline",
    });

    const profiles = await catalog.profiles();
    expect(profiles.profiles).toEqual([
      { id: "profile-a", label: "Profile A", available: true },
      { id: "profile-b", label: "Profile B", available: true },
    ]);
  });

  it("resolves legacy model ids to the default node and encodes other node ids", () => {
    const catalog = new ConversationCatalog({
      defaultNodeId: "node/a",
      listNodes: () => [],
      listKnownForNode: () => undefined,
      listAgentProfiles: async () => undefined,
    });
    expect(catalog.resolve("preset:legacy")).toEqual({ nodeId: "node/a", presetId: "preset:legacy" });
    expect(catalog.idFor("node/b:c", "preset/a:b")).toBe("n1:node%2Fb%3Ac:preset%2Fa%3Ab");
    expect(catalog.resolve("n1:node%2Fb%3Ac:preset%2Fa%3Ab")).toEqual({ nodeId: "node/b:c", presetId: "preset/a:b" });
  });
});

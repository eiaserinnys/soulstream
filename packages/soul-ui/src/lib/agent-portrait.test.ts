import { describe, expect, it } from "vitest";

import {
  EMPTY_AGENT_PORTRAIT_DICTIONARY,
  agentPortraitUrl,
  buildAgentPortraitDictionary,
  normalizeAgentPortraitUrl,
} from "./agent-portrait";

const sha = "a".repeat(64);
const dictionary = buildAgentPortraitDictionary({
  portraits: [
    { agent_id: "roselin", sha256: sha, mime: "image/png", byte_size: 4, updated_at: "2026-11-25T00:00:00.000Z", url: `/api/agent-portraits/roselin?v=${sha}` },
    { agent_id: "한글 에이전트", sha256: sha, mime: "image/png", byte_size: 4, updated_at: "2026-11-25T00:00:00.000Z", url: `/api/agent-portraits/${encodeURIComponent("한글 에이전트")}?v=${sha}` },
  ],
});
const current = `/api/agent-portraits/roselin?v=${sha}`;

describe("agentPortraitUrl", () => {
  it("returns the version address or an empty string", () => {
    expect(agentPortraitUrl("roselin", dictionary)).toBe(current);
    expect(agentPortraitUrl("nobody", dictionary)).toBe("");
    expect(agentPortraitUrl(null, dictionary)).toBe("");
    expect(agentPortraitUrl("roselin", EMPTY_AGENT_PORTRAIT_DICTIONARY)).toBe("");
  });
});

describe("normalizeAgentPortraitUrl", () => {
  const rows: Array<[string, string, string]> = [
    ["old node address", "/api/nodes/eiaserinnys/agents/roselin/portrait", current],
    ["old node address, another node", "/api/nodes/silent-manari-ts/agents/roselin/portrait", current],
    ["old agent address", "/api/agents/roselin/portrait", current],
    ["central address without v", "/api/agent-portraits/roselin", current],
    ["central address with a stale v", `/api/agent-portraits/roselin?v=${"0".repeat(64)}`, current],
    ["central address with the current v", current, current],
    ["server origin kept", "https://soulstream.eiaserinnys.me/api/nodes/n/agents/roselin/portrait", `https://soulstream.eiaserinnys.me${current}`],
    ["origin with port kept", "http://localhost:3105/api/agent-portraits/roselin?v=x", `http://localhost:3105${current}`],
    ["encoded agent id", `/api/nodes/n/agents/${encodeURIComponent("한글 에이전트")}/portrait`, `/api/agent-portraits/${encodeURIComponent("한글 에이전트")}?v=${sha}`],
    ["agent not in the dictionary", "/api/nodes/n/agents/nobody/portrait", ""],
    ["central address of an agent not in the dictionary", "/api/agent-portraits/nobody?v=x", ""],
    ["google photo untouched", "https://lh3.googleusercontent.com/a/photo=s96-c", "https://lh3.googleusercontent.com/a/photo=s96-c"],
    ["system portrait untouched", "/api/system/portraits/system", "/api/system/portraits/system"],
    ["static portrait untouched", "/system-portrait.png", "/system-portrait.png"],
    ["user portrait of a node untouched", "/api/nodes/n/user/portrait", "/api/nodes/n/user/portrait"],
    ["empty", "", ""],
  ];
  it.each(rows)("%s", (_label, input, expected) => {
    expect(normalizeAgentPortraitUrl(input, dictionary)).toBe(expected);
  });

  it("returns an empty string for null and undefined", () => {
    expect(normalizeAgentPortraitUrl(null, dictionary)).toBe("");
    expect(normalizeAgentPortraitUrl(undefined, dictionary)).toBe("");
  });
});

describe("buildAgentPortraitDictionary", () => {
  it("builds the address itself when the server omits the url", () => {
    const built = buildAgentPortraitDictionary({
      portraits: [{ agent_id: "keke", sha256: sha, mime: "image/png", byte_size: 1, updated_at: "x", url: "" }],
    });
    expect(built.get("keke")?.url).toBe(`/api/agent-portraits/keke?v=${sha}`);
  });
});

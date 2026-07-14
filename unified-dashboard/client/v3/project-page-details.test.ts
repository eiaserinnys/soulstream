import { describe, expect, it, vi } from "vitest";

import { fetchProjectPageDetails, parseProjectPageDetails } from "./project-page-details";

describe("project page details", () => {
  it("extracts guidance, atom references, and session defaults from project blocks", () => {
    expect(parseProjectPageDetails([
      block("guidance", "프로젝트 지침", { enabled: true }),
      block("guidance", "비활성 지침", { enabled: false }),
      block("atom_ref", "", {
        nodeId: "node-soulstream",
        nodeTitle: "소울스트림",
        depth: 3,
        titlesOnly: false,
      }),
      block("session_defaults", "", { agentId: "roselin_codex", nodeId: "eiaserinnys" }),
    ])).toEqual({
      guidance: ["프로젝트 지침"],
      atomReferences: [{
        nodeId: "node-soulstream",
        nodeTitle: "소울스트림",
        depth: 3,
        titlesOnly: false,
      }],
      sessionDefaults: [{ agentId: "roselin_codex", nodeId: "eiaserinnys" }],
    });
  });

  it("loads project blocks once through the include_blocks page endpoint", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      page: { id: "project/one", title: "Project", version: 1 },
      blocks: [block("guidance", "실제 지침", { enabled: true })],
      state_vector: "AA==",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(fetchProjectPageDetails("project/one", fetch)).resolves.toMatchObject({
      guidance: ["실제 지침"],
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("/api/pages/project%2Fone?include_blocks=true", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
  });
});

function block(blockType: string, text: string, properties: Record<string, unknown>) {
  return {
    id: `${blockType}-${text || "block"}`,
    page_id: "project",
    parent_id: null,
    position: "a0",
    position_key: "a0",
    block_type: blockType,
    text,
    properties,
    collapsed: false,
    created_at: "2026-07-14T00:00:00Z",
    updated_at: "2026-07-14T00:00:00Z",
  };
}

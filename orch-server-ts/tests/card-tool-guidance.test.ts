import { describe, expect, it, vi } from "vitest";
import type { McpToolName } from "@soulstream/mcp-contract";
import { CardVersionConflict } from "../src/cards/control_plane/card_models.js";
import { executeMcpTool } from "../src/mcp/tool_executor.js";
import type { McpCallContext, McpHostOptions } from "../src/mcp/types.js";

const context: McpCallContext = { principal: "internal", callerSessionId: "session-1", nodeId: "node" };
const call = (options: unknown, name: McpToolName, args: Record<string, unknown>) =>
  executeMcpTool(options as McpHostOptions, name, args, context);
const text = (result: { content: { text?: string }[] }) => result.content.map(part => part.text ?? "").join("\n");
type CardBody = { card: { items: { evidence: unknown[] }[] } };
const cardBody = (result: unknown) => (result as { structuredContent: CardBody }).structuredContent;

function cardsOptions(service: Record<string, unknown>) {
  return { cards: {
    provider: { listFolders: () => [], listSessionAssignments: () => ({}) },
    resolveAccess: () => ({ restricted: false, allowedFolderIds: [] }),
    cardServiceProvider: async () => service,
  } };
}

describe("card tool guidance", () => {
  it("tells the caller to re-read the card when expected_version is stale", async () => {
    const service = {
      getCard: vi.fn().mockResolvedValue({ card: { id: "card-uuid", number: 1897, folder_id: "folder-1" } }),
      setCardStatus: vi.fn().mockRejectedValue(new CardVersionConflict("card", "card-uuid", 2, 3, 1897)),
    };
    const result = await call(cardsOptions(service), "set_card_status", {
      card_id: "card-uuid", status: "running", expected_version: 2, idempotency_key: "key-1",
    });
    expect(result.isError).toBe(true);
    const message = text(result);
    expect(message).toContain("#1897");
    expect(message).toContain("읽은 판 2");
    expect(message).toContain("지금 판 3");
    expect(message).toContain("get_card");
    expect(message).not.toContain("folder");
  });

  it("returns evidence summaries from get_card unless items_evidence is requested", async () => {
    const full = { type: "image", label: "결과 화면", url: "https://example.test/a.png", attachment_id: "att-1",
      descriptor: { mime: "image/png" }, read_context: { type: "card", id: "card-uuid" }, previewUrl: "https://example.test/p.png", originalUrl: "https://example.test/a.png" };
    const getCard = vi.fn().mockImplementation(async () => ({
      card: { id: "card-uuid", version: 3, items: [{ id: 1, title: "항목", state: "done", evidence: [{ ...full }] }] },
    }));
    const options = cardsOptions({ mcpRead: { getCard } });

    const summary = await call(options, "get_card", { card_id: "card-uuid" });
    const items = cardBody(summary).card.items;
    expect(items[0]!.evidence).toEqual([{ type: "image", label: "결과 화면", attachment_id: "att-1" }]);

    const detailed = await call(options, "get_card", { card_id: "card-uuid", include: ["items_evidence"] });
    const detailedItems = cardBody(detailed).card.items;
    expect(detailedItems[0]!.evidence).toEqual([full]);
    expect(getCard).toHaveBeenLastCalledWith("card-uuid", expect.not.objectContaining({ include: ["items_evidence"] }), null);
  });

  it("asks for a node name check instead of exposing an internal HTTP path", async () => {
    const cluster = {
      sessions: { router: { waitForNode: vi.fn().mockResolvedValue(undefined) } },
      nodeAgentProfiles: { modelPresetProvider: { listForNode: () => undefined } },
    };
    const result = await call({ cluster }, "list_node_model_presets", { node_id: "no-such-node" });
    expect(result.isError).toBe(true);
    const message = text(result);
    expect(message).not.toContain("/api/");
    expect(message).toContain("no-such-node");
    expect(message).toContain("list_nodes");
    expect(message).toMatch(/[가-힣]/);
  });
});

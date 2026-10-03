import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { registerLiveCardView, LIVE_CARD_RESOURCE, liveCardOutputSchema } from "../../src/mcp/tools/live_card_view.js";

it("live UI cache key advances to the bounded-scroll resource", () =>
  expect(LIVE_CARD_RESOURCE).toBe("ui://soulstream/live-cards-v4.html"));

describe("live card forwarding registration", () => {
  async function harness() {
    const server = new McpServer({ name: "test", version: "1" });
    registerLiveCardView(server, {} as McpRuntime);
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    return { client, close: async () => { await client.close(); await server.close(); } };
  }
  it("registers both tools and the versioned widget resource", async () => {
    const h = await harness();
    try {
      const list = await h.client.listTools();
      expect(list.tools.map(t => t.name)).toEqual(["show_live_card_view", "list_live_cards"]);
      expect((list.tools[0]!._meta?.ui as { resourceUri: string }).resourceUri).toBe(LIVE_CARD_RESOURCE);
      expect((list.tools[1]!._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri).toBeUndefined();
      const resource = await h.client.readResource({ uri: LIVE_CARD_RESOURCE });
      expect(resource.contents[0]!.mimeType).toBe("text/html;profile=mcp-app");
    } finally { await h.close(); }
  });
  it("publishes a strict exclusive output schema and validates success and sync error results", async () => {
    const h = await harness();
    try {
      const tools = await h.client.listTools();
      expect(tools.tools).toHaveLength(2);
      for (const tool of tools.tools) expect(tool.outputSchema).toMatchObject({
        type: "object", anyOf: [expect.any(Object), expect.any(Object)],
        properties: { syncError: expect.any(Object) }, additionalProperties: false,
      });
      const result = { cards: [], total: 0, truncated: false,
        sync: { folderId: null, limit: 100, refreshSeconds: 30, fetchedAt: "2026-10-02T00:00:00.000Z" } };
      expect(liveCardOutputSchema.safeParse(result).success).toBe(true);
      const withPreview = { ...result, cards: [{ id: "1", title: "카드", status: "todo", assignee: "", updatedAt: null,
        preview: { kind: "report", text: "가".repeat(500) } }] };
      expect(liveCardOutputSchema.safeParse(withPreview).success).toBe(true);
      expect(liveCardOutputSchema.safeParse({ ...withPreview, cards: [{ ...withPreview.cards[0],
        preview: { kind: "report", text: "가".repeat(501) } }] }).success).toBe(false);
      expect(liveCardOutputSchema.safeParse({ syncError: { authorization: true } }).success).toBe(true);
      expect(liveCardOutputSchema.safeParse({ syncError: { authorization: false } }).success).toBe(true);
      expect(liveCardOutputSchema.safeParse({}).success).toBe(false);
      expect(liveCardOutputSchema.safeParse({ cards: [] }).success).toBe(false);
      expect(liveCardOutputSchema.safeParse({ ...result, syncError: { authorization: true } }).success).toBe(false);
    } finally { await h.close(); }
  });
});

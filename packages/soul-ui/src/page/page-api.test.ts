import { describe, expect, it, vi } from "vitest";

import { createPageApiClient } from "./page-api";

describe("page API client", () => {
  it("uses the authenticated browser routes and preserves query contracts", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [], next_cursor: null }))
      .mockResolvedValueOnce(jsonResponse({ page: page(), blocks: [], state_vector: "AA==" }))
      .mockResolvedValueOnce(jsonResponse({ page: page(), created: false }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ pageId: "page-1", title: "Page" }] }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ blockId: "block-1", pageId: "page-1", pageTitle: "Page", textPreview: "Block" }] }))
      .mockResolvedValueOnce(jsonResponse({ id: "block-1", pageId: "page-1" }))
      .mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: "next cursor" }))
      .mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }));
    const client = createPageApiClient({ fetch });

    await client.listPages({ starred: true, cursor: "cursor 1", limit: 25 });
    await client.getPage("page/one");
    await client.getDailyPage("2026-07-12");
    await client.searchPages("Daily note", 12);
    await client.searchBlocks("Decision", 8);
    await client.getBlock("block/one");
    await client.getBacklinks("page/one", {
      kinds: ["mount", "block_ref"],
      cursor: "cursor 2",
      limit: 15,
    });
    await client.getBacklinks("page/one", { includeSelf: true });

    expect(fetch).toHaveBeenNthCalledWith(1, "/api/pages?starred=true&cursor=cursor+1&limit=25", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/pages/page%2Fone", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    expect(fetch).toHaveBeenNthCalledWith(3, "/api/pages/daily", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({ date: "2026-07-12" }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(4, "/api/pages/search?q=Daily+note&limit=12", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    expect(fetch).toHaveBeenNthCalledWith(5, "/api/blocks/search?q=Decision&limit=8", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    expect(fetch).toHaveBeenNthCalledWith(6, "/api/blocks/block%2Fone", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    expect(fetch).toHaveBeenNthCalledWith(
      7,
      "/api/pages/page%2Fone/backlinks?kinds=mount%2Cblock_ref&cursor=cursor+2&limit=15",
      { credentials: "same-origin", headers: { Accept: "application/json" } },
    );
    expect(fetch).toHaveBeenNthCalledWith(
      8,
      "/api/pages/page%2Fone/backlinks?include_self=true",
      { credentials: "same-origin", headers: { Accept: "application/json" } },
    );
  });

  it("keeps structural mutations on HTTP and encodes the Yjs state vector", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({
        page: page(),
        blocks: [],
        operation: { id: "op-1" },
        temp_id_mapping: { draft: "block-1" },
      }));
    const client = createPageApiClient({ fetch });

    await client.applyOperations("page-1", {
      expectedVersion: 4,
      expectedStateVector: Uint8Array.of(0, 1, 2),
      idempotencyKey: "request-1",
      operations: [{
        op: "create_block",
        temp_id: "draft",
        parent_id: null,
        after_block_id: null,
        block_type: "paragraph",
        text: "New",
        properties: {},
      }],
    });

    expect(fetch).toHaveBeenCalledWith("/api/pages/page-1/operations", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        expected_version: 4,
        expected_state_vector: "AAEC",
        idempotency_key: "request-1",
        operations: [{
          op: "create_block",
          temp_id: "draft",
          parent_id: null,
          after_block_id: null,
          block_type: "paragraph",
          text: "New",
          properties: {},
        }],
      }),
    }));
  });

  it("sends source and target CAS in one additive block-transfer request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({
      source: { page: page(), blocks: [], operation: { id: "source-op" }, temp_id_mapping: {} },
      target: { page: { ...page(), id: "target" }, blocks: [], operation: { id: "target-op" }, temp_id_mapping: {} },
      target_created: false,
    }));
    const client = createPageApiClient({ fetch });

    await client.transferBlocks({
      source: {
        pageId: "source",
        expectedVersion: 3,
        expectedStateVector: Uint8Array.of(0, 1),
        blockIds: ["block-1"],
      },
      target: {
        kind: "existing",
        pageId: "target",
        expectedVersion: 5,
        expectedStateVector: Uint8Array.of(2, 3),
        parentId: null,
        afterBlockId: "anchor",
      },
      sourceMount: { title: "Target", tempId: "mount" },
      idempotencyKey: "transfer-1",
    });

    expect(fetch).toHaveBeenCalledWith("/api/pages/block-transfers", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        source: {
          page_id: "source",
          expected_version: 3,
          expected_state_vector: "AAE=",
          block_ids: ["block-1"],
        },
        target: {
          kind: "existing",
          page_id: "target",
          expected_version: 5,
          expected_state_vector: "AgM=",
          parent_id: null,
          after_block_id: "anchor",
        },
        source_mount: { title: "Target", temp_id: "mount" },
        idempotency_key: "transfer-1",
      }),
    }));
  });

  it("surfaces authentication and conflict failures without fallback", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ detail: "Authentication required" }, 401))
      .mockResolvedValueOnce(jsonResponse({ detail: "state vector conflict" }, 409));
    const client = createPageApiClient({ fetch });

    await expect(client.getPage("page-1")).rejects.toMatchObject({
      name: "PageApiError",
      status: 401,
      kind: "authentication",
    });
    await expect(client.setStarred("page-1", {
      starred: true,
      expectedVersion: 2,
      idempotencyKey: "star-1",
    })).rejects.toMatchObject({ status: 409, kind: "conflict" });
  });
});

function page() {
  return {
    id: "page-1",
    title: "Page",
    daily_date: null,
    version: 1,
    archived: false,
    metadata: {},
    created_at: "2026-07-12T00:00:00.000Z",
    updated_at: "2026-07-12T00:00:00.000Z",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

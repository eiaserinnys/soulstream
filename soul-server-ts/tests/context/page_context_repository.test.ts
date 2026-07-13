import { describe, expect, it, vi } from "vitest";

import {
  HostPageContextRepository,
} from "../../src/context/page_context_repository.js";

describe("HostPageContextRepository", () => {
  it("uses the durable explicit binding as the only page anchor source", async () => {
    const bindings = {
      get: vi.fn(async () => ({
        target_page_id: "page-1",
        target_block_id: "block-1",
      })),
    };
    const repository = new HostPageContextRepository(bindings as never, {} as never);

    await expect(repository.getAnchor("sess-1")).resolves.toEqual({
      pageId: "page-1",
      blockId: "block-1",
    });
    expect(bindings.get).toHaveBeenCalledWith("sess-1");
  });

  it("does not treat a daily no-anchor binding as page-owned context", async () => {
    const bindings = {
      get: vi.fn(async () => ({ target_page_id: null, target_block_id: null })),
    };
    const repository = new HostPageContextRepository(bindings as never, {} as never);
    await expect(repository.getAnchor("sess-1")).resolves.toBeNull();
  });

  it("reads blocks through the owner-routed page host instead of a worker-local page store", async () => {
    const result = { page: { id: "page-1" }, blocks: [{ id: "block-1" }] };
    const pageHost = { getPage: vi.fn().mockResolvedValue(result) };
    const repository = new HostPageContextRepository({} as never, pageHost as never);

    await expect(repository.getPage("page-1")).resolves.toEqual(result);
    expect(pageHost.getPage).toHaveBeenCalledWith("page-1", true);
  });

  it("reads complete mount backlink pagination through the orch host client", async () => {
    const pageHost = {
      getBacklinks: vi.fn()
        .mockResolvedValueOnce({
          items: [
            { source_page_id: "page-b", source_block_id: "mount-b" },
            { source_page_id: "page-a", source_block_id: "mount-a" },
          ],
          next_cursor: "cursor-2",
        })
        .mockResolvedValueOnce({
          items: [
            { source_page_id: "page-a", source_block_id: "mount-a" },
            { source_page_id: "page-c", source_block_id: "mount-c" },
          ],
          next_cursor: null,
        }),
    };
    const repository = new HostPageContextRepository({} as never, pageHost as never);

    await expect(repository.listMountParents("target")).resolves.toEqual({
      items: [
        { pageId: "page-a", blockId: "mount-a" },
        { pageId: "page-b", blockId: "mount-b" },
        { pageId: "page-c", blockId: "mount-c" },
      ],
      truncated: false,
    });
    expect(pageHost.getBacklinks).toHaveBeenNthCalledWith(1, {
      pageId: "target",
      kinds: ["mount"],
      limit: 200,
    });
    expect(pageHost.getBacklinks).toHaveBeenNthCalledWith(2, {
      pageId: "target",
      kinds: ["mount"],
      cursor: "cursor-2",
      limit: 200,
    });
  });
});

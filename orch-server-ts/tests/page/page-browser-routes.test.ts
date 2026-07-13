import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  pageBrowserRouteAuthRequirements,
  registerPageBrowserRoutes,
  type PageBrowserRouteOptions,
} from "../../src/page/page_browser_routes.js";
import {
  PageMutationStateVectorConflictError,
  PageMutationVersionConflictError,
} from "../../src/page/page_mutation_core.js";
import { PageBrowserBacklinkCursorError } from "../../src/page/page_repository_reads.js";

const browserCookie = "soul_dashboard_auth=dashboard-token";

describe("browser page routes", () => {
  it("keeps service bearer outside the browser surface and lists with an authenticated user", async () => {
    const service = serviceDouble();
    const resolveUser = cookieUserResolver();
    const app = Fastify({ logger: false });
    registerPageBrowserRoutes(app, { service, reads: service, resolveUser });
    try {
      const serviceBearer = await app.inject({
        method: "GET",
        url: "/api/pages",
        headers: { authorization: "Bearer service-token" },
      });
      expect(serviceBearer.statusCode).toBe(401);
      expect(service.listPages).not.toHaveBeenCalled();

      const response = await app.inject({
        method: "GET",
        url: "/api/pages?starred=true&cursor=cursor-1&limit=25",
        headers: { cookie: browserCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        items: [expect.objectContaining({ id: "page-1" })],
        next_cursor: null,
      });
      expect(service.listPages).toHaveBeenCalledWith({
        starred: true,
        cursor: "cursor-1",
        limit: 25,
      });
      expect(resolveUser).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("reads browser bootstrap state and creates the KST daily page with user provenance", async () => {
    const service = serviceDouble();
    const app = Fastify({ logger: false });
    registerPageBrowserRoutes(app, { service, reads: service, resolveUser: cookieUserResolver() });
    try {
      const read = await app.inject({
        method: "GET",
        url: "/api/pages/page-1",
        headers: { cookie: browserCookie },
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({
        page: { id: "page-1" },
        state_vector: "AA==",
      });
      expect(service.getBrowserPage).toHaveBeenCalledWith("page-1");

      const daily = await app.inject({
        method: "POST",
        url: "/api/pages/daily",
        headers: { cookie: browserCookie },
        payload: { date: "2026-07-12" },
      });
      expect(daily.statusCode).toBe(200);
      expect(service.getDailyPage).toHaveBeenCalledWith({
        date: "2026-07-12",
        actor: { actorKind: "user", actorUserId: "user@example.com" },
      });
    } finally {
      await app.close();
    }
  });

  it("requires state-vector CAS for structural batch and exposes explicit star mutation", async () => {
    const service = serviceDouble();
    const app = Fastify({ logger: false });
    registerPageBrowserRoutes(app, { service, reads: service, resolveUser: cookieUserResolver() });
    try {
      const batch = await app.inject({
        method: "POST",
        url: "/api/pages/page-1/operations",
        headers: { cookie: browserCookie },
        payload: {
          expected_version: 4,
          expected_state_vector: "AAEC",
          idempotency_key: "batch_page_operations:user@example.com:req-1",
          operations: [{
            op: "create_block",
            temp_id: "new-block",
            parent_id: null,
            after_block_id: null,
            block_type: "paragraph",
            text: "New",
            properties: {},
          }],
        },
      });
      expect(batch.statusCode).toBe(200);
      expect(service.mutatePage).toHaveBeenCalledWith(expect.objectContaining({
        pageId: "page-1",
        expectedVersion: 4,
        expectedStateVector: Uint8Array.of(0, 1, 2),
        actor: { actorKind: "user", actorUserId: "user@example.com" },
        idempotencyKey:
          "browser_page:user@example.com:page-1:batch_page_operations:user@example.com:req-1",
        command: {
          type: "batch_operations",
          operations: [expect.objectContaining({
            op: "create_block",
            tempId: "new-block",
            parentId: null,
            afterBlockId: null,
          })],
        },
      }));

      const starred = await app.inject({
        method: "PATCH",
        url: "/api/pages/page-1/starred",
        headers: { cookie: browserCookie },
        payload: {
          starred: true,
          expected_version: 5,
          idempotency_key: "set_page_starred:user@example.com:req-2",
        },
      });
      expect(starred.statusCode).toBe(200);
      expect(service.mutatePage).toHaveBeenLastCalledWith(expect.objectContaining({
        pageId: "page-1",
        expectedVersion: 5,
        actor: { actorKind: "user", actorUserId: "user@example.com" },
        idempotencyKey:
          "browser_page:user@example.com:page-1:set_page_starred:user@example.com:req-2",
        command: { type: "set_page_starred", starred: true },
      }));
    } finally {
      await app.close();
    }
  });

  it("rejects malformed state vectors and maps both CAS conflicts to 409", async () => {
    const service = serviceDouble();
    const app = Fastify({ logger: false });
    registerPageBrowserRoutes(app, { service, reads: service, resolveUser: cookieUserResolver() });
    try {
      const invalid = await app.inject({
        method: "POST",
        url: "/api/pages/page-1/operations",
        headers: { cookie: browserCookie },
        payload: mutationPayload("not base64!"),
      });
      expect(invalid.statusCode).toBe(422);

      vi.mocked(service.mutatePage)
        .mockRejectedValueOnce(new PageMutationVersionConflictError("page-1", 1, 2))
        .mockRejectedValueOnce(new PageMutationStateVectorConflictError("page-1"));
      for (const idempotencyKey of ["version-conflict", "vector-conflict"]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/pages/page-1/operations",
          headers: { cookie: browserCookie },
          payload: {
            ...mutationPayload("AA=="),
            idempotency_key: idempotencyKey,
          },
        });
        expect(response.statusCode).toBe(409);
      }
    } finally {
      await app.close();
    }
  });

  it("exposes authenticated prefix search, block read, and canonical backlinks queries", async () => {
    const service = serviceDouble();
    const app = Fastify({ logger: false });
    registerPageBrowserRoutes(app, { service, reads: service, resolveUser: cookieUserResolver() });
    try {
      const pageSearch = await app.inject({
        method: "GET",
        url: "/api/pages/search?q=%20Page%20&limit=7",
        headers: { cookie: browserCookie },
      });
      expect(pageSearch.statusCode).toBe(200);
      expect(service.searchBrowserPages).toHaveBeenCalledWith({ query: "Page", limit: 7 });

      const blockSearch = await app.inject({
        method: "GET",
        url: "/api/blocks/search?q=%20Block%20",
        headers: { cookie: browserCookie },
      });
      expect(blockSearch.statusCode).toBe(200);
      expect(service.searchBrowserBlocks).toHaveBeenCalledWith({ query: "Block", limit: 20 });

      const block = await app.inject({
        method: "GET",
        url: "/api/blocks/block-1",
        headers: { cookie: browserCookie },
      });
      expect(block.statusCode).toBe(200);
      expect(service.getBrowserBlock).toHaveBeenCalledWith("block-1");

      const backlinks = await app.inject({
        method: "GET",
        url: "/api/pages/page-1/backlinks?kinds=block_ref,mount,mount&cursor=cursor-1&limit=3",
        headers: { cookie: browserCookie },
      });
      expect(backlinks.statusCode).toBe(200);
      expect(service.getBrowserBacklinks).toHaveBeenCalledWith({
        pageId: "page-1",
        kinds: ["mount", "block_ref"],
        cursor: "cursor-1",
        limit: 3,
      });
    } finally {
      await app.close();
    }
  });

  it("rejects unauthenticated, empty, oversized, and malformed search/backlink queries", async () => {
    const service = serviceDouble();
    const app = Fastify({ logger: false });
    registerPageBrowserRoutes(app, { service, reads: service, resolveUser: cookieUserResolver() });
    try {
      const unauthenticated = await app.inject({ method: "GET", url: "/api/pages/search?q=Page" });
      expect(unauthenticated.statusCode).toBe(401);

      for (const url of [
        "/api/pages/search?q=%20%20",
        `/api/pages/search?q=${"x".repeat(201)}`,
        "/api/blocks/search?q=Block&limit=0",
        "/api/blocks/search?q=Block&limit=51",
        "/api/pages/page-1/backlinks?kinds=unknown",
        "/api/pages/page-1/backlinks?kinds=",
      ]) {
        const response = await app.inject({
          method: "GET",
          url,
          headers: { cookie: browserCookie },
        });
        expect(response.statusCode, url).toBe(422);
      }

      vi.mocked(service.getBrowserBacklinks).mockRejectedValueOnce(
        new PageBrowserBacklinkCursorError("invalid browser backlink cursor"),
      );
      const invalidCursor = await app.inject({
        method: "GET",
        url: "/api/pages/page-1/backlinks?cursor=tampered",
        headers: { cookie: browserCookie },
      });
      expect(invalidCursor.statusCode).toBe(422);

      vi.mocked(service.getBrowserBlock).mockResolvedValueOnce(null);
      const deletedBlock = await app.inject({
        method: "GET",
        url: "/api/blocks/deleted",
        headers: { cookie: browserCookie },
      });
      expect(deletedBlock.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("declares every browser route as authenticated", () => {
    expect(pageBrowserRouteAuthRequirements).toEqual({
      "GET /api/pages": true,
      "GET /api/pages/search": true,
      "GET /api/pages/{pageId}": true,
      "GET /api/pages/{pageId}/backlinks": true,
      "GET /api/blocks/search": true,
      "GET /api/blocks/{blockId}": true,
      "POST /api/pages/daily": true,
      "POST /api/pages/{pageId}/operations": true,
      "PATCH /api/pages/{pageId}/starred": true,
    });
  });
});

function cookieUserResolver() {
  return vi.fn(async (request: FastifyRequest) =>
    request.headers.cookie === browserCookie
      ? { email: "user@example.com" }
      : null);
}

function mutationPayload(expectedStateVector: string) {
  return {
    expected_version: 1,
    expected_state_vector: expectedStateVector,
    idempotency_key: "batch_page_operations:user@example.com:req",
    operations: [{ op: "rename_page", title: "Renamed" }],
  };
}

type BrowserServiceDouble = PageBrowserRouteOptions["service"] & {
  listPages: ReturnType<typeof vi.fn>;
  getBrowserPage: ReturnType<typeof vi.fn>;
  getDailyPage: ReturnType<typeof vi.fn>;
  mutatePage: ReturnType<typeof vi.fn>;
  searchBrowserPages: ReturnType<typeof vi.fn>;
  searchBrowserBlocks: ReturnType<typeof vi.fn>;
  getBrowserBlock: ReturnType<typeof vi.fn>;
  getBrowserBacklinks: ReturnType<typeof vi.fn>;
};

function serviceDouble(): BrowserServiceDouble {
  const page = {
    id: "page-1",
    title: "Page",
    daily_date: null,
    version: 1,
    archived: false,
    metadata: {},
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z",
  };
  const mutation = {
    page,
    blocks: [],
    operation: { id: "operation-1" },
    temp_id_mapping: {},
  };
  return {
    listPages: vi.fn().mockResolvedValue({ items: [page], next_cursor: null }),
    getBrowserPage: vi.fn().mockResolvedValue({ page, blocks: [], state_vector: "AA==" }),
    getDailyPage: vi.fn().mockResolvedValue({ page, created: false }),
    mutatePage: vi.fn().mockResolvedValue(mutation),
    searchBrowserPages: vi.fn().mockResolvedValue({
      items: [{ pageId: "page-1", title: "Page" }],
    }),
    searchBrowserBlocks: vi.fn().mockResolvedValue({
      items: [{ blockId: "block-1", pageId: "page-1", pageTitle: "Page", textPreview: "Block" }],
    }),
    getBrowserBlock: vi.fn().mockResolvedValue({
      id: "block-1",
      pageId: "page-1",
      pageTitle: "Page",
      parentId: null,
      positionKey: "a",
      blockType: "paragraph",
      text: "Block",
      properties: {},
      collapsed: false,
    }),
    getBrowserBacklinks: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  } as unknown as BrowserServiceDouble;
}

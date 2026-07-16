import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  registerPageYjsHostOperationRoutes,
} from "../../src/page/page_host_operations.js";
import { PageMutationVersionConflictError } from "../../src/page/page_mutation_core.js";
import { PageYjsPageNotFoundError } from "../../src/page/page_yjs_persistence.js";
import type { PageYjsService } from "../../src/page/page_service.js";

describe("orch-local Page Yjs host operation routes", () => {
  it("requires a service bearer and validates the Zod boundary", async () => {
    const app = Fastify({ logger: false });
    registerPageYjsHostOperationRoutes(app, {
      service: serviceDouble(),
      authBearerToken: "service-token",
    });
    try {
      const unauthorized = await app.inject({
        method: "POST",
        url: "/api/page-yjs/host/create-page",
        headers: { cookie: "soulstream_auth=dashboard-token" },
        payload: createPagePayload(),
      });
      expect(unauthorized.statusCode).toBe(401);
      expect(unauthorized.json()).toMatchObject({ detail: { error: { code: "UNAUTHORIZED" } } });

      const invalid = await app.inject({
        method: "POST",
        url: "/api/page-yjs/host/create-page",
        headers: { authorization: "Bearer service-token" },
        payload: { page: {} },
      });
      expect(invalid.statusCode).toBe(422);
      expect(invalid.json()).toMatchObject({
        detail: { error: { code: "INVALID_PAGE_YJS_HOST_REQUEST" } },
      });
    } finally {
      await app.close();
    }
  });

  it("dispatches create and all mutation aliases to the same local service", async () => {
    const service = serviceDouble();
    const app = Fastify({ logger: false });
    registerPageYjsHostOperationRoutes(app, {
      service,
      authBearerToken: "service-token",
    });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/page-yjs/host/create-page",
        headers: { authorization: "Bearer service-token" },
        payload: createPagePayload(),
      });
      expect(created.statusCode).toBe(200);
      expect(service.createPage).toHaveBeenCalledWith({
        page: { id: "page-1", title: "Page", dailyDate: null, metadata: {} },
        actor: { actorKind: "agent", actorSessionId: "agent-session", actorUserId: null },
        idempotencyKey: "create_page:agent-session:req-1",
        reason: null,
      });

      const batch = await app.inject({
        method: "POST",
        url: "/api/page-yjs/host/batch-page-operations",
        headers: { authorization: "Bearer service-token" },
        payload: {
          page_id: "page-1",
          expected_version: 1,
          operations: [{ op: "rename_page", title: "Renamed" }],
          actor_kind: "agent",
          actor_session_id: "agent-session",
          idempotency_key: "batch_page_operations:agent-session:req-2",
        },
      });
      expect(batch.statusCode).toBe(200);
      expect(service.mutatePage).toHaveBeenCalledWith(expect.objectContaining({
        pageId: "page-1",
        expectedVersion: 1,
        command: { type: "batch_operations", operations: [{ op: "rename_page", title: "Renamed" }] },
      }));

      const renamed = await app.inject({
        method: "POST",
        url: "/api/page-yjs/host/rename-page",
        headers: { authorization: "Bearer service-token" },
        payload: {
          page_id: "page-1",
          expected_version: 2,
          title: "Again",
          actor_kind: "user",
          actor_user_id: "user-1",
          idempotency_key: "rename_page:user-1:req-3",
        },
      });
      expect(renamed.statusCode).toBe(200);
      expect(service.mutatePage).toHaveBeenCalledWith(expect.objectContaining({
        command: { type: "rename_page", title: "Again" },
        actor: { actorKind: "user", actorSessionId: null, actorUserId: "user-1" },
      }));
    } finally {
      await app.close();
    }
  });

  it("dispatches read operations, strips omitted blocks, and applies backlink defaults", async () => {
    const service = serviceDouble();
    const app = Fastify({ logger: false });
    registerPageYjsHostOperationRoutes(app, { service, authBearerToken: "service-token" });
    try {
      const headers = { authorization: "Bearer service-token" };
      const page = await app.inject({
        method: "POST",
        url: "/api/page-yjs/host/get-page",
        headers,
        payload: { page_id: "page-1", include_blocks: false },
      });
      expect(page.statusCode).toBe(200);
      expect(page.json()).toEqual({ page: expect.objectContaining({ id: "page-1" }) });

      const found = await app.inject({
        method: "POST",
        url: "/api/page-yjs/host/find-page",
        headers,
        payload: { title: " Page " },
      });
      expect(found.statusCode).toBe(200);
      expect(service.findPage).toHaveBeenCalledWith("Page");

      await app.inject({
        method: "POST",
        url: "/api/page-yjs/host/get-backlinks",
        headers,
        payload: { page_id: "page-1" },
      });
      expect(service.getBacklinks).toHaveBeenCalledWith({
        pageId: "page-1",
        kinds: ["mount", "inline_page", "block_ref"],
        cursor: undefined,
        includeSelf: false,
        limit: 50,
      });

      await app.inject({
        method: "POST",
        url: "/api/page-yjs/host/get-backlinks",
        headers,
        payload: { page_id: "page-1", include_self: true },
      });
      expect(service.getBacklinks).toHaveBeenLastCalledWith(expect.objectContaining({
        pageId: "page-1",
        includeSelf: true,
      }));
    } finally {
      await app.close();
    }
  });

  it("returns PAGE_NOT_FOUND instead of a snapshot invariant error for an unknown page", async () => {
    const service = serviceDouble();
    vi.spyOn(service, "getPage")
      .mockRejectedValue(new PageYjsPageNotFoundError("missing-page"));
    const app = Fastify({ logger: false });
    registerPageYjsHostOperationRoutes(app, { service, authBearerToken: "service-token" });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/page-yjs/host/get-page",
        headers: { authorization: "Bearer service-token" },
        payload: { page_id: "missing-page" },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        detail: {
          error: {
            code: "PAGE_NOT_FOUND",
            message: "page not found: missing-page",
          },
        },
      });
    } finally {
      await app.close();
    }
  });

  it("delegates daily get-or-create with agent provenance and no client idempotency key", async () => {
    const service = serviceDouble();
    const app = Fastify({ logger: false });
    registerPageYjsHostOperationRoutes(app, { service, authBearerToken: "service-token" });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/page-yjs/host/get-daily-page",
        headers: { authorization: "Bearer service-token" },
        payload: {
          date: "2026-07-12",
          actor_kind: "agent",
          actor_session_id: "agent-session",
        },
      });
      expect(response.statusCode).toBe(200);
      expect(service.getDailyPage).toHaveBeenCalledWith({
        date: "2026-07-12",
        actor: { actorKind: "agent", actorSessionId: "agent-session", actorUserId: null },
      });
    } finally {
      await app.close();
    }
  });

  it("maps mutation conflicts and isolates unexpected failures to the request", async () => {
    const service = serviceDouble();
    vi.mocked(service.mutatePage)
      .mockRejectedValueOnce(new PageMutationVersionConflictError("page-1", 1, 2))
      .mockRejectedValueOnce(new Error("write failed"));
    const app = Fastify({ logger: false });
    registerPageYjsHostOperationRoutes(app, {
      service,
      authBearerToken: "service-token",
    });
    try {
      const payload = {
        page_id: "page-1",
        expected_version: 1,
        actor_kind: "system",
        idempotency_key: "archive_page:system:req",
      };
      const conflict = await app.inject({
        method: "POST",
        url: "/api/page-yjs/host/archive-page",
        headers: { authorization: "Bearer service-token" },
        payload,
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({
        detail: { error: { code: "PAGE_MUTATION_VERSION_CONFLICT" } },
      });

      const failed = await app.inject({
        method: "POST",
        url: "/api/page-yjs/host/archive-page",
        headers: { authorization: "Bearer service-token" },
        payload: { ...payload, idempotency_key: "archive_page:system:req-2" },
      });
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toEqual({
        detail: { error: { code: "PAGE_YJS_HOST_OPERATION_FAILED", message: "write failed" } },
      });
    } finally {
      await app.close();
    }
  });
});

function createPagePayload() {
  return {
    page: { id: "page-1", title: "Page", daily_date: null, metadata: {} },
    actor_kind: "agent",
    actor_session_id: "agent-session",
    idempotency_key: "create_page:agent-session:req-1",
  };
}

function serviceDouble() {
  const result = {
    page: { id: "page-1", title: "Page", version: 1 },
    blocks: [],
    operation: { id: "operation-1" },
    temp_id_mapping: {},
  };
  return {
    createPage: vi.fn().mockResolvedValue(result),
    mutatePage: vi.fn().mockResolvedValue(result),
    getPage: vi.fn().mockResolvedValue(result),
    findPage: vi.fn().mockResolvedValue(result.page),
    getBacklinks: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    getDailyPage: vi.fn().mockResolvedValue({ page: result.page, created: false }),
  } as unknown as PageYjsService;
}

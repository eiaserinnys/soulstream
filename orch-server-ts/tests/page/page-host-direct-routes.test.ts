import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  registerPageYjsHostOperationRoutes,
} from "../../src/page/page_host_operations.js";
import { PageMutationVersionConflictError } from "../../src/page/page_mutation_core.js";
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
  } as unknown as PageYjsService;
}

import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DASHBOARD_AUTH_COOKIE_NAME } from "../../src/collaboration/board_yjs_auth.js";
import { RunbookVersionConflict } from "../../src/runbook/runbook_models.js";
import type { RunbookService } from "../../src/runbook/runbook_service.js";
import { buildServer, type ServerInstance } from "../../src/server.js";

const openServers: ServerInstance[] = [];

afterEach(async () => {
  while (openServers.length > 0) await openServers.pop()?.close();
});

describe("runbook browser CRUD routes", () => {
  it("creates sections as the authenticated dashboard user", async () => {
    const service = fakeRunbookService();
    const server = await createServer(service);

    const response = await server.inject({
      method: "POST",
      url: "/api/runbooks/rb-1/sections",
      headers: dashboardCookie("operator@example.com"),
      payload: {
        sectionId: "sec-new",
        title: "사용자 섹션",
        afterSectionId: "sec-1",
        idempotencyKey: "create-section-1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(service.createSection).toHaveBeenCalledWith({
      actorKind: "user",
      actorSessionId: "sess-runbook",
      actorUserId: "operator@example.com",
      runbookId: "rb-1",
      sectionId: "sec-new",
      title: "사용자 섹션",
      afterSectionId: "sec-1",
      beforeSectionId: null,
      idempotencyKey: "create-section-1",
    });
    expect(response.json()).toMatchObject({
      ok: true,
      runbookId: "rb-1",
      operation: { operation_type: "create_runbook_section" },
      snapshot: { runbook: { id: "rb-1" } },
    });
  });

  it("updates item title and how_to without replacing the user actor with a session actor", async () => {
    const service = fakeRunbookService();
    const server = await createServer(service);

    const response = await server.inject({
      method: "POST",
      url: "/api/runbooks/rb-1/items/item-1",
      headers: dashboardCookie("operator@example.com"),
      payload: {
        title: "수정된 항목",
        howTo: "새 절차",
        expectedVersion: 3,
        idempotencyKey: "update-item-1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(service.patchItem).toHaveBeenCalledWith({
      actorKind: "user",
      actorSessionId: "sess-item",
      actorUserId: "operator@example.com",
      runbookId: "rb-1",
      itemId: "item-1",
      expectedVersion: 3,
      title: "수정된 항목",
      howTo: "새 절차",
      reason: null,
      idempotencyKey: "update-item-1",
    });
  });

  it("passes section move bounds and expected_version to the canonical service", async () => {
    const service = fakeRunbookService();
    const server = await createServer(service);

    const response = await server.inject({
      method: "POST",
      url: "/api/runbooks/rb-1/sections/sec-1/move",
      headers: dashboardCookie("operator@example.com"),
      payload: {
        expectedVersion: 4,
        beforeSectionId: "sec-0",
        idempotencyKey: "move-section-1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(service.moveSection).toHaveBeenCalledWith(expect.objectContaining({
      actorKind: "user",
      actorSessionId: "sess-section",
      actorUserId: "operator@example.com",
      runbookId: "rb-1",
      sectionId: "sec-1",
      expectedVersion: 4,
      beforeSectionId: "sec-0",
      afterSectionId: null,
      idempotencyKey: "move-section-1",
    }));
  });

  it("archives items through patchItem and preserves CAS conflicts", async () => {
    const service = fakeRunbookService();
    service.patchItem.mockRejectedValueOnce(
      new RunbookVersionConflict("item", "item-1", 2, 3),
    );
    const server = await createServer(service);

    const response = await server.inject({
      method: "POST",
      url: "/api/runbooks/rb-1/items/item-1/archive",
      headers: dashboardCookie("operator@example.com"),
      payload: {
        expectedVersion: 2,
        idempotencyKey: "archive-item-1",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(service.patchItem).toHaveBeenCalledWith(expect.objectContaining({
      actorKind: "user",
      actorUserId: "operator@example.com",
      itemId: "item-1",
      expectedVersion: 2,
      archived: true,
    }));
    expect(response.json()).toMatchObject({
      detail: { error: { code: "RUNBOOK_VERSION_CONFLICT" } },
    });
  });

  it("maps the remaining section and item operations to their existing service methods", async () => {
    const service = fakeRunbookService();
    const server = await createServer(service);
    const headers = dashboardCookie("operator@example.com");

    const cases = [
      {
        url: "/api/runbooks/rb-1/sections/sec-1",
        payload: { title: "Renamed", expectedVersion: 2, idempotencyKey: "update-section" },
        spy: service.patchSection,
        expected: { sectionId: "sec-1", title: "Renamed", expectedVersion: 2 },
      },
      {
        url: "/api/runbooks/rb-1/sections/sec-1/archive",
        payload: { expectedVersion: 2, idempotencyKey: "archive-section" },
        spy: service.patchSection,
        expected: { sectionId: "sec-1", archived: true, expectedVersion: 2 },
      },
      {
        url: "/api/runbooks/rb-1/sections/sec-1/items",
        payload: {
          itemId: "item-new",
          title: "New item",
          howTo: "Steps",
          afterItemId: "item-1",
          idempotencyKey: "create-item",
        },
        spy: service.createItem,
        expected: {
          sectionId: "sec-1",
          itemId: "item-new",
          title: "New item",
          howTo: "Steps",
          afterItemId: "item-1",
        },
      },
      {
        url: "/api/runbooks/rb-1/items/item-1/move",
        payload: {
          sectionId: "sec-1",
          expectedVersion: 3,
          afterItemId: "item-0",
          idempotencyKey: "move-item",
        },
        spy: service.moveItem,
        expected: {
          itemId: "item-1",
          sectionId: "sec-1",
          expectedVersion: 3,
          afterItemId: "item-0",
        },
      },
    ];

    for (const testCase of cases) {
      const response = await server.inject({
        method: "POST",
        url: testCase.url,
        headers,
        payload: testCase.payload,
      });
      expect(response.statusCode).toBe(200);
      expect(testCase.spy).toHaveBeenLastCalledWith(expect.objectContaining({
        actorKind: "user",
        actorUserId: "operator@example.com",
        runbookId: "rb-1",
        ...testCase.expected,
      }));
    }
  });

  it("rejects browser CRUD without dashboard authentication", async () => {
    const service = fakeRunbookService();
    const server = await createServer(service);

    const response = await server.inject({
      method: "POST",
      url: "/api/runbooks/rb-1/sections",
      payload: { title: "Nope", idempotencyKey: "unauthorized" },
    });

    expect(response.statusCode).toBe(401);
    expect(service.createSection).not.toHaveBeenCalled();
  });
});

async function createServer(service: ReturnType<typeof fakeRunbookService>): Promise<ServerInstance> {
  const server = await buildServer({
    host: "127.0.0.1",
    port: 0,
    nodeId: "test-node",
    logger: silentLogger(),
    runbook: {
      service: service as unknown as RunbookService,
      taskIdentityHost: { create: vi.fn() } as never,
      auth: {
        authBearerToken: "",
        environment: "production",
        dashboardAuthEnabled: true,
        jwtSecret: "jwt-secret",
      },
    },
  });
  openServers.push(server);
  return server;
}

function fakeRunbookService() {
  const snapshot = {
    runbook: {
      id: "rb-1",
      board_item_id: "runbook:rb-1",
      folder_id: "f1",
      title: "Launch",
      archived: false,
      version: 1,
      created_session_id: "sess-runbook",
      created_event_id: 1,
      created_at: "2026-07-17T00:00:00Z",
      updated_at: "2026-07-17T00:00:00Z",
    },
    sections: [{
      id: "sec-1",
      runbook_id: "rb-1",
      title: "Section",
      position_key: "a",
      archived: false,
      version: 2,
      created_session_id: "sess-section",
      updated_session_id: null,
    }],
    items: [{
      id: "item-1",
      section_id: "sec-1",
      title: "Item",
      how_to: "",
      position_key: "a",
      status: "pending",
      archived: false,
      version: 3,
      created_session_id: "sess-item",
      updated_session_id: null,
      assignee_session_id: null,
    }],
  };
  const result = (operationType: string) => ({
    eventId: 10,
    idempotent: false,
    operation: { id: "op-1", operation_type: operationType },
    snapshot,
  });
  return {
    getRunbook: vi.fn(async () => snapshot),
    createSection: vi.fn(async () => result("create_runbook_section")),
    patchSection: vi.fn(async () => result("update_runbook_section")),
    moveSection: vi.fn(async () => result("move_runbook_section")),
    createItem: vi.fn(async () => result("create_runbook_item")),
    patchItem: vi.fn(async () => result("update_runbook_item")),
    moveItem: vi.fn(async () => result("move_runbook_item")),
    createRunbook: vi.fn(),
    setRunbookStatus: vi.fn(),
    setItemStatus: vi.fn(),
  };
}

function dashboardCookie(subject: string): Record<string, string> {
  const token = signJwt({ sub: subject, exp: Math.floor(Date.now() / 1000) + 60 }, "jwt-secret");
  return { cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=${encodeURIComponent(token)}` };
}

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64Url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${header}.${body}.${signature}`;
}

function base64Url(value: string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function silentLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    fatal: () => undefined,
    child: () => silentLogger(),
  };
}

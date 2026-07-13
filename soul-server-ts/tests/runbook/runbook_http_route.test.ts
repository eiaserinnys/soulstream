import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DASHBOARD_AUTH_COOKIE_NAME } from "../../src/collaboration/board_yjs_auth.js";
import { RunbookVersionConflict } from "../../src/runbook/runbook_models.js";
import type { RunbookService } from "../../src/runbook/runbook_service.js";
import type { ChecklistRunbookAdapter } from "../../src/page/checklist_runbook_adapter.js";
import { buildServer, type ServerInstance } from "../../src/server.js";

function createSilentLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    fatal: () => undefined,
    child: () => createSilentLogger(),
  };
}

const openServers: ServerInstance[] = [];

afterEach(async () => {
  while (openServers.length > 0) {
    await openServers.pop()?.close();
  }
});

describe("runbook HTTP write route", () => {
  it("creates a browser runbook with user attribution and no session provenance", async () => {
    const service = fakeRunbookService();
    const server = await createServer(service);

    const response = await server.inject({
      method: "POST",
      url: "/api/runbooks",
      headers: {
        cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=${encodeURIComponent(signJwt({ sub: "operator@example.com" }, "jwt-secret"))}`,
      },
      payload: {
        runbook_id: "rb-browser",
        title: "Browser work",
        folder_id: "folder-1",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(service.createRunbook).toHaveBeenCalledWith({
      actorKind: "user",
      actorSessionId: null,
      actorUserId: "operator@example.com",
      runbookId: "rb-browser",
      title: "Browser work",
      folderId: "folder-1",
      enrollCreator: false,
    });
  });

  it("authenticates dashboard cookies and writes runbook-level user attribution", async () => {
    const service = fakeRunbookService();
    const server = await createServer(service);
    const token = signJwt(
      { sub: "operator@example.com", exp: Math.floor(Date.now() / 1000) + 60 },
      "jwt-secret",
    );

    const response = await server.inject({
      method: "POST",
      url: "/api/runbooks/rb-1/status",
      headers: {
        cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
      },
      payload: {
        status: "completed",
        expectedVersion: 1,
        idempotencyKey: "runbook:rb-1:status:completed:v1:test",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(service.setRunbookStatus).toHaveBeenCalledWith({
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "operator@example.com",
      runbookId: "rb-1",
      expectedVersion: 1,
      status: "completed",
      reason: null,
      idempotencyKey: "runbook:rb-1:status:completed:v1:test",
    });
    expect(response.json()).toMatchObject({
      ok: true,
      runbookId: "rb-1",
      idempotent: false,
    });
  });

  it("returns 409 when RunbookService rejects a stale runbook-level version", async () => {
    const service = fakeRunbookService();
    service.setRunbookStatus.mockRejectedValueOnce(
      new RunbookVersionConflict("runbook", "rb-1", 1, 2),
    );
    const server = await createServer(service);

    const response = await server.inject({
      method: "POST",
      url: "/api/runbooks/rb-1/status",
      headers: {
        cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=${encodeURIComponent(signJwt({ sub: "user-1" }, "jwt-secret"))}`,
      },
      payload: {
        status: "open",
        expectedVersion: 1,
        idempotencyKey: "runbook:rb-1:status:open:v1:test",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      detail: {
        error: {
          code: "RUNBOOK_VERSION_CONFLICT",
          details: {
            targetKind: "runbook",
            targetId: "rb-1",
            expectedVersion: 1,
            actualVersion: 2,
          },
        },
      },
    });
  });

  it("authenticates dashboard cookies and writes user attribution through RunbookService", async () => {
    const service = fakeRunbookService();
    const server = await createServer(service);
    const token = signJwt(
      { sub: "operator@example.com", exp: Math.floor(Date.now() / 1000) + 60 },
      "jwt-secret",
    );

    const response = await server.inject({
      method: "POST",
      url: "/api/runbooks/rb-1/items/item-1/status",
      headers: {
        cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
      },
      payload: {
        status: "completed",
        expectedVersion: 1,
        idempotencyKey: "runbook:rb-1:item:item-1:status:completed:v1:test",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(service.setItemStatus).toHaveBeenCalledWith({
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "operator@example.com",
      itemId: "item-1",
      expectedVersion: 1,
      status: "completed",
      reason: null,
      idempotencyKey: "runbook:rb-1:item:item-1:status:completed:v1:test",
    });
    expect(response.json()).toMatchObject({
      ok: true,
      runbookId: "rb-1",
      itemId: "item-1",
      idempotent: false,
    });
  });

  it("routes page-backed checklist completion through the production adapter", async () => {
    const service = fakeRunbookService({
      runbookId: "page-runbook:page-1",
      itemId: "checklist:block-1",
    });
    const setChecked = vi.fn(async () => ({
      projection: {
        properties: { runbookId: "page-runbook:page-1", itemId: "checklist:block-1" },
        status: "completed" as const,
        checked: true,
      },
      mutation: {
        eventId: 12,
        idempotent: false,
        operation: {
          id: "op-1",
          operation_type: "set_item_status",
        },
        snapshot: await service.getRunbook("page-runbook:page-1"),
      },
    }));
    const server = await createServer(service, { setChecked });

    const response = await server.inject({
      method: "POST",
      url: "/api/runbooks/page-runbook%3Apage-1/items/checklist%3Ablock-1/status",
      headers: {
        cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=${encodeURIComponent(signJwt({ sub: "operator@example.com" }, "jwt-secret"))}`,
      },
      payload: {
        status: "completed",
        expectedVersion: 1,
        idempotencyKey: "checklist:block-1:complete",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(setChecked).toHaveBeenCalledWith({
      runbookId: "page-runbook:page-1",
      itemId: "checklist:block-1",
      checked: true,
      expectedVersion: 1,
      actor: {
        actorKind: "user",
        actorSessionId: "sess-actor",
        actorUserId: "operator@example.com",
      },
      reason: null,
      idempotencyKey: "checklist:block-1:complete",
    });
    expect(service.setItemStatus).not.toHaveBeenCalled();
  });

  it("fails explicitly instead of bypassing a missing page checklist adapter", async () => {
    const service = fakeRunbookService({
      runbookId: "page-runbook:page-1",
      itemId: "checklist:block-1",
    });
    const server = await createServer(service);

    const response = await server.inject({
      method: "POST",
      url: "/api/runbooks/page-runbook%3Apage-1/items/checklist%3Ablock-1/status",
      headers: {
        cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=${encodeURIComponent(signJwt({ sub: "operator@example.com" }, "jwt-secret"))}`,
      },
      payload: {
        status: "completed",
        expectedVersion: 1,
        idempotencyKey: "checklist:block-1:missing-adapter",
      },
    });

    expect(response.statusCode).toBe(500);
    expect(service.setItemStatus).not.toHaveBeenCalled();
  });

  it("accepts review as a dashboard item status mutation", async () => {
    const service = fakeRunbookService();
    const server = await createServer(service);
    const token = signJwt(
      { sub: "operator@example.com", exp: Math.floor(Date.now() / 1000) + 60 },
      "jwt-secret",
    );

    const response = await server.inject({
      method: "POST",
      url: "/api/runbooks/rb-1/items/item-1/status",
      headers: {
        cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
      },
      payload: {
        status: "review",
        expectedVersion: 1,
        idempotencyKey: "runbook:rb-1:item:item-1:status:review:v1:test",
        reason: "ready for review",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(service.setItemStatus).toHaveBeenCalledWith({
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "operator@example.com",
      itemId: "item-1",
      expectedVersion: 1,
      status: "review",
      reason: "ready for review",
      idempotencyKey: "runbook:rb-1:item:item-1:status:review:v1:test",
    });
  });

  it("returns 409 when RunbookService rejects a stale version", async () => {
    const service = fakeRunbookService();
    service.setItemStatus.mockRejectedValueOnce(
      new RunbookVersionConflict("item", "item-1", 1, 2),
    );
    const server = await createServer(service);

    const response = await server.inject({
      method: "POST",
      url: "/api/runbooks/rb-1/items/item-1/status",
      headers: {
        cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=${encodeURIComponent(signJwt({ sub: "user-1" }, "jwt-secret"))}`,
      },
      payload: {
        status: "pending",
        expectedVersion: 1,
        idempotencyKey: "runbook:rb-1:item:item-1:status:pending:v1:test",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      detail: {
        error: {
          code: "RUNBOOK_VERSION_CONFLICT",
          details: {
            targetKind: "item",
            targetId: "item-1",
            expectedVersion: 1,
            actualVersion: 2,
          },
        },
      },
    });
  });
});

async function createServer(
  service: ReturnType<typeof fakeRunbookService>,
  checklistAdapter?: Pick<ChecklistRunbookAdapter, "setChecked">,
): Promise<ServerInstance> {
  const server = await buildServer({
    host: "127.0.0.1",
    port: 0,
    nodeId: "test-node",
    logger: createSilentLogger(),
    runbook: {
      service: service as unknown as RunbookService,
      checklistAdapter,
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

function fakeRunbookService(options: { runbookId?: string; itemId?: string } = {}) {
  const snapshot = {
    runbook: {
      id: options.runbookId ?? "rb-1",
      board_item_id: `runbook:${options.runbookId ?? "rb-1"}`,
      folder_id: "f1",
      title: "Launch",
      status: "open",
      archived: false,
      version: 1,
      created_session_id: "sess-actor",
      created_event_id: 1,
      completed_kind: null,
      completed_session_id: null,
      completed_event_id: null,
      completed_user_id: null,
      completed_at: null,
      created_at: "2026-06-16T00:00:00+00:00",
      updated_at: "2026-06-16T00:00:00+00:00",
    },
    sections: [],
    items: [
      {
        id: options.itemId ?? "item-1",
        section_id: "sec-1",
        position_key: "a",
        title: "Check",
        how_to: "",
        status: "pending",
        archived: false,
        version: 1,
      },
    ],
  };
  return {
    createRunbook: vi.fn(async () => ({
      eventId: 0,
      operation: { id: "op-create", operation_type: "create_runbook" },
      snapshot,
    })),
    getRunbook: vi.fn(async () => snapshot),
    setRunbookStatus: vi.fn(async () => ({
      eventId: 11,
      idempotent: false,
      operation: {
        id: "op-runbook-status",
        operation_type: "set_runbook_status",
      },
      snapshot,
    })),
    setItemStatus: vi.fn(async () => ({
      eventId: 12,
      idempotent: false,
      operation: {
        id: "op-1",
        operation_type: "set_item_status",
      },
      snapshot,
    })),
  };
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

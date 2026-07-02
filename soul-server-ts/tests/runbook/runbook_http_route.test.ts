import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DASHBOARD_AUTH_COOKIE_NAME } from "../../src/collaboration/board_yjs_auth.js";
import { RunbookVersionConflict } from "../../src/runbook/runbook_models.js";
import type { RunbookService } from "../../src/runbook/runbook_service.js";
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

async function createServer(service: ReturnType<typeof fakeRunbookService>): Promise<ServerInstance> {
  const server = await buildServer({
    host: "127.0.0.1",
    port: 0,
    nodeId: "test-node",
    logger: createSilentLogger(),
    runbook: {
      service: service as unknown as RunbookService,
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
      created_session_id: "sess-actor",
      created_event_id: 1,
      created_at: "2026-06-16T00:00:00+00:00",
      updated_at: "2026-06-16T00:00:00+00:00",
    },
    sections: [],
    items: [
      {
        id: "item-1",
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
    getRunbook: vi.fn(async () => snapshot),
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

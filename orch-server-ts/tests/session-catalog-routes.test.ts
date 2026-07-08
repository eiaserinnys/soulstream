import { describe, expect, it } from "vitest";

import {
  SessionCatalogRouteError,
  createApp,
  loadContractFixtures,
  parseOrchServerConfig,
  sessionCatalogRouteAuthRequirements,
  type SessionCatalogProvider,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

type ProviderCall =
  | ["rename", string, unknown, unknown]
  | ["move", string[], unknown, unknown]
  | ["update", string, unknown, unknown]
  | ["delete", string, unknown]
  | ["cards", string]
  | ["read", string, number, unknown];

function createProvider(overrides: Partial<SessionCatalogProvider> = {}) {
  const calls: ProviderCall[] = [];
  const provider: SessionCatalogProvider = {
    async renameSession(sessionId, displayName, callerInfo) {
      calls.push(["rename", sessionId, displayName, callerInfo]);
    },
    async moveSessionsToFolder(sessionIds, folderId, callerInfo) {
      calls.push(["move", sessionIds, folderId, callerInfo]);
      return { count: sessionIds.length };
    },
    async updateSessionCatalog(sessionId, update, callerInfo) {
      calls.push(["update", sessionId, update, callerInfo]);
    },
    async deleteSession(sessionId, callerInfo) {
      calls.push(["delete", sessionId, callerInfo]);
    },
    async getSessionCards(sessionId) {
      calls.push(["cards", sessionId]);
      return [
        {
          id: 1,
          event_type: "assistant_message",
          payload: "{\"text\":\"parsed\"}",
          created_at: "2026-07-08T00:00:00.000Z",
        },
        {
          id: 2,
          event_type: "raw_text",
          payload: "not-json",
          created_at: "2026-07-08T00:00:01.000Z",
        },
      ];
    },
    async updateReadPosition(sessionId, lastReadEventId, callerInfo) {
      calls.push(["read", sessionId, lastReadEventId, callerInfo]);
    },
    ...overrides,
  };
  return { provider, calls };
}

describe("session catalog/read-position route harness", () => {
  const fixtures = loadContractFixtures();

  it("keeps session catalog routes disabled on the default app", async () => {
    const app = createApp({ config });

    for (const [method, url, payload] of [
      ["PATCH", "/api/sessions/sess-contract/display-name", { displayName: "new" }],
      ["PUT", "/api/sessions/folder", { sessionIds: ["sess-contract"] }],
      ["PATCH", "/api/sessions/folder", { sessionIds: ["sess-contract"] }],
      ["PUT", "/api/sessions/sess-contract", { folderId: "folder-1" }],
      ["DELETE", "/api/sessions/sess-contract", undefined],
      ["GET", "/api/sessions/sess-contract/cards", undefined],
      [
        "PUT",
        "/api/sessions/sess-contract/read-position",
        { last_read_event_id: 123 },
      ],
    ] as const) {
      expect(await app.inject({ method, url, payload })).toMatchObject({
        statusCode: 404,
      });
    }

    await app.close();
  });

  it("registers Python auth contract rows for route inventory order 28-34", async () => {
    expect(sessionCatalogRouteAuthRequirements).toEqual({
      "PATCH /api/sessions/:session_id/display-name": true,
      "PUT /api/sessions/folder": true,
      "PATCH /api/sessions/folder": true,
      "PUT /api/sessions/:session_id": true,
      "DELETE /api/sessions/:session_id": true,
      "GET /api/sessions/:session_id/cards": true,
      "PUT /api/sessions/:session_id/read-position": true,
    });

    const routeRows = fixtures.routeInventory.routes
      .filter((route) =>
        [
          "rename_session",
          "batch_move_folder",
          "update_session_catalog",
          "delete_session",
          "session_cards",
          "update_read_position",
        ].includes(route.name),
      )
      .map((route) => [route.order, route.methods[0], route.path, route.authRequired]);

    expect(routeRows).toEqual([
      [28, "PATCH", "/api/sessions/{session_id}/display-name", true],
      [29, "PUT", "/api/sessions/folder", true],
      [30, "PATCH", "/api/sessions/folder", true],
      [31, "PUT", "/api/sessions/{session_id}", true],
      [32, "DELETE", "/api/sessions/{session_id}", true],
      [33, "GET", "/api/sessions/{session_id}/cards", true],
      [34, "PUT", "/api/sessions/{session_id}/read-position", true],
    ]);
  });

  it("forwards Python body wire to the provider without camelCase aliases", async () => {
    const { provider, calls } = createProvider();
    const app = createApp({ config, sessionCatalogRoutes: { provider } });

    await app.inject({
      method: "PATCH",
      url: "/api/sessions/sess-contract/display-name",
      payload: { displayName: "new name", caller_info: { source: "browser" } },
    });
    await app.inject({
      method: "PUT",
      url: "/api/sessions/folder",
      payload: {
        sessionIds: ["sess-a", "sess-b"],
        folderId: null,
        caller_info: { source: "slack" },
      },
    });
    await app.inject({
      method: "PUT",
      url: "/api/sessions/sess-contract",
      payload: {
        folderId: "folder-1",
        displayName: null,
        caller_info: { source: "agent" },
      },
    });
    await app.inject({
      method: "PUT",
      url: "/api/sessions/sess-contract/read-position",
      payload: { last_read_event_id: 321, caller_info: { source: "browser" } },
    });

    expect(calls).toEqual([
      ["rename", "sess-contract", "new name", { source: "browser" }],
      ["move", ["sess-a", "sess-b"], null, { source: "slack" }],
      [
        "update",
        "sess-contract",
        { folderId: "folder-1", displayName: null },
        { source: "agent" },
      ],
      ["read", "sess-contract", 321, { source: "browser" }],
    ]);

    const camelReadPosition = await app.inject({
      method: "PUT",
      url: "/api/sessions/sess-contract/read-position",
      payload: { lastReadEventId: 321 },
    });
    expect(camelReadPosition.statusCode).toBe(400);

    await app.close();
  });

  it("returns Python response shapes and normalizes raw event cards", async () => {
    const { provider, calls } = createProvider();
    const app = createApp({ config, sessionCatalogRoutes: { provider } });

    const rename = await app.inject({
      method: "PATCH",
      url: "/api/sessions/sess-contract/display-name",
      payload: {},
    });
    const move = await app.inject({
      method: "PATCH",
      url: "/api/sessions/folder",
      payload: { sessionIds: ["sess-a", "sess-b"], folderId: "folder-1" },
    });
    const update = await app.inject({
      method: "PUT",
      url: "/api/sessions/sess-contract",
      payload: {},
    });
    const cards = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-contract/cards",
    });
    const read = await app.inject({
      method: "PUT",
      url: "/api/sessions/sess-contract/read-position",
      payload: { last_read_event_id: 2 },
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/sessions/sess-contract",
    });

    expect(rename.json()).toEqual({ success: true });
    expect(move.json()).toEqual({ success: true, count: 2 });
    expect(update.json()).toEqual({ ok: true });
    expect(cards.json()).toEqual([
      {
        id: 1,
        type: "assistant_message",
        payload: { text: "parsed" },
        createdAt: "2026-07-08T00:00:00.000Z",
      },
      {
        id: 2,
        type: "raw_text",
        payload: "not-json",
        createdAt: "2026-07-08T00:00:01.000Z",
      },
    ]);
    expect(read.json()).toEqual({ ok: true });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe("");
    expect(calls.map((call) => call[0])).toEqual([
      "rename",
      "move",
      "update",
      "cards",
      "read",
      "delete",
    ]);

    await app.close();
  });

  it("keeps static folder routes from being consumed as session id routes", async () => {
    const { provider, calls } = createProvider();
    const app = createApp({ config, sessionCatalogRoutes: { provider } });

    for (const method of ["PUT", "PATCH"] as const) {
      const response = await app.inject({
        method,
        url: "/api/sessions/folder",
        payload: { sessionIds: ["sess-contract"] },
      });
      expect(response.json()).toEqual({ success: true, count: 1 });
    }

    expect(calls).toEqual([
      ["move", ["sess-contract"], null, undefined],
      ["move", ["sess-contract"], null, undefined],
    ]);

    await app.close();
  });

  it("maps invalid body and provider errors predictably", async () => {
    const missingSessionIds = createProvider();
    const invalidApp = createApp({
      config,
      sessionCatalogRoutes: { provider: missingSessionIds.provider },
    });

    const invalidMove = await invalidApp.inject({
      method: "PUT",
      url: "/api/sessions/folder",
      payload: { folderId: "folder-1" },
    });
    const invalidRead = await invalidApp.inject({
      method: "PUT",
      url: "/api/sessions/sess-contract/read-position",
      payload: { last_read_event_id: 1.5 },
    });
    expect(invalidMove.statusCode).toBe(400);
    expect(invalidRead.statusCode).toBe(400);
    await invalidApp.close();

    const notFound = createProvider({
      async renameSession() {
        throw new SessionCatalogRouteError("SESSION_NOT_FOUND", "missing", 404);
      },
    });
    const forbidden = createProvider({
      async deleteSession() {
        throw new SessionCatalogRouteError("SESSION_FORBIDDEN", "forbidden", 403);
      },
    });
    const failed = createProvider({
      async updateReadPosition() {
        throw new Error("provider failed");
      },
    });

    const notFoundApp = createApp({
      config,
      sessionCatalogRoutes: { provider: notFound.provider },
    });
    const forbiddenApp = createApp({
      config,
      sessionCatalogRoutes: { provider: forbidden.provider },
    });
    const failedApp = createApp({
      config,
      sessionCatalogRoutes: { provider: failed.provider },
    });

    expect(
      (
        await notFoundApp.inject({
          method: "PATCH",
          url: "/api/sessions/missing/display-name",
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await forbiddenApp.inject({
          method: "DELETE",
          url: "/api/sessions/forbidden",
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await failedApp.inject({
          method: "PUT",
          url: "/api/sessions/sess-contract/read-position",
          payload: { last_read_event_id: 1 },
        })
      ).statusCode,
    ).toBe(422);

    await notFoundApp.close();
    await forbiddenApp.close();
    await failedApp.close();
  });
});

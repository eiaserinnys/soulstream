import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerCardRoutes, cardRouteAuthRequirements } from "../src/cards/card_routes.js";
import type { FolderRouteOptions } from "../src/folders/folder_routes.js";

// Reuse folder-routes' direct Fastify boundary fixture: no DB or node execution.
const routes = ["execute", "execution", "execution-settings"] as const;
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

function setup(user: string | null, allowedFolderIds = ["source", "target"]) {
  const card = { id: "card", folder_id: "source", version: 1 };
  const result = { card, execution: { requestId: "request", sessionId: "session", state: "started" } };
  const execute = vi.fn(async () => result);
  const observe = vi.fn(async () => result);
  const save = vi.fn(async () => undefined);
  const app = Fastify(); apps.push(app);
  registerCardRoutes(app, {
    provider: { listFolders: () => [{ id: "source" }, { id: "target" }] },
    accessProvider: { resolveAccess: () => ({ restricted: true, allowedFolderIds }) },
    resolveDashboardUserId: () => user,
    cardServiceProvider: async () => ({ getCard: async () => ({ card }), saveExecutionSettings: save }),
    cardExecutionServiceProvider: async () => ({ execute, observe }),
    authBearerToken: "service-token", environment: "production",
  } as unknown as FolderRouteOptions);
  const call = (operation: typeof routes[number], agent = false) => app.inject({
    method: operation === "execution" ? "GET" : "POST",
    url: `/api/cards/card/${operation}${operation === "execution" ? "?requestId=request" : ""}`,
    headers: agent ? { authorization: "Bearer service-token", "x-soulstream-agent-session-id": "agent-session" } : {},
    ...(operation === "execution" ? {} : { payload: { expectedVersion: 1, idempotencyKey: "key",
      ...(operation === "execution-settings" ? { folderId: "target", nodeId: "node", agentId: "agent", modelPreset: "model" } : {}) } }),
  });
  return { call, execute, observe, save };
}

it.each(routes)("requires a dashboard user for %s, including trusted agent callers", async operation => {
  const anonymous = setup(null);
  expect((await anonymous.call(operation)).statusCode).toBe(401);
  expect((await anonymous.call(operation, true)).statusCode).toBe(403);
  expect(anonymous.execute).not.toHaveBeenCalled();
  expect(anonymous.observe).not.toHaveBeenCalled();
  expect(anonymous.save).not.toHaveBeenCalled();
  expect(cardRouteAuthRequirements[`${operation === "execution" ? "GET" : "POST"} /api/cards/:id/${operation}`]).toBe(true);
});

it.each(routes)("dispatches %s with the authenticated user and source folder scope", async operation => {
  const denied = setup("user", ["target"]);
  expect((await denied.call(operation)).statusCode).toBe(403);
  expect(denied.execute).not.toHaveBeenCalled(); expect(denied.observe).not.toHaveBeenCalled(); expect(denied.save).not.toHaveBeenCalled();
  const user = setup("user");
  expect((await user.call(operation)).statusCode).toBe(200);
  const actor = { actorKind: "user", actorSessionId: null, actorUserId: "user" };
  if (operation === "execution") expect(user.observe).toHaveBeenCalledWith("card", "request", actor);
  else expect(operation === "execute" ? user.execute : user.save).toHaveBeenCalledWith(expect.objectContaining({ cardId: "card", ...actor }));
});

it("requires target folder access before atomic settings save", async () => {
  const user = setup("user", ["source"]);
  expect((await user.call("execution-settings")).statusCode).toBe(403);
  expect(user.save).not.toHaveBeenCalled();
});

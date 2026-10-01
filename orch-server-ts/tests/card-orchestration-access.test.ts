import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { createCardOrchestrationAccess } from "../src/cards/card_orchestration_access.js";
import { registerCardOrchestrationDecisionRoutes } from "../src/cards/card_orchestration_decision_routes.js";
const id = "11111111-1111-4111-8111-111111111111";
it("reads persisted owner identity and denies purpose sessions independently of caller email", async () => {
  const rows: Record<string, unknown> = {
    normal: {
      metadata: [
        {
          type: "caller_info",
          value: { source: "browser", email: " ADMIN@example.com " },
        },
        { type: "caller_info", value: { source: "system" } },
      ],
    },
    purpose: {
      metadata: [
        {
          type: "caller_info",
          value: { source: "browser", email: "admin@example.com" },
        },
        { type: "card_orchestration_decision", runId: id },
      ],
    },
    unknown: {
      metadata: [{ type: "caller_info", value: { source: "system" } }],
    },
  };
  const access = createCardOrchestrationAccess({
    getSession: async (sessionId) =>
      (rows[sessionId] as Record<string, unknown> | null) ?? null,
    listFolders: async () => [],
    findUserByEmail: async () => null,
  });
  expect(await access.resolveCaller("normal")).toEqual({
    ownerEmail: "admin@example.com",
    purpose: null,
  });
  expect(await access.resolveCaller("purpose")).toEqual({
    ownerEmail: "admin@example.com",
    purpose: "card_orchestration_decision",
  });
  expect(await access.resolveCaller("unknown")).toBeNull();
});
it("requires known active folder and canonical inherited access even for an administrator", async () => {
  const folders = [
    { id: "parent", parentFolderId: null },
    { id: "child", parentFolderId: "parent" },
    { id: "archived", archived: true },
    { id: "other", parentFolderId: null },
  ];
  const findUserByEmail = vi.fn(async () => ({
    email: "owner",
    isAdmin: false,
    allowedFolderIds: ["parent"],
  }));
  const access = createCardOrchestrationAccess({
    getSession: async () => null,
    listFolders: async () => folders,
    findUserByEmail,
  });
  expect(await access.validateFolder("child", "owner")).toBe(true);
  expect(await access.validateFolder("other", "owner")).toBe(false);
  expect(await access.validateFolder("archived", "owner")).toBe(false);
  expect(await access.validateFolder("missing", "owner")).toBe(false);
  findUserByEmail.mockResolvedValue({
    email: "owner",
    isAdmin: true,
    allowedFolderIds: [],
  });
  expect(await access.validateFolder("missing", "owner")).toBe(false);
  expect(await access.validateFolder("other", "owner")).toBe(true);
});
it("requires service bearer and exact run identity before one-shot server authorization", async () => {
  const app = Fastify(),
    authorize = vi.fn(async () => true);
  registerCardOrchestrationDecisionRoutes(app, {
    authBearerToken: "service-token",
    environment: "test",
    authorizeDecision: authorize,
    authorizeWorker: authorize,
  });
  const body = {
    sessionId: id,
    runId: id,
    executionToken: id,
    nodeId: "eiaserinnys",
  };
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/card-orchestration/decision/authorize",
        payload: body,
      })
    ).statusCode,
  ).toBe(401);
  expect(authorize).not.toHaveBeenCalled();
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/card-orchestration/decision/authorize",
        headers: { authorization: "Bearer service-token" },
        payload: { ...body, isAdmin: true },
      })
    ).statusCode,
  ).toBe(422);
  expect(authorize).not.toHaveBeenCalled();
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/card-orchestration/decision/authorize",
        headers: { authorization: "Bearer service-token" },
        payload: body,
      })
    ).json(),
  ).toEqual({ allowed: true });
  expect(authorize).toHaveBeenCalledWith(body);
  authorize.mockResolvedValue(false);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/card-orchestration/decision/authorize",
        headers: { authorization: "Bearer service-token" },
        payload: body,
      })
    ).json(),
  ).toEqual({ allowed: false });
  await app.close();
});

it("authorizes a worker only with service bearer and exact admitted card identity", async () => {
  const app = Fastify(),
    authorize = vi.fn(async () => true);
  registerCardOrchestrationDecisionRoutes(app, {
    authBearerToken: "service-token",
    environment: "test",
    authorizeDecision: vi.fn(async () => false),
    authorizeWorker: authorize,
  });
  const body = {
    sessionId: id,
    runId: id,
    executionToken: id,
    nodeId: "eiaserinnys",
    cardId: id,
  };
  const request = {
    method: "POST" as const,
    url: "/api/card-orchestration/worker/authorize",
    payload: body,
  };
  expect((await app.inject(request)).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        ...request,
        headers: { authorization: "Bearer service-token" },
        payload: { ...body, isAdmin: true },
      })
    ).statusCode,
  ).toBe(422);
  const { cardId: _, ...missingCard } = body;
  expect(
    (
      await app.inject({
        ...request,
        headers: { authorization: "Bearer service-token" },
        payload: missingCard,
      })
    ).statusCode,
  ).toBe(422);
  expect(authorize).not.toHaveBeenCalled();
  expect(
    (
      await app.inject({
        ...request,
        headers: { authorization: "Bearer service-token" },
      })
    ).json(),
  ).toEqual({ allowed: true });
  expect(authorize).toHaveBeenCalledWith(body);
  authorize.mockResolvedValue(false);
  expect(
    (
      await app.inject({
        ...request,
        headers: { authorization: "Bearer service-token" },
      })
    ).json(),
  ).toEqual({ allowed: false });
  await app.close();
});

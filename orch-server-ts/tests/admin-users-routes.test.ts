import { describe, expect, it } from "vitest";

import {
  AdminUsersRouteError,
  createApp,
  loadContractFixtures,
  parseOrchServerConfig,
  adminUsersRouteAuthRequirements,
  type AdminDashboardUser,
  type AdminUsersRouteProvider,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

type ProviderCall =
  | ["currentEmail"]
  | ["isAdmin", string]
  | ["listUsers"]
  | ["listFolders"]
  | ["create", unknown]
  | ["update", string, unknown]
  | ["delete", string]
  | ["canRemoveAdmin", string]
  | ["broadcast"];

const adaUser: AdminDashboardUser = {
  email: "ada@example.com",
  displayName: "Ada",
  isAdmin: true,
  allowedFolderIds: ["folder-a"],
  createdAt: "2026-07-09T00:00:00.000Z",
  createdBy: "init_admin",
};

const bobUser: AdminDashboardUser = {
  email: "bob@example.com",
  displayName: null,
  isAdmin: false,
  allowedFolderIds: [],
  createdAt: "2026-07-09T00:00:01.000Z",
  createdBy: "ada@example.com",
};

function createProvider(overrides: Partial<AdminUsersRouteProvider> = {}) {
  const calls: ProviderCall[] = [];
  const provider: AdminUsersRouteProvider = {
    async currentEmail() {
      calls.push(["currentEmail"]);
      return "Ada@Example.COM ";
    },
    async isAdminEmail(email) {
      calls.push(["isAdmin", email]);
      return true;
    },
    async listUsers() {
      calls.push(["listUsers"]);
      return [adaUser, bobUser];
    },
    async listFolders() {
      calls.push(["listFolders"]);
      return [{ id: "folder-a", name: "Alpha" }];
    },
    async createUser(input) {
      calls.push(["create", input]);
      return {
        ...bobUser,
        email: input.email,
        displayName: input.displayName ?? null,
        isAdmin: input.isAdmin,
        allowedFolderIds: input.allowedFolderIds,
        createdBy: input.createdBy,
      };
    },
    async updateUser(email, update) {
      calls.push(["update", email, update]);
      return {
        ...bobUser,
        email,
        displayName:
          update.displayName !== undefined ? update.displayName : bobUser.displayName,
        isAdmin: update.isAdmin ?? bobUser.isAdmin,
        allowedFolderIds: update.allowedFolderIds ?? bobUser.allowedFolderIds,
      };
    },
    async deleteUser(email) {
      calls.push(["delete", email]);
    },
    async canRemoveAdmin(email) {
      calls.push(["canRemoveAdmin", email]);
      return true;
    },
    async broadcastAccessChange() {
      calls.push(["broadcast"]);
    },
    ...overrides,
  };
  return { provider, calls };
}

describe("admin users route harness", () => {
  const fixtures = loadContractFixtures();

  it("keeps admin users routes disabled on the default app", async () => {
    const app = createApp({ config });

    for (const [method, url, payload] of [
      ["GET", "/api/admin/users", undefined],
      ["POST", "/api/admin/users", { email: "new@example.com" }],
      ["PATCH", "/api/admin/users/new@example.com", { displayName: "New" }],
      ["DELETE", "/api/admin/users/new@example.com", undefined],
    ] as const) {
      expect(await app.inject({ method, url, payload })).toMatchObject({
        statusCode: 404,
      });
    }

    await app.close();
  });

  it("registers Python auth contract rows for route inventory order 49-52", () => {
    expect(adminUsersRouteAuthRequirements).toEqual({
      "GET /api/admin/users": true,
      "POST /api/admin/users": true,
      "PATCH /api/admin/users/:email": true,
      "DELETE /api/admin/users/:email": true,
    });

    const routeRows = fixtures.routeInventory.routes
      .filter((route) =>
        ["list_users", "create_user", "update_user", "delete_user"].includes(
          route.name,
        ),
      )
      .map((route) => [route.order, route.methods[0], route.path, route.authRequired]);

    expect(routeRows).toEqual([
      [49, "GET", "/api/admin/users", true],
      [50, "POST", "/api/admin/users", true],
      [51, "PATCH", "/api/admin/users/{email}", true],
      [52, "DELETE", "/api/admin/users/{email}", true],
    ]);
  });

  it("requires an authenticated admin before reaching user providers", async () => {
    const unauthenticated = createProvider({
      async currentEmail() {
        unauthenticated.calls.push(["currentEmail"]);
        return undefined;
      },
    });
    const unauthenticatedApp = createApp({
      config,
      adminUsersRoutes: { provider: unauthenticated.provider },
    });

    const authResponse = await unauthenticatedApp.inject({
      method: "GET",
      url: "/api/admin/users",
    });
    expect(authResponse.statusCode).toBe(401);
    expect(authResponse.json()).toEqual({ detail: "Authentication required" });
    expect(unauthenticated.calls).toEqual([["currentEmail"]]);
    await unauthenticatedApp.close();

    const forbidden = createProvider({
      async isAdminEmail(email) {
        forbidden.calls.push(["isAdmin", email]);
        return false;
      },
    });
    const forbiddenApp = createApp({
      config,
      adminUsersRoutes: { provider: forbidden.provider },
    });

    const forbiddenResponse = await forbiddenApp.inject({
      method: "GET",
      url: "/api/admin/users",
    });
    expect(forbiddenResponse.statusCode).toBe(403);
    expect(forbiddenResponse.json()).toEqual({ detail: "Admin access required" });
    expect(forbidden.calls).toEqual([
      ["currentEmail"],
      ["isAdmin", "ada@example.com"],
    ]);
    await forbiddenApp.close();
  });

  it("lists users and folders after admin verification", async () => {
    const { provider, calls } = createProvider();
    const app = createApp({ config, adminUsersRoutes: { provider } });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/users",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      users: [adaUser, bobUser],
      folders: [{ id: "folder-a", name: "Alpha" }],
    });
    expect(calls).toEqual([
      ["currentEmail"],
      ["isAdmin", "ada@example.com"],
      ["listUsers"],
      ["listFolders"],
    ]);

    await app.close();
  });

  it("creates a user with Python defaults, normalization, createdBy, and one broadcast", async () => {
    const { provider, calls } = createProvider();
    const app = createApp({ config, adminUsersRoutes: { provider } });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      payload: {
        email: " New.User@Example.COM ",
        displayName: "New User",
        allowedFolderIds: [" folder-a ", "folder-a", "", "folder-b"],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      user: {
        ...bobUser,
        email: "new.user@example.com",
        displayName: "New User",
        isAdmin: false,
        allowedFolderIds: ["folder-a", "folder-b"],
      },
    });
    expect(calls).toEqual([
      ["currentEmail"],
      ["isAdmin", "ada@example.com"],
      [
        "create",
        {
          email: "new.user@example.com",
          displayName: "New User",
          isAdmin: false,
          allowedFolderIds: ["folder-a", "folder-b"],
          createdBy: "ada@example.com",
        },
      ],
      ["broadcast"],
    ]);

    await app.close();
  });

  it("passes only supplied patch fields and broadcasts after success", async () => {
    const { provider, calls } = createProvider();
    const app = createApp({ config, adminUsersRoutes: { provider } });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/users/Bob@Example.COM",
      payload: {
        displayName: null,
        allowedFolderIds: [" folder-b ", "folder-b", "folder-c"],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: {
        ...bobUser,
        email: "bob@example.com",
        displayName: null,
        allowedFolderIds: ["folder-b", "folder-c"],
      },
    });
    expect(calls).toEqual([
      ["currentEmail"],
      ["isAdmin", "ada@example.com"],
      [
        "update",
        "bob@example.com",
        {
          displayName: null,
          allowedFolderIds: ["folder-b", "folder-c"],
        },
      ],
      ["broadcast"],
    ]);

    await app.close();
  });

  it("blocks self-demote and self-delete when the target is the last admin", async () => {
    const patch = createProvider({
      async canRemoveAdmin(email) {
        patch.calls.push(["canRemoveAdmin", email]);
        return false;
      },
    });
    const patchApp = createApp({
      config,
      adminUsersRoutes: { provider: patch.provider },
    });
    const patchResponse = await patchApp.inject({
      method: "PATCH",
      url: "/api/admin/users/ada@example.com",
      payload: { isAdmin: false },
    });
    expect(patchResponse.statusCode).toBe(400);
    expect(patchResponse.json()).toEqual({
      detail: "At least one admin user is required",
    });
    expect(patch.calls).toEqual([
      ["currentEmail"],
      ["isAdmin", "ada@example.com"],
      ["canRemoveAdmin", "ada@example.com"],
    ]);
    await patchApp.close();

    const deletion = createProvider({
      async canRemoveAdmin(email) {
        deletion.calls.push(["canRemoveAdmin", email]);
        return false;
      },
    });
    const deleteApp = createApp({
      config,
      adminUsersRoutes: { provider: deletion.provider },
    });
    const deleteResponse = await deleteApp.inject({
      method: "DELETE",
      url: "/api/admin/users/ada@example.com",
    });
    expect(deleteResponse.statusCode).toBe(400);
    expect(deleteResponse.json()).toEqual({
      detail: "At least one admin user is required",
    });
    expect(deletion.calls).toEqual([
      ["currentEmail"],
      ["isAdmin", "ada@example.com"],
      ["canRemoveAdmin", "ada@example.com"],
    ]);
    await deleteApp.close();
  });

  it("maps provider validation and missing-user errors to Python detail responses", async () => {
    const createError = createProvider({
      async createUser() {
        throw new AdminUsersRouteError("USER_VALIDATION", "Duplicate user", 400);
      },
    });
    const createAppInstance = createApp({
      config,
      adminUsersRoutes: { provider: createError.provider },
    });
    const createResponse = await createAppInstance.inject({
      method: "POST",
      url: "/api/admin/users",
      payload: { email: "bob@example.com" },
    });
    expect(createResponse.statusCode).toBe(400);
    expect(createResponse.json()).toEqual({ detail: "Duplicate user" });
    expect(createError.calls.at(-1)).not.toEqual(["broadcast"]);
    await createAppInstance.close();

    const updateMissing = createProvider({
      async updateUser() {
        throw new AdminUsersRouteError("USER_NOT_FOUND", "User not found", 404);
      },
    });
    const updateApp = createApp({
      config,
      adminUsersRoutes: { provider: updateMissing.provider },
    });
    const updateResponse = await updateApp.inject({
      method: "PATCH",
      url: "/api/admin/users/missing@example.com",
      payload: { displayName: "Missing" },
    });
    expect(updateResponse.statusCode).toBe(404);
    expect(updateResponse.json()).toEqual({ detail: "User not found" });
    await updateApp.close();

    const deleteMissing = createProvider({
      async deleteUser() {
        throw new AdminUsersRouteError("USER_NOT_FOUND", "User not found", 404);
      },
    });
    const deleteApp = createApp({
      config,
      adminUsersRoutes: { provider: deleteMissing.provider },
    });
    const deleteResponse = await deleteApp.inject({
      method: "DELETE",
      url: "/api/admin/users/missing@example.com",
    });
    expect(deleteResponse.statusCode).toBe(404);
    expect(deleteResponse.json()).toEqual({ detail: "User not found" });
    await deleteApp.close();
  });

  it("deletes users after the last-admin guard and broadcasts once", async () => {
    const { provider, calls } = createProvider();
    const app = createApp({ config, adminUsersRoutes: { provider } });

    const response = await app.inject({
      method: "DELETE",
      url: "/api/admin/users/bob@example.com",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(calls).toEqual([
      ["currentEmail"],
      ["isAdmin", "ada@example.com"],
      ["delete", "bob@example.com"],
      ["broadcast"],
    ]);

    await app.close();
  });
});

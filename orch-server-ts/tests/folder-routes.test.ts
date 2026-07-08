import { describe, expect, it } from "vitest";

import {
  FolderRouteError,
  createApp,
  folderRouteAuthRequirements,
  loadContractFixtures,
  parseOrchServerConfig,
  type FolderAccessProvider,
  type FolderRecord,
  type FolderRouteProvider,
  type SessionAssignmentRecord,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

type ProviderCall =
  | ["access"]
  | ["listFolders"]
  | ["listSessionAssignments"]
  | ["create", string, number, unknown]
  | ["update", string, unknown]
  | ["delete", string]
  | ["reorder", unknown];

const folders: FolderRecord[] = [
  { id: "folder-a", name: "Alpha", sortOrder: 1, parentFolderId: null },
  { id: "folder-a-child", name: "Child", sortOrder: 2, parentFolderId: "folder-a" },
  { id: "folder-b", name: "Beta", sortOrder: 3, parentFolderId: null },
  { id: "claude", name: "Claude", sortOrder: 4, parentFolderId: null },
  { id: "llm", name: "LLM", sortOrder: 5, parentFolderId: null },
];

const assignments: Record<string, SessionAssignmentRecord> = {
  "sess-a": { folderId: "folder-a" },
  "sess-child": { folderId: "folder-a-child" },
  "sess-b": { folderId: "folder-b" },
  "sess-none": { folderId: null },
};

function createHarness(overrides: Partial<FolderRouteProvider> = {}) {
  const calls: ProviderCall[] = [];
  const provider: FolderRouteProvider = {
    async listFolders() {
      calls.push(["listFolders"]);
      return folders;
    },
    async listSessionAssignments() {
      calls.push(["listSessionAssignments"]);
      return assignments;
    },
    async createFolder(name, sortOrder, options) {
      calls.push(["create", name, sortOrder, options]);
      return { id: "created", name, sortOrder, parentFolderId: options.parentFolderId };
    },
    async updateFolder(folderId, update) {
      calls.push(["update", folderId, update]);
    },
    async deleteFolder(folderId) {
      calls.push(["delete", folderId]);
    },
    async reorderFolders(items) {
      calls.push(["reorder", items]);
    },
    ...overrides,
  };
  return { provider, calls };
}

function createAccessProvider(
  access: { restricted: boolean; allowedFolderIds?: string[] },
  calls: ProviderCall[],
): FolderAccessProvider {
  return {
    async resolveAccess() {
      calls.push(["access"]);
      return access;
    },
  };
}

function createAppWithFolders(
  access: { restricted: boolean; allowedFolderIds?: string[] },
  overrides: Partial<FolderRouteProvider> = {},
) {
  const harness = createHarness(overrides);
  const accessProvider = createAccessProvider(access, harness.calls);
  const app = createApp({
    config,
    folderRoutes: { provider: harness.provider, accessProvider },
  });
  return { app, calls: harness.calls };
}

describe("folder route harness", () => {
  const fixtures = loadContractFixtures();

  it("keeps folder routes disabled on the default app", async () => {
    const app = createApp({ config });

    for (const [method, url, payload] of [
      ["GET", "/api/folders", undefined],
      ["POST", "/api/folders", { name: "New" }],
      ["PUT", "/api/folders/folder-a", { name: "Rename" }],
      ["DELETE", "/api/folders/folder-a", undefined],
      ["PATCH", "/api/folders/reorder", [{ id: "folder-a", sortOrder: 2 }]],
    ] as const) {
      expect(await app.inject({ method, url, payload })).toMatchObject({
        statusCode: 404,
      });
    }

    await app.close();
  });

  it("registers Python auth contract rows for route inventory order 64-68", () => {
    expect(folderRouteAuthRequirements).toEqual({
      "GET /api/folders": true,
      "POST /api/folders": true,
      "PUT /api/folders/:folder_id": true,
      "DELETE /api/folders/:folder_id": true,
      "PATCH /api/folders/reorder": true,
    });

    const routeRows = fixtures.routeInventory.routes
      .filter((route) =>
        [
          "list_folders",
          "create_folder",
          "update_folder",
          "delete_folder",
          "reorder_folders",
        ].includes(route.name),
      )
      .map((route) => [route.order, route.methods[0], route.path, route.authRequired]);

    expect(routeRows).toEqual([
      [64, "GET", "/api/folders", true],
      [65, "POST", "/api/folders", true],
      [66, "PUT", "/api/folders/{folder_id}", true],
      [67, "DELETE", "/api/folders/{folder_id}", true],
      [68, "PATCH", "/api/folders/reorder", true],
    ]);
  });

  it("lists unrestricted folders without loading session assignments", async () => {
    const { app, calls } = createAppWithFolders({ restricted: false });

    const response = await app.inject({ method: "GET", url: "/api/folders" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      folders,
      sessions: {},
      access: { restricted: false, allowedFolderIds: [] },
    });
    expect(calls).toEqual([["access"], ["listFolders"]]);

    await app.close();
  });

  it("lists restricted folders with descendant visibility and filtered assignments", async () => {
    const { app, calls } = createAppWithFolders({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({ method: "GET", url: "/api/folders" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      folders: [folders[0], folders[1]],
      sessions: {
        "sess-a": assignments["sess-a"],
        "sess-child": assignments["sess-child"],
      },
      access: { restricted: true, allowedFolderIds: ["folder-a"] },
    });
    expect(calls).toEqual([
      ["access"],
      ["listFolders"],
      ["listSessionAssignments"],
    ]);

    await app.close();
  });

  it("creates folders with Python defaults after parent access check", async () => {
    const { app, calls } = createAppWithFolders({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/folders",
      payload: { name: "New child", parentFolderId: "folder-a-child" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      id: "created",
      name: "New child",
      sortOrder: 0,
      parentFolderId: "folder-a-child",
    });
    expect(calls).toEqual([
      ["access"],
      ["listFolders"],
      ["create", "New child", 0, { parentFolderId: "folder-a-child" }],
    ]);

    await app.close();
  });

  it("passes only supplied update fields and treats parentFolderId null as supplied", async () => {
    const { app, calls } = createAppWithFolders({ restricted: false });

    await app.inject({
      method: "PUT",
      url: "/api/folders/folder-a",
      payload: { settings: { color: "red" } },
    });
    await app.inject({
      method: "PUT",
      url: "/api/folders/folder-a",
      payload: { parentFolderId: null },
    });

    expect(calls).toEqual([
      ["access"],
      ["listFolders"],
      ["update", "folder-a", { settings: { color: "red" } }],
      ["access"],
      ["listFolders"],
      ["update", "folder-a", { parentFolderId: null }],
    ]);

    await app.close();
  });

  it("blocks disallowed restricted folders before mutation", async () => {
    const { app, calls } = createAppWithFolders({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const update = await app.inject({
      method: "PUT",
      url: "/api/folders/folder-b",
      payload: { name: "Blocked" },
    });
    const create = await app.inject({
      method: "POST",
      url: "/api/folders",
      payload: { name: "Blocked", parentFolderId: null },
    });

    expect(update.statusCode).toBe(403);
    expect(create.statusCode).toBe(403);
    expect(update.json()).toEqual({ detail: "Folder access denied" });
    expect(create.json()).toEqual({ detail: "Folder access denied" });
    expect(calls).toEqual([
      ["access"],
      ["listFolders"],
      ["access"],
      ["listFolders"],
    ]);

    await app.close();
  });

  it("allows system folder settings updates but blocks rename, move, delete, and reorder", async () => {
    const { app, calls } = createAppWithFolders({ restricted: false });

    const settings = await app.inject({
      method: "PUT",
      url: "/api/folders/claude",
      payload: { settings: { hidden: true } },
    });
    const rename = await app.inject({
      method: "PUT",
      url: "/api/folders/claude",
      payload: { name: "Claude 2" },
    });
    const move = await app.inject({
      method: "PUT",
      url: "/api/folders/claude",
      payload: { parentFolderId: null },
    });
    const deletion = await app.inject({
      method: "DELETE",
      url: "/api/folders/llm",
    });
    const reorder = await app.inject({
      method: "PATCH",
      url: "/api/folders/reorder",
      payload: [{ id: "claude", sortOrder: 10 }],
    });

    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toEqual({ success: true });
    expect(rename.statusCode).toBe(400);
    expect(rename.json()).toEqual({
      detail: "System folder 'claude' cannot be renamed.",
    });
    expect(move.statusCode).toBe(400);
    expect(move.json()).toEqual({
      detail: "System folder 'claude' cannot be moved.",
    });
    expect(deletion.statusCode).toBe(400);
    expect(deletion.json()).toEqual({
      detail: "System folder 'llm' cannot be deleted.",
    });
    expect(reorder.statusCode).toBe(400);
    expect(reorder.json()).toEqual({
      detail: "System folder 'claude' cannot be moved or reordered.",
    });
    expect(calls).toEqual([
      ["access"],
      ["listFolders"],
      ["update", "claude", { settings: { hidden: true } }],
      ["access"],
      ["listFolders"],
      ["access"],
      ["listFolders"],
      ["access"],
      ["listFolders"],
      ["access"],
      ["listFolders"],
    ]);

    await app.close();
  });

  it("keeps reorder static route from being consumed as a folder_id route", async () => {
    const { app, calls } = createAppWithFolders({ restricted: false });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/folders/reorder",
      payload: [
        { id: "folder-a", sortOrder: 2 },
        { id: "folder-b", sortOrder: 1, parentFolderId: null },
      ],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(calls).toEqual([
      ["access"],
      ["listFolders"],
      [
        "reorder",
        [
          { id: "folder-a", sortOrder: 2 },
          { id: "folder-b", sortOrder: 1, parentFolderId: null },
        ],
      ],
    ]);

    await app.close();
  });

  it("maps provider validation errors to a predictable detail envelope", async () => {
    const { app } = createAppWithFolders(
      { restricted: false },
      {
        async createFolder() {
          throw new FolderRouteError("FOLDER_EXISTS", "Folder already exists", 400);
        },
      },
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/folders",
      payload: { name: "Duplicate" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ detail: "Folder already exists" });

    await app.close();
  });
});

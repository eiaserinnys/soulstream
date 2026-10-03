import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFolderRoutes, type FolderRouteOptions } from "../src/folders/folder_routes.js";
import type { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import type { FolderControlPlaneService } from "../src/folders/folder_control_plane_service.js";

const row = { id: "f", name: "기존 폴더", parent_folder_id: null, project_page_id: "p", sort_order: 0,
  settings: {}, archived: false, status: "open", version: 3,
  created_session_id: null, created_event_id: null, created_at: new Date("2026-09-30Z"), updated_at: new Date("2026-09-30Z") };
const item = { id: "i", folder_id: "f", title: "카드", request: "절차", brief: "경과" };
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
function setup({ user = "user@example.com", restricted = false } = {}) {
  const snapshot = { folder: row, cards: [item] };
  const getFolder = vi.fn(async () => snapshot);
  const listFolders = vi.fn(async () => [row]);
  const mutate = vi.fn(async () => ({ snapshot, operation: { folder_id: "f", target_kind: "folder", target_id: "f" }, idempotent: false }));
  const cards = { getFolder, listFolders, listOperations: vi.fn(async () => []),
  setFolderStatus: mutate,
  } as unknown as CardControlPlaneService;
  const identity = { create: vi.fn(async () => ({ folder: { id: "f", name: "새 폴더" }, operation: { id: "op" }, idempotent: false })),
    mutateFromFolder: vi.fn(async () => ({ folder: { id: "f", archived: true }, operation: { id: "op" }, idempotent: false })) };
  const app = Fastify(); apps.push(app);
  registerFolderRoutes(app, {
    provider: { listFolders: () => [{ id: "f" }, { id: "other" }], listSessionAssignments: () => ({ a: { folderId: "f" }, b: { folderId: "other" } }) },
    accessProvider: { resolveAccess: () => ({ restricted, allowedFolderIds: ["f"] }) },
    resolveDashboardUserId: () => user || null, projectIdentityService: identity as unknown as FolderRouteOptions["projectIdentityService"],
    cardServiceProvider: async () => cards, controlPlaneServiceProvider: async () => ({} as FolderControlPlaneService),
    authBearerToken: "test-token", environment: "production",
  });
  return { app, identity, getFolder, listFolders, mutate };
}

describe("unified folder HTTP and host contracts", () => {
  it("reads folder cards without a checklist visibility field", async () => {
    const { app } = setup();
    const response = await app.inject("/api/folders/f");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ folder: { createdSessionId: null }, cards: [{ folderId: "f", request: "절차" }] });
    expect(response.json().folder).not.toHaveProperty("checklistEnabled");
    const outline = await app.inject("/api/folders/f?view=outline&cardId=i");
    expect(outline.json().cards[0]).not.toHaveProperty("request");
  });
  it("filters and pages outline snapshots from validated HTTP query values", async () => {
    const { app, getFolder } = setup();
    getFolder.mockImplementation(async () => ({ folder: row, cards: [
      { ...item, id: "active-a", archived: false, status: "todo", latest_activity: null },
      { ...item, id: "archived-a", archived: true, status: "todo", latest_activity: null },
      { ...item, id: "active-done", archived: false, status: "done", latest_activity: null },
    ] }));

    const defaultOutline = await app.inject("/api/folders/f?view=outline&limit=1&cursor=1");
    expect(defaultOutline.statusCode).toBe(200);
    expect(defaultOutline.json()).toMatchObject({
      view: "outline", includeArchived: false, totalCards: 2, returnedCount: 1, nextCursor: null,
      cards: [{ id: "active-done", status: "done", archived: false }],
    });

    const archivedOutline = await app.inject("/api/folders/f?view=outline&includeArchived=true&limit=1&cursor=1");
    expect(archivedOutline.statusCode).toBe(200);
    expect(archivedOutline.json()).toMatchObject({
      view: "outline", includeArchived: true, totalCards: 3, returnedCount: 1, nextCursor: "2",
      cards: [{ id: "archived-a", archived: true }],
    });
    expect(getFolder).toHaveBeenLastCalledWith("f", true);
    expect((await app.inject("/api/folders/f?view=outline&includeArchived=sometimes")).statusCode).toBe(422);

    const fullWithListOptions = await app.inject("/api/folders/f?includeArchived=true&limit=1&cursor=1");
    expect(fullWithListOptions.statusCode).toBe(200);
    expect(fullWithListOptions.json()).not.toHaveProperty("view");
    expect(fullWithListOptions.json().cards.map((card: { id: string }) => card.id)).toEqual(["active-a", "archived-a", "active-done"]);

    const direct = await app.inject("/api/folders/f?view=outline&cardId=archived-a&includeArchived=false&limit=invalid&cursor=-1");
    expect(direct.statusCode).toBe(200);
    expect(direct.json()).toMatchObject({
      view: "outline", includeArchived: true, totalCards: 1, returnedCount: 1, nextCursor: null,
      cards: [{ id: "archived-a", archived: true }],
    });
    expect(direct.json().cards[0]).not.toHaveProperty("request");
  });
  it("creates through the identity owner and returns the agreed mutation envelope", async () => {
    const { app, identity } = setup();
    const response = await app.inject({ method: "POST", url: "/api/folders", payload: { name: "새 폴더", idempotencyKey: "new" } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ folder: { id: "f", name: "새 폴더" }, operation: { id: "op" }, idempotent: false });
    expect(identity.create).toHaveBeenCalledWith(expect.objectContaining({ actor: { actorKind: "user", actorSessionId: null, actorUserId: "user@example.com" } }));
  });
  it("writes status without a creating session or board tile", async () => {
    const { app, mutate } = setup();
    const response = await app.inject({ method: "POST", url: "/api/folders/f/status", payload: {
      expectedVersion: 3, idempotencyKey: "status", status: "completed",
    } });
    expect(response.statusCode).toBe(200); expect(mutate).toHaveBeenCalledOnce();
    expect(response.json().folder).not.toHaveProperty("checklistEnabled");
  });
  it("removes checklist mutation and create fields", async () => {
    const { app } = setup();
    expect((await app.inject({ method: "POST", url: "/api/folders/f/checklist-enabled", payload: {
      expectedVersion: 3, idempotencyKey: "removed", checklistEnabled: true,
    } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/folders", payload: {
      name: "새 폴더", idempotencyKey: "old-create-field", checklistEnabled: true,
    } })).statusCode).toBe(422);
  });
  it("archives with CAS and no destructive delete endpoint", async () => {
    const { app, identity } = setup();
    const result = await app.inject({ method: "POST", url: "/api/folders/f/archive", payload: { expectedVersion: 3, idempotencyKey: "archive" } });
    expect(result.statusCode).toBe(200);
    expect(identity.mutateFromFolder).toHaveBeenCalledWith(expect.objectContaining({ folderId: "f", archived: true, expectedVersion: 3 }));
    expect((await app.inject({ method: "DELETE", url: "/api/folders/f" })).statusCode).toBe(404);
  });
  it("checks login, folder access, system protection and removed checklist endpoints", async () => {
    const { app } = setup({ restricted: true });
    expect((await app.inject("/api/folders/other")).statusCode).toBe(403);
    expect((await app.inject("/api/folders")).json().sessions).toEqual({ a: { folderId: "f" } });
    const payload = { expectedVersion: 3, idempotencyKey: "status", status: "completed" };
    expect((await app.inject({ method: "POST", url: "/api/folders/f/checklist/items/wrong/status", payload })).statusCode).toBe(404);
    const loggedOut = setup({ user: "" });
    expect((await loggedOut.app.inject({ method: "POST", url: "/api/folders/f/status", payload })).statusCode).toBe(401);
    const unrestricted = setup();
    expect((await unrestricted.app.inject({ method: "POST", url: "/api/folders/claude/status", payload })).statusCode).toBe(403);
  });
  it("returns version conflicts and rejects old fields at the boundary", async () => {
    const { app, mutate } = setup();
    mutate.mockRejectedValueOnce(Object.assign(new Error("stale"), { statusCode: 409, code: "FOLDER_VERSION_CONFLICT" }));
    const payload = { expectedVersion: 3, idempotencyKey: "status", status: "completed" };
    expect((await app.inject({ method: "POST", url: "/api/folders/f/status", payload })).json()).toMatchObject({ detail: { error: { code: "FOLDER_VERSION_CONFLICT" } } });
    expect((await app.inject({ method: "POST", url: "/api/folders", payload: { name: "x", idempotencyKey: "x", container: { kind: "task", id: "f" } } })).statusCode).toBe(422);
    expect((await app.inject("/api/tasks/f")).statusCode).toBe(404);
  });
  it("uses one bearer-protected host operation for root and child lists", async () => {
    const { app, listFolders } = setup();
    const call = (folder_id: string | null, token = "test-token") => app.inject({ method: "POST", url: "/api/folders/host/list_child_folders", headers: { authorization: `Bearer ${token}` }, payload: { folder_id } });
    expect((await call(null, "bad")).statusCode).toBe(401);
    expect((await call(null)).statusCode).toBe(200);
    expect(listFolders).toHaveBeenLastCalledWith({ folderId: null, includeArchived: false, limit: 51, offset: 0 });
    expect((await call("f")).json()).toMatchObject({ items: [{ id: "f" }], nextCursor: null });
    expect(listFolders).toHaveBeenLastCalledWith({ folderId: "f", includeArchived: false, limit: 51, offset: 0 });
  });
  it("keeps host responses camelCase and mutation results free of a snapshot wrapper", async () => {
    const { app } = setup();
    const response = await app.inject({ method: "POST", url: "/api/folders/host/set_folder_status", headers: { authorization: "Bearer test-token" }, payload: { folder_id: "f", actor_kind: "user", actor_user_id: "u", expected_version: 3, idempotency_key: "host", status: "completed" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ folder: { id: "f" }, operation: { folderId: "f" }, idempotent: false });
    expect(response.json()).not.toHaveProperty("snapshot");
  });
});

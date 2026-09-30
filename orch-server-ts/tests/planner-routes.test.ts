import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPlannerRoutes, type PlannerRouteOptions } from "../src/planner/planner_routes.js";
import type { PlannerReadProvider } from "../src/planner/planner_contract.js";
import { PlannerStarredFolderMembershipConflictError } from "../src/planner/planner_starred_page_order.js";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(a => a.close())); });
function setup(loggedIn = true) {
  const slice = { items: [], nextCursor: null };
  const provider = { getToday: vi.fn(async () => ({ folders: [], memoBlocks: [], reviewSessionIds: [] })),
    getStarredFolders: vi.fn(async () => slice), getDailyHistory: vi.fn(async () => ({ dates: [] })),
    getFolder: vi.fn(async () => ({ folder: { id: "f" } })), getSubfolders: vi.fn(async () => slice),
    getSessions: vi.fn(async () => slice) };
  const moveStarredFolder = vi.fn(async () => ({ pageVersion: 4, changed: true }));
  const onPageUpdated = vi.fn(); const getDailyPage = vi.fn(async () => ({}));
  const app = Fastify(); apps.push(app);
  registerPlannerRoutes(app, { provider: provider as unknown as PlannerReadProvider,
    starredFolderOrder: { moveStarredFolder }, onPageUpdated,
    dailyPages: { getDailyPage } as unknown as PlannerRouteOptions["dailyPages"],
    resolveUser: async () => loggedIn ? { email: "u@example.com" } : null });
  return { app, provider, moveStarredFolder, onPageUpdated, getDailyPage };
}
describe("folder planner HTTP", () => {
  it.each([
    ["/today?date=2026-09-30", "getToday"], ["/starred-folders", "getStarredFolders"],
    ["/daily-history?before=2026-09-30", "getDailyHistory"], ["/folders/f", "getFolder"],
    ["/folders/f/subfolders", "getSubfolders"], ["/folders/f/sessions", "getSessions"],
  ] as const)("authenticates and dispatches %s", async (path, method) => {
    const anonymous = setup(false); expect((await anonymous.app.inject(`/api/planner${path}`)).statusCode).toBe(401);
    const { app, provider } = setup(); expect((await app.inject(`/api/planner${path}`)).statusCode).toBe(200);
    expect(provider[method]).toHaveBeenCalledOnce();
  });
  it("bounds every cursor page and uses folder IDs for folder slices", async () => {
    const { app, provider } = setup();
    expect((await app.inject("/api/planner/starred-folders?limit=101")).statusCode).toBe(422);
    for (const name of ["subfolders", "sessions"]) {
      expect((await app.inject(`/api/planner/folders/f/${name}?limit=51`)).statusCode).toBe(422);
    }
    await app.inject("/api/planner/folders/f/sessions?cursor=c&limit=10");
    expect(provider.getSessions).toHaveBeenCalledWith("f", { cursor: "c", limit: 10 });
  });
  it("does not expose the removed general-page document route", async () => {
    const { app } = setup();
    expect((await app.inject("/api/planner/folders/f/documents")).statusCode).toBe(404);
  });
  it("keeps page IDs in star ordering and broadcasts only after commit", async () => {
    const { app, moveStarredFolder, onPageUpdated } = setup();
    const response = await app.inject({ method: "PATCH", url: "/api/planner/starred-folders/order", payload: { pageId: "p", beforePageId: null } });
    expect(response.statusCode).toBe(200); expect(moveStarredFolder).toHaveBeenCalledWith({ pageId: "p", beforePageId: null });
    expect(onPageUpdated).toHaveBeenCalledWith({ pageId: "p", version: 4 });
    moveStarredFolder.mockRejectedValueOnce(new PlannerStarredFolderMembershipConflictError("no longer starred"));
    expect((await app.inject({ method: "PATCH", url: "/api/planner/starred-folders/order", payload: { pageId: "p", beforePageId: null } })).statusCode).toBe(409);
    expect(onPageUpdated).toHaveBeenCalledOnce();
  });
  it("lazily creates a missing daily page and has no old planner routes", async () => {
    const { app, provider, getDailyPage } = setup();
    provider.getToday.mockResolvedValueOnce(null as never);
    expect((await app.inject("/api/planner/today?date=2026-09-30")).statusCode).toBe(200);
    expect(getDailyPage).toHaveBeenCalledWith({ date: "2026-09-30", actor: { actorKind: "user", actorUserId: "u@example.com" } });
    for (const path of ["starred-tasks", "projects/p", "tasks/p/runs"]) expect((await app.inject(`/api/planner/${path}`)).statusCode).toBe(404);
  });
});

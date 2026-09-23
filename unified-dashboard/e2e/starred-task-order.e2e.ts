import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

test("drags a starred task and refreshes the order after a rejected save", async ({ page }, testInfo) => {
  const state = {
    pageIds: ["starred-a", "starred-b"],
    saves: [] as Array<{ page_id: string; before_page_id: string | null }>,
    reads: 0,
    rejectNextSave: true,
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    if (!navigator.serviceWorker) return;
    Object.defineProperty(navigator.serviceWorker, "register", {
      configurable: true,
      value: async () => ({
        update: async () => undefined,
        active: null,
        installing: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    Object.defineProperty(navigator.serviceWorker, "controller", {
      configurable: true,
      get: () => null,
    });
  });
  await installV3VisualQaRoutes(page);
  await page.route("**/api/planner/starred-tasks**", async (route) => {
    const request = route.request();
    if (request.method() === "PATCH") {
      const body = request.postDataJSON() as { page_id: string; before_page_id: string | null };
      state.saves.push(body);
      if (state.rejectNextSave) {
        state.rejectNextSave = false;
        await fulfillJson(route, {
          detail: { error: { code: "PLANNER_STARRED_TASK_NOT_ACTIVE", message: "stale member" } },
        }, 409);
        return;
      }
      state.pageIds = moveBefore(state.pageIds, body.page_id, body.before_page_id);
      await fulfillJson(route, { ok: true });
      return;
    }
    if (request.method() === "GET") {
      state.reads += 1;
      await fulfillJson(route, {
        items: state.pageIds.map((pageId) => starredTask(pageId)),
        next_cursor: null,
      });
      return;
    }
    await route.fallback();
  });

  await page.goto("http://127.0.0.1:4173/v3", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("v3-starred-task-row-starred-a")).toBeVisible();
  await expect(page.getByTestId("v3-starred-task-row-starred-b")).toBeVisible();
  const initialReads = state.reads;

  await dragRow(page.getByTestId("v3-starred-task-row-starred-a"), page.getByTestId("v3-starred-task-row-starred-b"));
  await expect.poll(() => state.saves.length).toBe(1);
  await expect.poll(() => state.reads).toBe(initialReads + 1);
  expect(state.saves[0]).toEqual({ page_id: "starred-a", before_page_id: null });
  await expectStarredOrder(page, ["starred-a", "starred-b"]);

  await dragRow(page.getByTestId("v3-starred-task-row-starred-a"), page.getByTestId("v3-starred-task-row-starred-b"));
  await expect.poll(() => state.saves.length).toBe(2);
  await expect.poll(() => state.reads).toBe(initialReads + 2);
  await expectStarredOrder(page, ["starred-b", "starred-a"]);
  await page.screenshot({ path: testInfo.outputPath("starred-task-order.png"), animations: "disabled" });
});

test("reorders a starred task with the keyboard", async ({ page }) => {
  const state = { pageIds: ["starred-a", "starred-b"], saves: [] as Array<{ page_id: string; before_page_id: string | null }> };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    if (!navigator.serviceWorker) return;
    Object.defineProperty(navigator.serviceWorker, "register", {
      configurable: true,
      value: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined, removeEventListener: () => undefined }),
    });
    Object.defineProperty(navigator.serviceWorker, "controller", { configurable: true, get: () => null });
  });
  await installV3VisualQaRoutes(page);
  await page.route("**/api/planner/starred-tasks**", async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { page_id: string; before_page_id: string | null };
      state.saves.push(body);
      state.pageIds = moveBefore(state.pageIds, body.page_id, body.before_page_id);
      await fulfillJson(route, { ok: true });
      return;
    }
    if (route.request().method() === "GET") {
      await fulfillJson(route, { items: state.pageIds.map((pageId) => starredTask(pageId)), next_cursor: null });
      return;
    }
    await route.fallback();
  });

  await page.goto("http://127.0.0.1:4173/v3", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("v3-starred-task-row-starred-a")).toBeVisible();
  const keyboardHandle = page.getByRole("button", { name: "중요 작업 Starred B 순서 변경" });
  await expect(keyboardHandle).toBeEnabled();
  await keyboardHandle.focus();
  await keyboardHandle.press("ArrowUp");

  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.saves[0]).toEqual({ page_id: "starred-b", before_page_id: "starred-a" });
  await expectStarredOrder(page, ["starred-b", "starred-a"]);
});

test("drops at the visible end before the first unloaded page", async ({ page }) => {
  const state = {
    pageIds: ["starred-a", "starred-b", "starred-c"],
    saves: [] as Array<{ page_id: string; before_page_id: string | null }>,
    boundaryCursors: [] as string[],
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    if (!navigator.serviceWorker) return;
    Object.defineProperty(navigator.serviceWorker, "register", {
      configurable: true,
      value: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined, removeEventListener: () => undefined }),
    });
    Object.defineProperty(navigator.serviceWorker, "controller", { configurable: true, get: () => null });
  });
  await installV3VisualQaRoutes(page);
  await page.route("**/api/planner/starred-tasks**", async (route) => {
    const url = new URL(route.request().url());
    const cursor = url.searchParams.get("cursor");
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { page_id: string; before_page_id: string | null };
      state.saves.push(body);
      state.pageIds = moveBefore(state.pageIds, body.page_id, body.before_page_id);
      await fulfillJson(route, { ok: true });
      return;
    }
    if (route.request().method() === "GET") {
      if (cursor === "opaque-boundary-cursor") {
        state.boundaryCursors.push(cursor);
        await fulfillJson(route, {
          items: [starredTask("starred-c")],
          next_cursor: null,
        });
        return;
      }
      await fulfillJson(route, {
        items: state.pageIds.slice(0, 2).map((pageId) => starredTask(pageId)),
        next_cursor: "opaque-boundary-cursor",
      });
      return;
    }
    await route.fallback();
  });

  await page.goto("http://127.0.0.1:4173/v3", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("v3-starred-task-row-starred-a")).toBeVisible();
  await expect(page.getByTestId("v3-starred-task-row-starred-b")).toBeVisible();
  await dragRow(page.getByTestId("v3-starred-task-row-starred-a"), page.getByTestId("v3-starred-task-row-starred-b"));

  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.boundaryCursors).toEqual(["opaque-boundary-cursor"]);
  expect(state.saves[0]).toEqual({ page_id: "starred-a", before_page_id: "starred-c" });
  await expectStarredOrder(page, ["starred-b", "starred-a"]);
});

async function dragRow(active: Locator, over: Locator): Promise<void> {
  const handle = active.getByRole("button", { name: "중요 작업 Starred A 순서 변경" });
  const handleBox = await handle.boundingBox();
  const overBox = await over.boundingBox();
  if (!handleBox || !overBox) throw new Error("별표 업무 행의 드래그 위치를 확인하지 못했습니다.");
  await handle.scrollIntoViewIfNeeded();
  await handle.hover();
  await handle.page().mouse.down();
  await handle.page().mouse.move(overBox.x + overBox.width / 2, overBox.y + overBox.height / 2, { steps: 8 });
  await handle.page().mouse.up();
}

async function expectStarredOrder(page: Page, pageIds: string[]): Promise<void> {
  await expect.poll(async () => await page.getByTestId("v3-starred-tasks")
    .locator(":scope > .v3-starred-task-row")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-testid"))))
    .toEqual(pageIds.map((pageId) => `v3-starred-task-row-${pageId}`));
}

function starredTask(pageId: string) {
  const title = pageId === "starred-a" ? "Starred A" : "Starred B";
  return {
    page: {
      id: pageId,
      title,
      daily_date: null,
      version: 1,
      archived: false,
      metadata: { starred: true },
      created_at: "2026-07-15T00:00:00.000Z",
      updated_at: "2026-07-15T00:00:00.000Z",
    },
    blocks: [],
    task_id: `${pageId}-task`,
    task: null,
    project_page_id: null,
    sessions: [],
    mounted_documents: [],
  };
}

function moveBefore(pageIds: readonly string[], movedPageId: string, beforePageId: string | null): string[] {
  const remaining = pageIds.filter((pageId) => pageId !== movedPageId);
  const destination = beforePageId === null ? remaining.length : remaining.indexOf(beforePageId);
  if (destination < 0) throw new Error("별표 업무 경계를 확인할 수 없습니다.");
  remaining.splice(destination, 0, movedPageId);
  return remaining;
}

async function fulfillJson(
  route: Route,
  body: unknown,
  status = 200,
): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

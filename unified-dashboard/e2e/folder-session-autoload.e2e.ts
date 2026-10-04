import { expect, test, type Page } from "@playwright/test";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

// Only HTTP data is replaced. Scrolling, layout and IntersectionObserver are Chromium's.
type Surface = "detail" | "board";
function session(folderId: string, index: number) {
  return { agentSessionId: `${folderId}-auto-${index}`, folderId, displayName: `자동 세션 ${index}`,
    status: "completed", eventCount: 0, nodeId: "eiaserinnys", agentId: "roselin_codex",
    agentName: "로젤린", createdAt: new Date(Date.parse("2026-07-14T01:30:00Z") - index * 60_000).toISOString(), updatedAt: "2026-07-14T01:30:00Z" };
}
async function setup(page: Page, { first = 30, total = 70, fail = false, delayed = false, delayTargeted = false } = {}) {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "false");
  });
  await installV3VisualQaRoutes(page);
  const targetedReleases: (() => void)[] = [];
  let targetedPending = 0;
  let targetedCompleted = 0;
  await page.route("**/api/sessions?*", async route => {
    const url = new URL(route.request().url());
    const ids = url.searchParams.getAll("session_id");
    if (!ids.some(id => id.includes("-auto-"))) return route.fallback();
    if (delayTargeted && ids.some(id => Number(id.split("-auto-")[1]) >= first)) {
      targetedPending++;
      await new Promise<void>(resolve => { targetedReleases.push(resolve); });
    }
    const sessions = ids.filter(id => id.includes("-auto-")).map(id => {
      const [folderId, index] = id.split("-auto-");
      return session(folderId, Number(index));
    });
    await route.fulfill({ json: { sessions, total: sessions.length } });
    if (delayTargeted && ids.some(id => Number(id.split("-auto-")[1]) >= first)) targetedCompleted++;
  });
  const cursors: string[] = [];
  let release: (() => void) | undefined;
  let aggregateReads = 0;
  let updatedFirst = false;
  await page.route("**/api/planner/folders/*?*", async route => {
    const url = new URL(route.request().url());
    const folderId = url.pathname.split("/").at(-1)!;
    if (!["folder-amber", "folder-ops"].includes(folderId)) return route.fallback();
    aggregateReads++;
    const name = folderId === "folder-amber" ? "소울스트림" : "Soulstream 운영";
    const pageId = folderId === "folder-amber" ? "project-amber" : "project-ops";
    const count = folderId === "folder-amber" ? first : 1;
    await route.fulfill({ json: {
      folder: { id: folderId, name, projectPageId: pageId, parentFolderId: null,
        status: "open", archived: false, version: 1, settings: {} },
      page: { id: pageId, title: name, version: 1, metadata: {}, archived: false },
      blocks: [], cards: [], sections: [], items: [], subfolders: { items: [], nextCursor: null },
      sessions: { items: Array.from({ length: count }, (_, i) => ({ ...session(folderId, i),
        status: updatedFirst && i === 0 ? "running" : "completed" })),
        nextCursor: count < total && folderId === "folder-amber" ? String(count) : null },
    } });
  });
  await page.route("**/api/planner/folders/*/sessions?*", async route => {
    const url = new URL(route.request().url());
    const folderId = url.pathname.split("/").at(-2)!;
    const cursor = url.searchParams.get("cursor")!;
    cursors.push(cursor);
    if (delayed) await new Promise<void>(resolve => { release = resolve; });
    if (fail && cursors.length === 1) return route.fulfill({ status: 503, json: { detail: "fixture failure" } });
    const start = Number(cursor), end = Math.min(start + 20, total);
    await route.fulfill({ json: { items: Array.from({ length: end - start }, (_, i) => session(folderId, start + i)),
      nextCursor: end < total ? String(end) : null } });
  });
  return { cursors, release: () => release?.(), aggregateReads: () => aggregateReads,
    targetedPending: () => targetedPending,
    targetedCompleted: () => targetedCompleted,
    releaseTargeted: () => { targetedReleases.splice(0).forEach(release => release()); },
    updateFirst: () => { updatedFirst = true; } };
}
async function open(page: Page, surface: Surface) {
  await page.goto("/v3", { waitUntil: "domcontentloaded" });
  await page.getByTestId("v3-all-projects").getByRole("button", { name: "소울스트림", exact: true }).click();
  await expect(page.locator(".v3-task-title-button")).toHaveText("소울스트림");
  if (surface === "board") {
    await page.getByRole("button", { name: "폴더 보드 열기", exact: true }).click();
    await page.getByRole("tab", { name: /세션/ }).click();
  }
  return page.locator(surface === "board" ? ".v3-folder-board-resource-content" : ".v3-planner-scroll");
}
async function wheel(page: Page, surface: Surface, delta = 10000) {
  const scroller = page.locator(surface === "board" ? ".v3-folder-board-resource-content" : ".v3-planner-scroll");
  const box = (await scroller.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, delta);
}

for (const surface of ["detail", "board"] as const) {
  for (const width of [1440, 1024]) {
    test(`${surface}: captures visible appended sessions · ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      const network = await setup(page, { total: 50, delayed: true });
      const scroller = await open(page, surface);
      await wheel(page, surface);
      await expect.poll(() => network.cursors.length).toBe(1);
      network.release();
      const appended = scroller.locator('[data-session-id="folder-amber-auto-49"]');
      await expect(appended).toHaveCount(1);
      await wheel(page, surface);
      await expect(appended).toBeInViewport();
      await page.screenshot({ path: `e2e/test-results/folder-session-autoload/appended-${surface}-${width}.png` });
    });

    test(`${surface}: wheel appends, preserves visible row, deduplicates and stops at end · ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      const network = await setup(page, { delayed: true, delayTargeted: true });
      const scroller = await open(page, surface);
      if (process.env.AUTOLOAD_BEFORE) await page.screenshot({ path: `e2e/test-results/folder-session-autoload/before-${surface}-1440.png` });
      await expect(page.getByRole("button", { name: "이전 세션 더 보기", exact: true })).toHaveCount(0);
      await wheel(page, surface);
      await expect.poll(() => network.cursors.length).toBe(1);
      // Select an actually visible row after the wheel has settled, before releasing HTTP.
      const anchor = await scroller.locator("[data-session-id]").evaluateAll(rows => {
        const visible = rows.find(row => { const r = row.getBoundingClientRect(); return r.top > 150 && r.bottom < 850; });
        return visible ? { id: visible.getAttribute("data-session-id"), top: visible.getBoundingClientRect().top } : null;
      });
      expect(anchor).not.toBeNull();
      network.release();
      await expect(scroller.locator(`[data-session-id="folder-amber-auto-49"]`)).toHaveCount(1);
      await expect.poll(() => network.targetedPending()).toBe(1);
      const after = await scroller.locator(`[data-session-id="${anchor!.id}"]`).boundingBox();
      expect(Math.abs(after!.y - anchor!.top)).toBeLessThanOrEqual(2);
      network.releaseTargeted();
      await expect.poll(() => network.targetedCompleted()).toBe(1);
      await expect.poll(async () => Math.abs(await scroller.locator(`[data-session-id="${anchor!.id}"]`).evaluate(row => row.getBoundingClientRect().top) - anchor!.top)).toBeLessThanOrEqual(2);
      await test.info().attach("position-and-requests", { body: JSON.stringify({ surface, anchor, afterPage: after!.y,
        afterTargeted: await scroller.locator(`[data-session-id="${anchor!.id}"]`).evaluate(row => row.getBoundingClientRect().top), cursors: network.cursors }), contentType: "application/json" });
      await page.screenshot({ path: `e2e/test-results/folder-session-autoload/loaded-${surface}-${width}.png` });
      await wheel(page, surface, 10000);
      await page.keyboard.press("End");
      await expect.poll(() => network.cursors.length).toBe(2);
      await wheel(page, surface, 10000);
      network.release();
      await expect(scroller.locator('[data-session-id="folder-amber-auto-69"]')).toHaveCount(1);
      await expect.poll(() => network.targetedPending()).toBe(2);
      network.releaseTargeted();
      expect(new Set(network.cursors).size).toBe(network.cursors.length);
      await expect(scroller.locator(".v3-run-load-more")).toHaveCount(0);
      await wheel(page, surface, 10000);
      await page.waitForTimeout(500);
      expect(network.cursors).toHaveLength(2);
    });
  }

  test(`${surface}: short initial list fills without input`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const network = await setup(page, { first: 1, total: 3 });
    const scroller = await open(page, surface);
    await expect(scroller.locator('[data-session-id="folder-amber-auto-2"]')).toHaveCount(1);
    expect(network.cursors).toEqual(["1"]);
    await expect(scroller.locator(".v3-run-load-more")).toHaveCount(0);
  });

  for (const width of [1440, 1024]) {
    test(`${surface}: failure pauses and retry resumes · ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      const network = await setup(page, { first: 1, total: 3, fail: true });
      const scroller = await open(page, surface);
      await expect(scroller.getByText("세션을 더 불러오지 못했습니다", { exact: true })).toBeVisible();
      await wheel(page, surface);
      await page.screenshot({ path: `e2e/test-results/folder-session-autoload/error-${surface}-${width}.png` });
      await page.waitForTimeout(2000);
      expect(network.cursors).toEqual(["1"]);
      await scroller.getByRole("button", { name: "다시 시도", exact: true }).click();
      await expect(scroller.locator('[data-session-id="folder-amber-auto-2"]')).toHaveCount(1);
      await page.screenshot({ path: `e2e/test-results/folder-session-autoload/loaded-${surface}-${width}.png` });
      expect(network.cursors).toEqual(["1", "1"]);
    });
  }
}

test("late A page stays out of folder B", async ({ page }) => {
  const network = await setup(page, { first: 1, total: 3, delayed: true });
  await open(page, "detail");
  await wheel(page, "detail");
  await expect.poll(() => network.cursors.length).toBe(1);
  await page.getByTestId("v3-all-projects").getByRole("button", { name: "Soulstream 운영", exact: true }).click();
  await expect(page.locator('[data-session-id="folder-ops-auto-0"]')).toHaveCount(1);
  network.release();
  await page.waitForTimeout(300);
  await expect(page.locator('[data-session-id^="folder-amber-auto-"]')).toHaveCount(0);
});

test("same-folder aggregate refresh retains appended history", async ({ page }) => {
  const network = await setup(page, { first: 1, total: 21 });
  const scroller = await open(page, "detail");
  // The baseline branch reproduces the existing button flow before automatic loading exists.
  if (process.env.AUTOLOAD_BEFORE) await page.getByRole("button", { name: "이전 세션 더 보기", exact: true }).click();
  await expect(scroller.locator('[data-session-id="folder-amber-auto-20"]')).toHaveCount(1);
  const readsBeforeSave = network.aggregateReads();
  network.updateFirst(); // The next HTTP aggregate includes a session status change.
  await page.getByRole("button", { name: "폴더 설명 편집", exact: true }).first().click();
  await page.getByRole("textbox", { name: "폴더 설명 마크다운" }).fill("집계 새로고침 재현");
  await page.getByRole("button", { name: "폴더 설명 저장", exact: true }).click();
  await expect.poll(() => network.aggregateReads()).toBeGreaterThan(readsBeforeSave);
  await page.waitForTimeout(300);
  await expect(scroller.locator('[data-session-id="folder-amber-auto-20"]')).toHaveCount(1);
  expect(network.cursors).toEqual(["1"]);
});

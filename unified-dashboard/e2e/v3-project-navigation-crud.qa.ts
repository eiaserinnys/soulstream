import type { Browser, Page, Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_BW_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-project-navigation-crud"),
);

const result = await runPlaywrightLifecycle({
  lockName: "pr-bw-v3-project-navigation-crud",
  timeoutMs: 240_000,
}, async ({ browser }) => ({
  dark: await verifyTheme(browser, "dark"),
  light: await verifyTheme(browser, "light"),
}));

console.log(JSON.stringify({ ok: true, residualProcesses: 0, ...result }, null, 2));

async function verifyTheme(browser: Browser, theme: "dark" | "light") {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const fixture = createProjectCrudFixture();
  await page.addInitScript({ content: `
    localStorage.setItem("soul-dashboard-theme", ${JSON.stringify(theme)});
    localStorage.setItem("ls.webglGlass", "0");
    const serviceWorker = navigator.serviceWorker;
    if (serviceWorker) {
      Object.defineProperty(serviceWorker, "register", {
        configurable: true,
        value: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined, removeEventListener: () => undefined }),
      });
      Object.defineProperty(serviceWorker, "controller", { configurable: true, get: () => null });
    }
  ` });
  await installV3VisualQaRoutes(page, { contextChainPreview: true });
  await page.route("**/api/**", (route) => fixture.route(route));

  try {
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    const projects = page.getByTestId("v3-all-projects");
    await projects.waitFor({ state: "visible" });

    assert(await projectRow(page, "대시보드").count() === 0, "자식 프로젝트가 기본 펼침으로 노출됐습니다.");
    await page.getByRole("button", { name: "소울스트림 펼치기" }).click();
    await projectRow(page, "대시보드").waitFor({ state: "visible" });
    assert(await page.evaluate(() => localStorage.getItem("soulstream:folder-tree:expanded:v1:folder-amber")) === "true", "v1 열림 상태 정본에 저장되지 않았습니다.");
    await page.reload({ waitUntil: "domcontentloaded" });
    await projectRow(page, "대시보드").waitFor({ state: "visible" });

    const amber = projectRow(page, "소울스트림");
    const amberBox = await amber.boundingBox();
    if (!amberBox) throw new Error("프로젝트 행을 측정하지 못했습니다.");
    await amber.click({ button: "right", position: { x: 120, y: 14 } });
    for (const label of ["새 프로젝트", "하위 프로젝트 만들기", "프로젝트 설정", "프로젝트 삭제"]) {
      await page.getByRole("menuitem", { name: label }).waitFor({ state: "visible" });
    }
    const menu = page.getByRole("menu");
    const menuBox = await menu.boundingBox();
    if (!menuBox) throw new Error("컨텍스트 메뉴를 측정하지 못했습니다.");
    assert(Math.abs(menuBox.x - (amberBox.x + 120)) <= 8, "컨텍스트 메뉴의 가로 앵커가 포인터 위치에서 이동했습니다.");
    assert(menuBox.y >= amberBox.y + 14 && menuBox.y <= amberBox.y + 30, "컨텍스트 메뉴의 세로 앵커가 포인터 위치에서 이동했습니다.");
    await capture(page, theme, "01-context-menu");

    await page.getByRole("menuitem", { name: "프로젝트 설정" }).click();
    const settingsForm = page.getByTestId("v3-project-dialog-form");
    await settingsForm.waitFor({ state: "visible" });
    assert(await formSections(settingsForm) === "guidance|atom|기본 에이전트", "설정 창 폼 구성이 다릅니다.");
    const settingsName = settingsForm.getByLabel("프로젝트 이름");
    await settingsName.fill("소울스트림 개선");
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await projectRow(page, "소울스트림 개선").waitFor({ state: "visible" });

    await page.getByLabel("새 프로젝트", { exact: true }).click();
    const createForm = page.getByTestId("v3-project-dialog-form");
    await createForm.waitFor({ state: "visible" });
    assert(await formSections(createForm) === "guidance|atom|기본 에이전트", "생성 창과 설정 창의 폼 구성이 다릅니다.");
    await createForm.getByLabel("프로젝트 이름").fill("신규 프로젝트");
    await page.getByRole("button", { name: "만들기", exact: true }).click();
    await projectRow(page, "신규 프로젝트").waitFor({ state: "visible" });

    const renamed = projectRow(page, "소울스트림 개선");
    await renamed.click({ button: "right" });
    await page.getByRole("menuitem", { name: "하위 프로젝트 만들기" }).click();
    await page.getByTestId("v3-project-dialog-form").getByLabel("프로젝트 이름").fill("하위 신규");
    await page.getByRole("button", { name: "만들기", exact: true }).click();
    const child = projectRow(page, "하위 신규");
    await child.waitFor({ state: "visible" });
    assert(await child.getByRole("button", { name: "하위 신규", exact: true }).getAttribute("aria-level") === "2", "하위 프로젝트가 부모 아래에 생성되지 않았습니다.");

    await dragProject(page, "신규 프로젝트", "대시보드");
    await expectAriaLevel(page, "신규 프로젝트", "3", fixture.reorders);
    assert(fixture.reorders.some((items) => items.some((item) => item.id === "project-created-1" && item.parentFolderId !== null)), `계층 이동 PATCH가 기록되지 않았습니다 · ${JSON.stringify(fixture.reorders)}`);

    await startProjectDrag(page, "신규 프로젝트");
    const rootDrop = page.getByTestId("v3-project-root-drop");
    await rootDrop.waitFor({ state: "visible" });
    const rootBox = await rootDrop.boundingBox();
    if (!rootBox) throw new Error("최상위 드롭 표면을 측정하지 못했습니다.");
    await page.mouse.move(rootBox.x + rootBox.width / 2, rootBox.y + rootBox.height / 2, { steps: 8 });
    await page.mouse.up();
    await expectAriaLevel(page, "신규 프로젝트", "1", fixture.reorders);

    await renamed.click({ button: "right" });
    await page.getByRole("menuitem", { name: "프로젝트 삭제" }).click();
    await page.getByRole("heading", { name: "프로젝트 삭제" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "취소" }).click();

    await projectRow(page, "신규 프로젝트").click({ button: "right" });
    await page.getByRole("menuitem", { name: "프로젝트 삭제" }).click();
    await projectRow(page, "신규 프로젝트").waitFor({ state: "detached" });
    assert(await page.getByRole("heading", { name: "프로젝트 삭제" }).count() === 0, "빈 프로젝트 삭제에 불필요한 확인 창이 열렸습니다.");
    await capture(page, theme, "02-crud-dnd-complete");

    return {
      createRequests: fixture.createdCount,
      reorderRequests: fixture.reorders.length,
      deleteRequests: fixture.deletedIds.length,
      persistedExpansion: true,
    };
  } finally {
    await context.close();
  }
}

function createProjectCrudFixture() {
  let folders = [
    { id: "folder-amber", name: "소울스트림", sortOrder: 0, parentFolderId: null as string | null, projectPageId: "project-amber" },
    { id: "folder-dashboard", name: "대시보드", sortOrder: 0, parentFolderId: "folder-amber", projectPageId: "project-dashboard" },
    { id: "folder-ops", name: "Soulstream 운영", sortOrder: 1, parentFolderId: null as string | null, projectPageId: "project-ops" },
  ];
  let createdCount = 0;
  const reorders: Array<Array<{ id: string; parentFolderId: string | null; sortOrder: number }>> = [];
  const deletedIds: string[] = [];

  return {
    get createdCount() { return createdCount; },
    reorders,
    deletedIds,
    async route(route: Route) {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/folders" && request.method() === "GET") {
        return fulfillJson(route, { folders, sessions: {} });
      }
      if (url.pathname === "/api/folders" && request.method() === "POST") {
        const payload = request.postDataJSON() as { name: string; parentFolderId?: string | null };
        createdCount += 1;
        const folder = {
          id: `project-created-${createdCount}`,
          name: payload.name,
          parentFolderId: payload.parentFolderId ?? null,
          sortOrder: folders.filter((candidate) => candidate.parentFolderId === (payload.parentFolderId ?? null)).length,
          projectPageId: `project-created-${createdCount}`,
        };
        folders = [...folders, folder];
        return fulfillJson(route, folder);
      }
      const folderMatch = /^\/api\/folders\/([^/]+)$/.exec(url.pathname);
      if (folderMatch && request.method() === "PUT") {
        const id = decodeURIComponent(folderMatch[1]);
        const payload = request.postDataJSON() as { name: string };
        folders = folders.map((folder) => folder.id === id ? { ...folder, name: payload.name } : folder);
        return fulfillJson(route, { ok: true });
      }
      if (folderMatch && request.method() === "DELETE") {
        const id = decodeURIComponent(folderMatch[1]);
        deletedIds.push(id);
        folders = folders.filter((folder) => folder.id !== id);
        return fulfillJson(route, { ok: true });
      }
      if (url.pathname === "/api/folders/reorder" && request.method() === "PATCH") {
        const items = request.postDataJSON() as Array<{ id: string; parentFolderId: string | null; sortOrder: number }>;
        reorders.push(items);
        const updates = new Map(items.map((item) => [item.id, item]));
        folders = folders.map((folder) => updates.has(folder.id) ? { ...folder, ...updates.get(folder.id)! } : folder);
        return fulfillJson(route, { ok: true });
      }
      return route.fallback();
    },
  };
}

function projectRow(page: Page, name: string) {
  return page.getByTestId("v3-all-projects").locator(".v3-project-nav-row").filter({
    has: page.getByRole("button", { name, exact: true }),
  });
}

async function startProjectDrag(page: Page, name: string) {
  const handle = page.getByRole("button", { name: `${name} 이동` });
  const box = await handle.boundingBox();
  if (!box) throw new Error(`${name} 드래그 핸들을 측정하지 못했습니다.`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(100);
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 10, { steps: 10 });
  await page.getByTestId("v3-project-root-drop").waitFor({ state: "visible", timeout: 3_000 });
}

async function dragProject(page: Page, source: string, target: string) {
  await startProjectDrag(page, source);
  const targetBox = await projectRow(page, target).boundingBox();
  if (!targetBox) throw new Error(`${target} 드롭 대상을 측정하지 못했습니다.`);
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 20 });
  await page.waitForTimeout(200);
  await page.mouse.up();
}

async function expectAriaLevel(page: Page, name: string, level: string, reorders: unknown[]) {
  try {
    await page.waitForFunction(({ label, expected }) => {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".v3-project-nav-link")];
    return buttons.some((button) => button.textContent?.trim() === label && button.getAttribute("aria-level") === expected);
    }, { label: name, expected: level }, { timeout: 5_000 });
  } catch {
    const levels = await page.locator(".v3-project-nav-link").evaluateAll((buttons) => buttons.map((button) => ({
      label: button.textContent?.trim(),
      level: button.getAttribute("aria-level"),
    })));
    const errors = await page.locator(".v3-project-star-error").allTextContents();
    throw new Error(`${name} aria-level=${level} 미반영 · reorders=${JSON.stringify(reorders)} · levels=${JSON.stringify(levels)} · errors=${JSON.stringify(errors)}`);
  }
}

async function formSections(form: ReturnType<Page["getByTestId"]>): Promise<string> {
  return await form.locator("fieldset > legend").allTextContents().then((items) => items.map((item) => item.trim()).join("|"));
}

async function capture(page: Page, theme: string, name: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), animations: "disabled", fullPage: true });
}

async function fulfillJson(route: Route, body: unknown) {
  return await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

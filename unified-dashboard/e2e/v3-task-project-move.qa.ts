import type { Browser, Locator, Page, Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_BK_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-task-project-move"),
);

const result = await runPlaywrightLifecycle({
  lockName: "pr-bk-v3-task-project-move",
  timeoutMs: 180_000,
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
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  const audit = { transfers: 0, boardMoves: 0, dailyWrites: 0 };
  await preparePage(page, theme, audit);

  try {
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    const task = page.getByTestId("v3-task-task-alpha");
    await task.waitFor({ state: "visible" });

    await openContextMenu(task);
    await page.getByRole("menuitem", { name: "다른 프로젝트로 이동" }).click();
    const dialog = page.getByRole("dialog", { name: "다른 프로젝트로 이동" });
    await dialog.waitFor({ state: "visible" });
    const target = dialog.getByRole("button", { name: /Soulstream 운영/ });
    await target.click();

    await dialog.getByRole("alert").waitFor({ state: "visible" });
    assert(await projectGroup(page, fixtureTitles.project).getByTestId("v3-task-task-alpha").count() === 1,
      "실패 복구 후 기존 프로젝트에 업무가 돌아오지 않았습니다.");

    await target.click();
    await dialog.waitFor({ state: "detached" });
    await projectGroup(page, "Soulstream 운영").getByTestId("v3-task-task-alpha").waitFor({ state: "visible" });
    assert(await projectGroup(page, fixtureTitles.project).getByTestId("v3-task-task-alpha").count() === 0,
      "이동 후 기존 프로젝트에 업무가 남았습니다.");
    assert(audit.transfers === 3, `프로젝트 페이지 이동/복구 호출 수가 다릅니다: ${audit.transfers}`);
    assert(audit.boardMoves === 2, `보드 이동 호출 수가 다릅니다: ${audit.boardMoves}`);
    assert(audit.dailyWrites === 0, "프로젝트 이동이 데일리 마운트를 변경했습니다.");
    assert(browserErrors.length === 0, `브라우저 오류가 발생했습니다: ${browserErrors.join(" | ")}`);
    await capture(page, theme, "01-project-move");

    return {
      contextMenuParity: true,
      optimisticRollback: true,
      sourceRemoved: true,
      targetReflected: true,
      dailyMountInvariant: true,
      browserErrors: browserErrors.length,
    };
  } finally {
    await context.close();
  }
}

async function preparePage(
  page: Page,
  theme: "dark" | "light",
  audit: { transfers: number; boardMoves: number; dailyWrites: number },
) {
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
  await installV3VisualQaRoutes(page, { contextMenuParity: true });

  await page.route("**/api/pages/task-alpha/backlinks**", async (route) => fulfillJson(route, {
    items: [{
      id: "backlink-task-alpha",
      sourcePageId: "project-amber",
      sourcePageTitle: fixtureTitles.project,
      sourceBlockId: "project-alpha",
      sourceTextPreview: fixtureTitles.primaryTask,
      linkKind: "mount",
      targetPageId: "task-alpha",
      targetBlockId: null,
      sourceStart: 0,
      sourceEnd: fixtureTitles.primaryTask.length,
    }],
    nextCursor: null,
  }));
  await page.route("**/api/pages/block-transfers", async (route) => {
    audit.transfers += 1;
    const input = route.request().postDataJSON() as {
      source: { page_id: string };
      target: { page_id: string };
    };
    return fulfillJson(route, {
      source: mutation(input.source.page_id),
      target: mutation(input.target.page_id),
      target_created: false,
    });
  });
  await page.route("**/api/board-items/**/container", async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/")[3] ?? "");
    if (id !== "runbook:rb-alpha") return route.fallback();
    audit.boardMoves += 1;
    if (audit.boardMoves === 1) return route.fulfill({ status: 204 });
    return fulfillJson(route, {
      ok: true,
      boardItem: {
        id,
        folderId: "folder-ops",
        containerKind: "folder",
        containerId: "folder-ops",
        itemType: "runbook",
        itemId: "rb-alpha",
        x: 0,
        y: 0,
      },
    });
  });
  await page.route("**/api/pages/daily-*/operations", async (route) => {
    audit.dailyWrites += 1;
    return route.fallback();
  });
}

function mutation(pageId: string) {
  return {
    page: {
      id: pageId,
      title: pageId === "project-ops" ? "Soulstream 운영" : fixtureTitles.project,
      daily_date: null,
      version: 5,
      archived: false,
      metadata: {},
      created_at: "2026-07-14T00:00:00Z",
      updated_at: "2026-07-17T00:00:00Z",
    },
    blocks: [],
    operation: { id: `transfer-${pageId}` },
    temp_id_mapping: {},
  };
}

function projectGroup(page: Page, title: string): Locator {
  return page.locator(".v3-project-group").filter({ hasText: title });
}

async function openContextMenu(target: Locator) {
  await target.click({ button: "right" });
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function capture(page: Page, theme: string, name: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), animations: "disabled", fullPage: true });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

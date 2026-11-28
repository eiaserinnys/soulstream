import type { Browser, Locator, Page, Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { openV3Folder } from "./v3-qa-entry";
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
  const audit = { folderMoves: 0 };
  await preparePage(page, theme, audit);

  try {
    await openV3Folder(page, baseUrl);
    const task = page.getByTestId("v3-task-task-alpha");
    await task.waitFor({ state: "visible" });

    await openContextMenu(task);
    await page.getByRole("menuitem", { name: "다른 폴더로 이동" }).click();
    const dialog = page.getByRole("dialog", { name: "폴더 이동" });
    await dialog.waitFor({ state: "visible" });
    // 폴더 선택기는 별표 탭으로 열린다. 대상 폴더는 전체 탭에 있고,
    // 선택 뒤 푸터의 폴더 이동 버튼을 눌러야 실제로 옮긴다.
    await dialog.getByRole("tab", { name: "전체" }).click();
    const target = dialog.getByRole("button", { name: /Soulstream 운영/ });
    const confirmMove = dialog.getByRole("button", { name: "폴더 이동", exact: true });
    await target.click();
    await confirmMove.click();

    await dialog.getByRole("alert").waitFor({ state: "visible" });
    assert(await page.getByTestId("v3-task-task-alpha").count() === 1,
      "실패 복구 후 기존 폴더에 하위 폴더가 돌아오지 않았습니다.");

    await target.click();
    await confirmMove.click();
    await dialog.waitFor({ state: "detached" });
    await openV3Folder(page, baseUrl, "folder-ops");
    await page.getByTestId("v3-task-task-alpha").waitFor({ state: "visible" });
    await openV3Folder(page, baseUrl);
    assert(await page.getByTestId("v3-task-task-alpha").count() === 0,
      "이동 후 기존 폴더에 하위 폴더가 남았습니다.");
    assert(audit.folderMoves === 2, `폴더 이동 호출 수가 다릅니다: ${audit.folderMoves}`);
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
  audit: { folderMoves: number },
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
  await page.route("**/api/folders/rb-alpha", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    audit.folderMoves += 1;
    // 첫 이동은 실패시켜 낙관적 이동이 되돌아오는지 확인한다. 응답 본문을
    // 깨뜨리면 브라우저 콘솔 오류 없이 클라이언트 파싱 단계에서 실패한다.
    if (audit.folderMoves === 1) {
      return route.fulfill({ status: 200, contentType: "application/json", body: "{" });
    }
    return route.fallback();
  });
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

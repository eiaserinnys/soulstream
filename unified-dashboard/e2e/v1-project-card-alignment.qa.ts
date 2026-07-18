import type { Browser, Locator, Page, Route } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

type Theme = "dark" | "light";
type Bounds = { x: number; y: number; width: number; height: number };

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PROJECT_CARD_ALIGNMENT_QA_OUTPUT
    ?? path.join("e2e", "evidence", "v1-project-card-alignment"),
);

const result = await runPlaywrightLifecycle({
  lockName: "v1-project-card-alignment",
  timeoutMs: 180_000,
  launchOptions: { headless: true, args: ["--disable-dev-shm-usage"] },
}, async ({ browser }) => ({
  dark: await verifyTheme(browser, "dark"),
  light: await verifyTheme(browser, "light"),
}));

mkdirSync(outputRoot, { recursive: true });
writeFileSync(path.join(outputRoot, "metrics.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, residualProcesses: 0, ...result }, null, 2));

async function verifyTheme(browser: Browser, theme: Theme) {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  try {
    await page.addInitScript({ content: `
      localStorage.setItem("soul-dashboard-theme", ${JSON.stringify(theme)});
      localStorage.setItem("ls.webglGlass", "0");
      localStorage.setItem("soulstream:folder-workspace:view-mode:v1:folder-amber", "list");
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
    await page.route("**/api/board-items?**", routeProjectBoardItems);

    await page.goto(`${baseUrl}/v1`, { waitUntil: "domcontentloaded" });
    const initial = await openProjectAndMeasure(page);
    await capture(page, theme, "initial");

    await page.reload({ waitUntil: "domcontentloaded" });
    const afterRefresh = await openProjectAndMeasure(page);

    await selectProject(page, "Soulstream 운영");
    await page.getByTestId("folder-runbook-card").waitFor({ state: "detached" });
    const afterReentry = await openProjectAndMeasure(page);
    await capture(page, theme, "reentry");

    assert(browserErrors.length === 0, `${theme}: 브라우저 오류: ${browserErrors.join(" | ")}`);
    return { initial, afterRefresh, afterReentry, browserErrors: 0 };
  } finally {
    await context.close();
  }
}

async function openProjectAndMeasure(page: Page) {
  await selectProject(page, "소울스트림");
  const scrollRoot = page.getByTestId("folder-session-scroll-root");
  const childFolderCard = scrollRoot.locator("section").filter({ hasText: "하위 폴더" }).locator("button").first();
  const runbookCard = scrollRoot.getByTestId("folder-runbook-card").first();
  const sessionCard = scrollRoot.getByTestId("folder-session-card-frame").first();

  await childFolderCard.waitFor({ state: "visible", timeout: 15_000 });
  await runbookCard.waitFor({ state: "visible", timeout: 15_000 });
  await sessionCard.waitFor({ state: "visible", timeout: 15_000 });

  const childFolder = await requireBounds(childFolderCard, "하위 프로젝트 카드");
  const runbook = await requireBounds(runbookCard, "업무 카드");
  const session = await requireBounds(sessionCard, "세션 카드");
  assertAligned(childFolder, session, "하위 프로젝트");
  assertAligned(runbook, session, "업무");
  return { childFolder, runbook, session };
}

async function selectProject(page: Page, name: string) {
  const row = page.locator(".dashboard-sidebar-row").filter({ hasText: name }).first();
  await row.waitFor({ state: "visible", timeout: 15_000 });
  await row.click();
}

async function routeProjectBoardItems(route: Route) {
  const url = new URL(route.request().url());
  if (url.searchParams.get("folder_id") !== "folder-amber") {
    await route.fallback();
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      boardItems: [
        boardItem("runbook", "rb-alpha"),
        boardItem("session", "run-alpha-1"),
        boardItem("session", "run-alpha-2"),
      ],
    }),
  });
}

function boardItem(itemType: "runbook" | "session", itemId: string) {
  return {
    id: `${itemType}:${itemId}`,
    folderId: "folder-amber",
    containerKind: "folder",
    containerId: "folder-amber",
    membershipKind: "primary",
    sourceRunbookItemId: null,
    itemType,
    itemId,
    x: 0,
    y: 0,
    metadata: itemType === "runbook" ? { title: "업무 카드 밀도와 계층 최종 QA" } : {},
    createdAt: "2026-07-14T01:30:00.000Z",
    updatedAt: "2026-07-14T01:30:00.000Z",
  };
}

async function requireBounds(locator: Locator, label: string): Promise<Bounds> {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${label} 경계를 측정하지 못했습니다.`);
  return bounds;
}

function assertAligned(candidate: Bounds, session: Bounds, label: string) {
  assert(Math.abs(candidate.x - session.x) <= 1, `${label} 카드의 왼쪽 기준이 세션과 다릅니다.`);
  assert(Math.abs(candidate.width - session.width) <= 1, `${label} 카드의 열 너비가 세션과 다릅니다.`);
}

async function capture(page: Page, theme: Theme, state: string) {
  const output = path.join(outputRoot, theme);
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: path.join(output, `${state}.png`), animations: "disabled" });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

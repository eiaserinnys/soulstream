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
  const httpErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) httpErrors.push(`${response.status()} ${response.url()}`);
  });

  try {
    let catalogDeltaApplied = false;
    await page.addInitScript({ content: `
      localStorage.setItem("soul-dashboard-theme", ${JSON.stringify(theme)});
      localStorage.setItem("ls.webglGlass", "0");
      localStorage.setItem("soulstream:folder-workspace:view-mode:v1:folder-amber", "list");
      localStorage.setItem("soulstream:folder-workspace:view-mode:v1:folder-ops", "list");
      const nativeEventSource = window.EventSource;
      const catalogDeltaQaEventSources = [];
      class CatalogDeltaQaEventSource extends nativeEventSource {
        constructor(...args) {
          super(...args);
          catalogDeltaQaEventSources.push(this);
        }
      }
      window.EventSource = CatalogDeltaQaEventSource;
      window.__catalogDeltaQaEventSources = catalogDeltaQaEventSources;
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
    await page.route("**/api/sessions?**", (route) =>
      routeCatalogDeltaSessions(route, catalogDeltaApplied)
    );

    await page.goto(`${baseUrl}/v1`, { waitUntil: "domcontentloaded" });
    const initial = await openProjectAndMeasure(page);
    await capture(page, theme, "initial");

    await page.reload({ waitUntil: "domcontentloaded" });
    const afterRefresh = await openProjectAndMeasure(page);

    await selectProject(page, "Soulstream 운영");
    await page.getByTestId("folder-task-card").waitFor({ state: "detached" });
    const afterReentry = await openProjectAndMeasure(page);
    await capture(page, theme, "reentry");

    const catalogDeltaLive = await verifyCatalogDeltaLive(page, () => {
      catalogDeltaApplied = true;
    });
    await capture(page, theme, "catalog-delta-live");

    assert(
      browserErrors.length === 0 && httpErrors.length === 0,
      `${theme}: 브라우저 오류: ${browserErrors.join(" | ")} (${httpErrors.join(" | ")})`,
    );
    return { initial, afterRefresh, afterReentry, catalogDeltaLive, browserErrors: 0 };
  } finally {
    await context.close();
  }
}

async function openProjectAndMeasure(page: Page) {
  await selectProject(page, "소울스트림");
  const scrollRoot = page.getByTestId("folder-session-scroll-root");
  const childFolderCard = scrollRoot.locator("section").filter({ hasText: "하위 폴더" }).locator("button").first();
  const taskCard = scrollRoot.getByTestId("folder-task-card").first();
  const sessionCard = scrollRoot.getByTestId("folder-session-card-frame").first();

  await childFolderCard.waitFor({ state: "visible", timeout: 15_000 });
  await taskCard.waitFor({ state: "visible", timeout: 15_000 });
  await sessionCard.waitFor({ state: "visible", timeout: 15_000 });

  const childFolder = await requireBounds(childFolderCard, "하위 프로젝트 카드");
  const task = await requireBounds(taskCard, "업무 카드");
  const session = await requireBounds(sessionCard, "세션 카드");
  assertAligned(childFolder, session, "하위 프로젝트");
  assertAligned(task, session, "업무");
  return { childFolder, task, session };
}

async function verifyCatalogDeltaLive(page: Page, markApplied: () => void) {
  await selectProject(page, "소울스트림");
  const movedSession = page.locator('[data-session-id="run-alpha-1"]');
  await movedSession.waitFor({ state: "visible", timeout: 15_000 });

  markApplied();
  await page.evaluate(() => {
    const eventSources = (
      window as typeof window & { __catalogDeltaQaEventSources?: EventSource[] }
    ).__catalogDeltaQaEventSources ?? [];
    const sessionStream = eventSources.find((source) => (
      new URL(source.url).pathname === "/api/sessions/stream"
    ));
    if (!sessionStream) throw new Error("세션 스트림 EventSource를 찾지 못했습니다.");
    sessionStream.dispatchEvent(new MessageEvent("catalog_updated", {
      data: JSON.stringify({
        type: "catalog_updated",
        folders: [
          { id: "folder-amber", name: "소울스트림", sortOrder: 0, parentFolderId: null, projectPageId: "project-amber" },
          { id: "folder-dashboard", name: "소울 대시보드", sortOrder: 0, parentFolderId: "folder-amber", projectPageId: "project-dashboard" },
          { id: "folder-ops", name: "Soulstream 운영", sortOrder: 1, parentFolderId: null, projectPageId: "project-ops" },
        ],
        sessions_delta: {
          "run-alpha-1": {
            folderId: "folder-ops",
            displayName: "델타 이동·이름 변경 완료",
          },
        },
        board_items_delta: {},
      }),
    }));
  });

  await movedSession.waitFor({ state: "detached", timeout: 15_000 });
  await selectProject(page, "Soulstream 운영");
  const movedAndRenamed = page.locator('[data-session-id="run-alpha-1"]');
  await movedAndRenamed.waitFor({ state: "visible", timeout: 15_000 });
  await movedAndRenamed.getByText("델타 이동·이름 변경 완료", { exact: true }).waitFor({
    state: "visible",
    timeout: 15_000,
  });
  return {
    sessionId: "run-alpha-1",
    folderId: "folder-ops",
    displayName: "델타 이동·이름 변경 완료",
  };
}

async function routeCatalogDeltaSessions(route: Route, catalogDeltaApplied: boolean) {
  if (!catalogDeltaApplied) {
    await route.fallback();
    return;
  }
  const request = route.request();
  const url = new URL(request.url());
  if (request.method() !== "GET" || url.pathname !== "/api/sessions") {
    await route.fallback();
    return;
  }
  const folderId = url.searchParams.get("folder_id");
  if (folderId !== "folder-amber" && folderId !== "folder-ops") {
    await route.fallback();
    return;
  }
  const sessions = folderId === "folder-ops"
    ? [{
        agentSessionId: "run-alpha-1",
        folderId: "folder-ops",
        status: "completed",
        reviewState: "acknowledged",
        sessionType: "claude",
        createdAt: "2026-07-13T09:00:00.000Z",
        updatedAt: "2026-07-13T11:20:00.000Z",
        completedAt: "2026-07-13T11:20:00.000Z",
        displayName: "델타 이동·이름 변경 완료",
        awaySummary: "카드 계층과 간격 토큰을 목업에 맞춰 정리했습니다.",
        lastMessage: {
          type: "assistant",
          preview: "카드 계층과 간격 토큰을 목업에 맞춰 정리했습니다.",
          timestamp: "2026-07-13T11:20:00.000Z",
        },
        nodeId: "eiaserinnys",
        agentId: "roselin_codex",
        agentName: "로젤린",
      }]
    : [];
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ sessions, total: sessions.length }),
  });
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
        boardItem("task", "rb-alpha"),
        boardItem("session", "run-alpha-1"),
        boardItem("session", "run-alpha-2"),
      ],
    }),
  });
}

function boardItem(itemType: "task" | "session", itemId: string) {
  return {
    id: `${itemType}:${itemId}`,
    folderId: "folder-amber",
    containerKind: "folder",
    containerId: "folder-amber",
    membershipKind: "primary",
    sourceTaskItemId: null,
    itemType,
    itemId,
    x: 0,
    y: 0,
    metadata: itemType === "task" ? { title: "업무 카드 밀도와 계층 최종 QA" } : {},
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

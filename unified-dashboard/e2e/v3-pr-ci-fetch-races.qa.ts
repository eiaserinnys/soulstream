import type { Browser, Page, Route } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

type Theme = "dark" | "light";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_CI_QA_OUTPUT ?? path.join("e2e", "evidence", "pr-ci-fetch-races"),
);

const result = await runPlaywrightLifecycle({
  lockName: "pr-ci-fetch-races",
  timeoutMs: 180_000,
  launchOptions: { headless: true, args: ["--disable-dev-shm-usage"] },
}, async ({ browser }) => {
  const themes = [];
  for (const theme of ["dark", "light"] as const) {
    themes.push(await verifyTheme(browser, theme));
  }
  return { themes };
});

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
  let created = false;
  let runbookReads = 0;
  let boardReads = 0;

  try {
    await preparePage(page, theme, () => created);
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/runbooks" && request.method() === "POST") {
        created = true;
        await fulfillJson(route, {
          id: "task-created",
          page_id: "task-created",
          runbook_id: "task-created",
        });
        return;
      }
      if (url.pathname === "/api/runbooks/task-created" && request.method() === "GET") {
        runbookReads += 1;
        if (runbookReads <= 2) {
          await fulfillJson(route, { detail: "creation projection pending" }, 404);
          return;
        }
        await delay(1_000);
      }
      if (
        url.pathname === "/api/board-items"
        && request.method() === "GET"
        && url.searchParams.get("container_id") === "task-created"
      ) {
        boardReads += 1;
        if (boardReads <= 2) {
          await fulfillJson(route, { detail: "board projection pending" }, 404);
          return;
        }
        await delay(1_000);
      }
      await route.fallback();
    });

    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "새 업무", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    assert(await page.getByTestId("v3-task-task-created").count() === 0, `${theme}: 생성 전 업무가 노출됐습니다.`);

    await page.getByRole("button", { name: "새 업무", exact: true }).click();
    await page.getByLabel("프로젝트 선택").selectOption("folder-amber");
    await page.getByLabel("새 업무 제목").fill(fixtureTitles.createdTask);
    await page.getByLabel("업무 설명").fill("생성 직후 projection loading 전이를 검증한다.");
    await page.getByRole("button", { name: "업무 만들기", exact: true }).click();

    const createdTask = page.getByTestId("v3-task-task-created");
    await createdTask.waitFor({ state: "visible", timeout: 30_000 });
    await createdTask.click();

    const checklist = page.getByTestId("v3-task-runbook-checklist");
    const board = page.getByTestId("v3-inline-board");
    const information = page.locator('[data-task-section="information"]');
    await checklist.getByText("불러오는 중", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await board.getByText("보드 항목을 불러오는 중…", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await board.scrollIntoViewIfNeeded();
    await capture(page, theme, "loading");

    await checklist.getByRole("button", { name: "섹션 추가", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await board.getByText("보드에 표시할 문서가 없습니다.", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await information.waitFor({ state: "visible" });
    await capture(page, theme, "ready");

    assert(runbookReads === 3, `${theme}: 체크리스트 조회 횟수가 다릅니다: ${runbookReads}`);
    assert(boardReads === 3, `${theme}: 보드 조회 횟수가 다릅니다: ${boardReads}`);
    assert(await page.getByText("런북을 찾을 수 없음", { exact: true }).count() === 0, `${theme}: 체크리스트 부재 오류가 남았습니다.`);
    assert(await page.getByText("보드 항목을 불러오지 못했습니다.", { exact: true }).count() === 0, `${theme}: 보드 오류가 남았습니다.`);
    assert(await information.getByRole("alert").count() === 0, `${theme}: 정보 섹션에 오류가 남았습니다.`);
    assert(await page.getByText(/실행 기본값 조회 실패/).count() === 0, `${theme}: 정보 기본값 조회 오류가 남았습니다.`);
    assert(await page.getByText("프로젝트 컨텍스트를 불러오지 못했습니다.", { exact: true }).count() === 0, `${theme}: 프로젝트 컨텍스트 오류가 남았습니다.`);
    const unexpectedBrowserErrors = browserErrors.filter(
      (message) => message !== "Failed to load resource: the server responded with a status of 404 (Not Found)",
    );
    assert(unexpectedBrowserErrors.length === 0, `${theme}: 브라우저 오류: ${unexpectedBrowserErrors.join(" | ")}`);

    const creationRunbookReads = runbookReads;
    const creationBoardReads = boardReads;
    await page.reload({ waitUntil: "domcontentloaded" });
    const createdTaskAfterReload = page.getByTestId("v3-task-task-created");
    await createdTaskAfterReload.waitFor({ state: "visible", timeout: 15_000 });
    await createdTaskAfterReload.click();
    await page.getByTestId("v3-task-runbook-checklist")
      .getByRole("button", { name: "섹션 추가", exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("v3-inline-board")
      .getByText("보드에 표시할 문서가 없습니다.", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    assert(runbookReads === 4, `${theme}: 새로고침 후 체크리스트 조회 횟수가 다릅니다: ${runbookReads}`);
    assert(boardReads === 4, `${theme}: 새로고침 후 보드 조회 횟수가 다릅니다: ${boardReads}`);
    assert(await page.getByText("보드 항목을 불러오지 못했습니다.", { exact: true }).count() === 0, `${theme}: 새로고침 후 보드 오류가 남았습니다.`);
    const finalUnexpectedBrowserErrors = browserErrors.filter(
      (message) => message !== "Failed to load resource: the server responded with a status of 404 (Not Found)",
    );
    assert(finalUnexpectedBrowserErrors.length === 0, `${theme}: 새로고침 후 브라우저 오류: ${finalUnexpectedBrowserErrors.join(" | ")}`);
    await capture(page, theme, "reentry");

    return {
      theme,
      runbookReads: creationRunbookReads,
      boardReads: creationBoardReads,
      reentryRunbookReads: runbookReads,
      reentryBoardReads: boardReads,
      expectedProjection404s: browserErrors.length - finalUnexpectedBrowserErrors.length,
      checklistRecovered: true,
      boardRecovered: true,
      reentryRecovered: true,
      informationErrors: 0,
    };
  } catch (error) {
    console.error(JSON.stringify({
      theme,
      url: page.url(),
      browserErrors,
    }, null, 2));
    throw error;
  } finally {
    await context.close();
  }
}

async function preparePage(page: Page, theme: Theme, includeCreatedTaskWhen: () => boolean) {
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
  await installV3VisualQaRoutes(page, { includeCreatedTaskWhen });
}

async function fulfillJson(
  route: Route,
  body: unknown,
  status = 200,
) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function capture(page: Page, theme: Theme, state: string) {
  const output = path.join(outputRoot, theme);
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: path.join(output, `${state}.png`), animations: "disabled" });
}

async function delay(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

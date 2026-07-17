import type { Browser, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

type Mode = "before" | "after";
type Theme = "dark" | "light";

const mode = requiredVariant<Mode>(process.env.PR_CD_QA_MODE, ["before", "after"], "PR_CD_QA_MODE");
const theme = requiredVariant<Theme>(process.env.PR_CD_QA_THEME, ["dark", "light"], "PR_CD_QA_THEME");
const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_CD_QA_OUTPUT ?? path.join(".local", "artifacts", "screenshots", "pr-cd"),
);

const result = await runPlaywrightLifecycle({
  lockName: `pr-cd-default-context-${mode}-${theme}`,
  timeoutMs: 120_000,
  launchOptions: { headless: true, args: ["--disable-dev-shm-usage"] },
}, async ({ browser }) => verify(browser));

console.log(JSON.stringify({ ok: true, mode, theme, residualProcesses: 0, ...result }, null, 2));

async function verify(browser: Browser) {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  const taskOperations: Record<string, unknown>[] = [];
  let plannerTodayRequests = 0;
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/pages/task-beta/operations" && request.method() === "POST") {
      taskOperations.push(request.postDataJSON() as Record<string, unknown>);
    }
  });

  try {
    await preparePage(page);
    await installV3VisualQaRoutes(page, {
      contextChainPreview: true,
      taskDefaultAssignment: mode === "after",
      onPlannerTodayRequest: (count) => { plannerTodayRequests = count; },
    });
    const navigation = await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    console.log(JSON.stringify({ navigationStatus: navigation?.status() ?? null, navigationUrl: page.url() }));
    try {
      await page.getByTestId("v3-task-task-beta").waitFor({ state: "visible", timeout: 10_000 });
    } catch (cause) {
      console.error(JSON.stringify({ browserErrors, pageUrl: page.url() }));
      await page.screenshot({
        path: path.join(outputRoot, `${mode}-${theme}-diagnostic.png`),
        animations: "disabled",
        timeout: 5_000,
      }).catch(() => undefined);
      throw cause;
    }

    await page.getByRole("button", { name: "새 업무" }).click();
    await page.getByLabel("프로젝트 선택").selectOption("folder-dashboard");
    const preview = page.getByTestId("new-task-inheritance-preview");
    await waitForText(
      preview,
      mode === "after" ? "컨텍스트 · 대시보드" : "컨텍스트 미리보기 · 대시보드",
    );
    if (mode === "after") {
      await waitForText(page.getByTestId("inheritance-atom"), "atom");
      await waitForText(page.getByTestId("inheritance-defaults"), "기본 담당");
      const sourceAlignment = await page.getByTestId("inheritance-defaults").locator("small").evaluate((node) => ({
        marginLeft: getComputedStyle(node).marginLeft,
        textAlign: getComputedStyle(node).textAlign,
      }));
      assert(sourceAlignment.textAlign === "right", `상속 출처가 우측 정렬이 아닙니다: ${JSON.stringify(sourceAlignment)}`);
    }
    await capture(page, "01-context-preview");
    await page.getByRole("button", { name: "취소", exact: true }).click();

    await page.getByTestId("v3-task-task-beta").click();
    await page.locator(".v3-task-title-button").filter({ hasText: fixtureTitles.secondaryTask })
      .waitFor({ state: "visible", timeout: 30_000 });
    const information = page.locator('[data-task-section="information"]');
    const requestsBeforeSave = plannerTodayRequests;

    if (mode === "before") {
      const legacy = page.locator(".v3-session-defaults");
      await waitForText(legacy, "기본값: roselin_codex@eiaserinnys");
      assert(await information.getByRole("button", { name: "기본 담당 수정" }).count() === 0, "기존 화면에 편집 진입점이 있습니다.");
      await legacy.scrollIntoViewIfNeeded();
      await capture(page, "02-task-default");
    } else {
      await waitForText(information, "컨텍스트");
      const summary = information.getByRole("button", { name: "기본 담당 수정" });
      await waitForText(summary, "roselin_codex@eiaserinnys · 소울스트림에서 상속");
      await information.getByRole("button", { name: "컨텍스트 추가" }).waitFor({ state: "visible" });
      assert(await page.locator(".v3-session-defaults").count() === 0, "세션 영역의 중복 기본값 표기가 남았습니다.");
      await capture(page, "02-task-default-inherited");

      await summary.click();
      await information.getByLabel("노드 선택").waitFor({ state: "visible" });
      await information.getByLabel("에이전트 선택").waitFor({ state: "visible" });
      await capture(page, "03-task-default-editor");
      await information.getByRole("button", { name: "직접 지정", exact: true }).click();
      await waitForText(summary, "roselin_codex@eiaserinnys · 직접 지정");
      assert(plannerTodayRequests === requestsBeforeSave, `저장 뒤 planner 광역 재조회가 발생했습니다: ${requestsBeforeSave} → ${plannerTodayRequests}`);
      assert(taskOperations.length === 1, `업무 기본 담당 저장 요청 수가 다릅니다: ${taskOperations.length}`);
      const operations = taskOperations[0]?.operations;
      assert(Array.isArray(operations) && operations.length === 1, "저장이 단일 page operation이 아닙니다.");
      const operation = operations[0] as Record<string, unknown>;
      assert(operation.op === "create_block" && operation.block_type === "session_defaults", "기존 session_defaults 표면을 사용하지 않았습니다.");
      assert((operation.properties as Record<string, unknown>)?.scope === "session", "업무 직접 지정 scope가 session이 아닙니다.");
      await capture(page, "04-task-default-direct");
    }

    assert(browserErrors.length === 0, `브라우저 오류: ${browserErrors.join(" | ")}`);
    return { plannerTodayRequests, taskOperationCount: taskOperations.length, screenshotRoot: path.join(outputRoot, mode, theme) };
  } finally {
    await context.close();
  }
}

async function preparePage(page: Page) {
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
}

async function waitForText(locator: import("@playwright/test").Locator, text: string) {
  await locator.waitFor({ state: "visible", timeout: 20_000 });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if ((await locator.textContent())?.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`텍스트를 확인하지 못했습니다: ${text}`);
}

async function capture(page: Page, name: string) {
  const directory = path.join(outputRoot, mode, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: path.join(directory, `${name}.png`),
    animations: "disabled",
    fullPage: true,
  });
}

function requiredVariant<T extends string>(value: string | undefined, options: readonly T[], name: string): T {
  if (value && options.includes(value as T)) return value as T;
  throw new Error(`${name}은 ${options.join(" 또는 ")}여야 합니다.`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

import type { Browser, Locator, Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

type Theme = "dark" | "light";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_CN_QA_OUTPUT ?? path.join(".local", "artifacts", "screenshots", "pr-cn-planner-polish"),
);
const expectedDates = [
  "📅 7월 20일 월요일 (오늘)",
  "📅 7월 19일 일요일",
  "📅 7월 18일 토요일",
];

const result = await runPlaywrightLifecycle({
  lockName: "pr-cn-planner-polish",
  timeoutMs: 240_000,
  launchOptions: { headless: true, args: ["--disable-dev-shm-usage"] },
}, async ({ browser }) => {
  const themes = [];
  for (const theme of ["dark", "light"] as const) {
    themes.push({
      theme,
      desktop: await verifyDesktop(browser, theme),
      mobile: await verifyMobile(browser, theme),
    });
  }
  return { themes };
});

mkdirSync(outputRoot, { recursive: true });
writeFileSync(path.join(outputRoot, "metrics.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, outputRoot, residualProcesses: 0, ...result }, null, 2));

async function verifyDesktop(browser: Browser, theme: Theme) {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const errors = collectErrors(page);
  await preparePage(page, theme);

  try {
    await openPlanner(page);
    const dateLabels = await page.getByTestId("v3-navigation-scroll")
      .locator(".v3-nav-list").first().locator("button").evaluateAll(
        (buttons) => buttons.slice(0, 3).map((button) => Array.from(button.querySelectorAll("span"))
          .map((span) => span.textContent?.trim())
          .filter(Boolean)
          .join(" ")),
      );
    assert(JSON.stringify(dateLabels) === JSON.stringify(expectedDates), `날짜 표기가 다릅니다: ${JSON.stringify(dateLabels)}`);
    assert(await page.getByRole("heading", { name: "중요 작업", exact: true }).count() === 1, "중요 작업 제목이 없습니다.");
    assert(await page.getByText("★ 작업", { exact: true }).count() === 0, "이전 ★ 작업 제목이 남았습니다.");

    const toolbar = page.getByTestId("v3-global-toolbar");
    assert(await toolbar.getByRole("button", { name: "아침 정리", exact: true }).count() === 0, "아침 정리가 전역 툴바에 남았습니다.");
    assert(await toolbar.getByRole("button", { name: "새 업무", exact: true }).count() === 0, "새 업무가 전역 툴바에 남았습니다.");
    const dailyActions = {
      ritual: await compactCap(page.getByRole("button", { name: "아침 정리", exact: true })),
      newTask: await compactCap(page.getByRole("button", { name: "새 업무", exact: true })),
    };
    const dailyCenterOffsetPx = await horizontalCenterDelta(
      page.locator(".v3-planner-scroll > .v3-planner-column"),
      page.locator(".v3-planner-scroll"),
    );
    assert(await page.getByRole("heading", { name: "오늘 메모", exact: true }).count() === 0, "오늘 메모 제목이 남았습니다.");

    await page.getByTestId("v3-starred-tasks").locator(".v3-starred-task-link").first().click();
    await page.locator(".v3-detail-pane").waitFor({ state: "visible" });
    assert(await page.getByText("별표 페이지가 task 업무가 아닙니다", { exact: false }).count() === 0, "별표 업무 열기 오류가 재현됐습니다.");
    const detailPane = page.locator(".v3-detail-pane");
    const contextRow = detailPane.locator(".v3-context-row").first();
    const description = detailPane.locator(".v3-description-preview").first();
    await contextRow.waitFor({ state: "visible" });
    const cardBackgrounds = {
      context: await computedBackground(contextRow),
      description: await computedBackground(description),
    };
    assert(cardBackgrounds.context === cardBackgrounds.description, `컨텍스트 카드 배경이 다릅니다: ${JSON.stringify(cardBackgrounds)}`);

    await page.getByRole("button", { name: "새 세션", exact: true }).click();
    const sessionDialog = page.getByRole("dialog", { name: "새 세션", exact: true });
    await sessionDialog.waitFor({ state: "visible" });
    const sessionText = await sessionDialog.innerText();
    assert(!sessionText.includes("추가 지침"), "새 세션 창에 추가 지침이 남았습니다.");
    assert(await sessionDialog.getByRole("textbox", { name: "초기 지시" }).count() === 1, "초기 지시 입력이 없습니다.");
    assert(await sessionDialog.getByRole("button", { name: "파일 첨부", exact: true }).count() === 1, "초기 지시 파일 첨부가 없습니다.");
    await page.getByRole("button", { name: "승계 닫기" }).click();
    await page.getByRole("button", { name: "오늘 플래너로 돌아가기" }).click();

    await page.getByRole("button", { name: "아침 정리", exact: true }).click();
    const ritualDialog = page.getByRole("dialog", { name: "어제에서 넘어온 것", exact: true });
    await ritualDialog.waitFor({ state: "visible" });
    await ritualDialog.getByRole("button", { name: "오늘로 이월", exact: true }).waitFor({ state: "visible" });
    const ritualActions = await ritualDialog.locator(".v3-ritual-actions button").allTextContents();
    assert(JSON.stringify(ritualActions) === JSON.stringify(["오늘로 이월", "데일리에서 내리기"]), `아침 정리 액션이 다릅니다: ${JSON.stringify(ritualActions)}`);
    assert(!((await ritualDialog.textContent()) ?? "").includes("완료 처리"), "아침 정리에 완료 처리가 남았습니다.");
    await page.getByRole("button", { name: "아침 정리 닫기" }).click();

    await page.getByTestId("v3-all-projects")
      .getByRole("button", { name: fixtureTitles.project, exact: true }).click();
    await page.getByRole("heading", { name: fixtureTitles.project, exact: true }).waitFor({ state: "visible" });
    const projectColumn = page.locator(".v3-planner-scroll > .v3-planner-column");
    const plannerScroll = page.locator(".v3-planner-scroll");
    const centerDeltaPx = await horizontalCenterDelta(projectColumn, plannerScroll);
    const centerRelativeToDailyPx = Math.abs(centerDeltaPx - dailyCenterOffsetPx);
    assert(centerRelativeToDailyPx <= 0.2, `프로젝트와 데일리 중앙선 차이가 ${centerRelativeToDailyPx}px입니다.`);
    const projectNewTask = await compactCap(page.getByRole("button", { name: "새 업무", exact: true }));

    await capture(page, theme, "desktop");
    assert(errors.length === 0, `브라우저 오류: ${errors.join(" | ")}`);
    return {
      dateLabels,
      dailyActions,
      projectNewTask,
      dailyCenterOffsetPx,
      projectCenterOffsetPx: centerDeltaPx,
      projectCenterRelativeToDailyPx: centerRelativeToDailyPx,
      cardBackgrounds,
      sessionAttachmentVisible: true,
      ritualActions,
      browserErrors: errors.length,
    };
  } finally {
    await context.close();
  }
}

async function verifyMobile(browser: Browser, theme: Theme) {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  const errors = collectErrors(page);
  await preparePage(page, theme);

  try {
    await openPlanner(page);
    const actions = {
      ritual: await compactCap(page.getByRole("button", { name: "아침 정리", exact: true })),
      newTask: await compactCap(page.getByRole("button", { name: "새 업무", exact: true })),
    };
    const overflowPx = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(overflowPx <= 0, `모바일 가로 오버플로가 ${overflowPx}px입니다.`);
    await page.getByRole("button", { name: "아침 정리", exact: true }).click();
    const ritual = page.getByRole("dialog", { name: "어제에서 넘어온 것", exact: true });
    await ritual.waitFor({ state: "visible" });
    await ritual.getByRole("button", { name: "오늘로 이월", exact: true }).waitFor({ state: "visible" });
    const dialogBox = await ritual.boundingBox();
    assert(dialogBox !== null && dialogBox.width <= 390, `모바일 아침 정리 너비가 ${dialogBox?.width}px입니다.`);
    await capture(page, theme, "mobile");
    assert(errors.length === 0, `모바일 브라우저 오류: ${errors.join(" | ")}`);
    return { actions, overflowPx, ritualDialogWidth: dialogBox.width, browserErrors: errors.length };
  } finally {
    await context.close();
  }
}

async function preparePage(page: Page, theme: Theme) {
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
  await installV3VisualQaRoutes(page, { successionPickerRuns: true, contextChainPreview: true });
}

async function openPlanner(page: Page) {
  await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("v3-task-task-alpha").waitFor({ state: "visible", timeout: 30_000 });
}

async function compactCap(locator: Locator) {
  const metrics = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { width: box.width, height: box.height, radius: getComputedStyle(element).borderRadius };
  });
  assert(Math.abs(metrics.width - 28) <= 0.2, `compact cap 너비가 ${metrics.width}px입니다.`);
  assert(Math.abs(metrics.height - 28) <= 0.2, `compact cap 높이가 ${metrics.height}px입니다.`);
  assert(Number.parseFloat(metrics.radius) >= 14, `compact cap 반경이 ${metrics.radius}입니다.`);
  return metrics;
}

async function computedBackground(locator: Locator) {
  return locator.evaluate((element) => getComputedStyle(element).backgroundColor);
}

async function horizontalCenterDelta(subject: Locator, container: Locator) {
  const [subjectBox, containerBox] = await Promise.all([subject.boundingBox(), container.boundingBox()]);
  assert(subjectBox !== null && containerBox !== null, "중앙 정렬 좌표를 읽지 못했습니다.");
  return Math.round(Math.abs(
    subjectBox.x + subjectBox.width / 2 - (containerBox.x + containerBox.width / 2),
  ) * 100) / 100;
}

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  return errors;
}

async function capture(page: Page, theme: Theme, name: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), animations: "disabled", fullPage: true });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

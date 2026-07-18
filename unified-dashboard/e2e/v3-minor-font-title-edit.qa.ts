import type { Browser, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_AG_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-minor-font-title-edit"),
);

const result = await runPlaywrightLifecycle({
  lockName: "pr-ag-v3-minor-font-title-edit",
  timeoutMs: 120_000,
}, async ({ browser }) => {
  const dark = await verifyTheme(browser, "dark", true);
  const light = await verifyTheme(browser, "light", false);
  return { dark, light };
});

console.log(JSON.stringify({ ok: true, residualProcesses: 0, ...result }, null, 2));

async function verifyTheme(browser: Browser, theme: "dark" | "light", verifyFailure: boolean) {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error(`[pr-ag/qa] ${theme} page error · ${error.message}`));
  page.on("requestfailed", (request) => {
    console.error(`[pr-ag/qa] ${theme} request failed · ${request.url()} · ${request.failure()?.errorText ?? "unknown"}`);
  });
  await page.addInitScript({
    content: `
      localStorage.setItem("soul-dashboard-theme", ${JSON.stringify(theme)});
      localStorage.setItem("ls.webglGlass", "0");
      const serviceWorker = navigator.serviceWorker;
      if (serviceWorker) {
        Object.defineProperty(serviceWorker, "register", {
          configurable: true,
          value: async () => ({
            update: async () => undefined,
            active: null,
            installing: null,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
          }),
        });
        Object.defineProperty(serviceWorker, "controller", { configurable: true, get: () => null });
      }
    `,
  });
  await installV3VisualQaRoutes(page, { failTaskTitleRenameOnce: verifyFailure });

  try {
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v3-task-alpha").waitFor({ state: "visible" });
    await openPrimaryTask(page, fixtureTitles.primaryTask);

    const legacyOverride = await page.addStyleTag({ content: `
      .v3-run-open strong,
      .v3-run-open small {
        font-size: var(--font-size-xs) !important;
        line-height: 1.4 !important;
      }
    ` });
    const beforeFont = await runCardFontMetrics(page);
    await capture(page, theme, "01-font-before");
    await legacyOverride.dispose();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("v3-task-alpha").waitFor({ state: "visible" });
    await openPrimaryTask(page, fixtureTitles.primaryTask);

    const afterFont = await runCardFontMetrics(page);
    assertFontMetrics(afterFont);
    if (Number.parseFloat(afterFont.title) <= Number.parseFloat(beforeFont.title)) {
      throw new Error(`${theme} 제목 폰트가 커지지 않았습니다: ${beforeFont.title} → ${afterFont.title}`);
    }
    if (Number.parseFloat(afterFont.lastMessage) <= Number.parseFloat(beforeFont.lastMessage)) {
      throw new Error(`${theme} 마지막 메시지 폰트가 커지지 않았습니다: ${beforeFont.lastMessage} → ${afterFont.lastMessage}`);
    }
    await capture(page, theme, "02-font-after");

    if (verifyFailure) await verifyRenameFailure(page, theme);
    const renamedTitle = `${theme === "dark" ? "다크" : "라이트"} 업무 제목 왕복 QA`;
    await renameTitle(page, renamedTitle);
    await assertIdentityTitles(page, renamedTitle);
    await assertImmediateSurfaces(page, renamedTitle);
    await capture(page, theme, "03-title-renamed");

    await renameTitle(page, fixtureTitles.primaryTask);
    await assertIdentityTitles(page, fixtureTitles.primaryTask);
    await assertImmediateSurfaces(page, fixtureTitles.primaryTask);
    await capture(page, theme, "04-title-restored");

    return { beforeFont, afterFont, renameRoundtrip: true, failureRollback: verifyFailure };
  } finally {
    await context.close();
  }
}

async function openPrimaryTask(page: Page, title: string) {
  await page.getByTestId("v3-task-alpha").click();
  try {
    await taskTitleButton(page, title).waitFor({ state: "visible", timeout: 10_000 });
  } catch (error) {
    console.error(`[pr-ag/qa] 업무 진입 실패 URL · ${page.url()}`);
    console.error(`[pr-ag/qa] 업무 진입 실패 본문 · ${(await page.locator("body").textContent() ?? "").slice(0, 2_000)}`);
    await capture(page, "diagnostic", "task-open-failure");
    throw error;
  }
}

async function runCardFontMetrics(page: Page) {
  const card = page.locator(".v3-run-row").filter({ has: page.locator(".v3-run-open strong") }).first();
  await card.waitFor({ state: "visible" });
  return await card.evaluate((element) => {
    const title = element.querySelector(".v3-run-open strong");
    const agentNode = element.querySelector(".v3-run-agent-line");
    const lastMessage = element.querySelector(".v3-run-open small");
    const time = element.querySelector(".v3-run-trailing time");
    if (!(title instanceof HTMLElement)
      || !(agentNode instanceof HTMLElement)
      || !(lastMessage instanceof HTMLElement)
      || !(time instanceof HTMLElement)) throw new Error("run 카드 폰트 표면이 누락됐습니다.");
    return {
      title: getComputedStyle(title).fontSize,
      agentNode: getComputedStyle(agentNode).fontSize,
      lastMessage: getComputedStyle(lastMessage).fontSize,
      time: getComputedStyle(time).fontSize,
    };
  });
}

function assertFontMetrics(metrics: Awaited<ReturnType<typeof runCardFontMetrics>>) {
  const expected = { title: "14.5px", agentNode: "12px", lastMessage: "14px", time: "12px" };
  for (const [surface, value] of Object.entries(expected)) {
    const actual = metrics[surface as keyof typeof metrics];
    if (actual !== value) throw new Error(`${surface} 폰트가 v1 기준과 다릅니다: ${actual} !== ${value}`);
  }
}

async function verifyRenameFailure(page: Page, theme: string) {
  const failedTitle = `${theme} 실패 제목`;
  await page.getByRole("button", { name: "업무 제목 편집" }).click();
  const input = page.getByRole("textbox", { name: "업무 제목 편집" });
  await input.fill(failedTitle);
  await input.press("Enter");
  const alert = page.getByRole("alert");
  await alert.waitFor({ state: "visible" });
  if (!(await alert.textContent())?.includes("업무 제목 변경 실패")) throw new Error("rename 실패 오류가 표시되지 않았습니다.");
  if (await input.inputValue() !== failedTitle) throw new Error("rename 실패 후 편집 초안이 롤백 대신 유실됐습니다.");
  await assertIdentityTitles(page, fixtureTitles.primaryTask);
  await capture(page, theme, "02b-title-error-rollback");
  await input.press("Escape");
  await taskTitleButton(page, fixtureTitles.primaryTask).waitFor({ state: "visible" });
}

async function renameTitle(page: Page, title: string) {
  await page.getByRole("button", { name: "업무 제목 편집" }).click();
  const input = page.getByRole("textbox", { name: "업무 제목 편집" });
  await input.fill(title);
  await input.press("Enter");
  await taskTitleButton(page, title).waitFor({ state: "visible" });
}

function taskTitleButton(page: Page, title: string) {
  return page.locator(".v3-task-title-button").filter({ hasText: title });
}

async function assertIdentityTitles(page: Page, expected: string) {
  const titles = await page.evaluate(async () => {
    const [pageResponse, taskResponse] = await Promise.all([
      fetch("/api/pages/task-alpha"),
      fetch("/api/tasks/rb-alpha"),
    ]);
    const pagePayload = await pageResponse.json() as { page: { title: string } };
    const taskPayload = await taskResponse.json() as { task: { title: string } };
    return { page: pagePayload.page.title, task: taskPayload.task.title };
  });
  if (titles.page !== expected || titles.task !== expected) {
    throw new Error(`한 객체 rename 불일치: page=${titles.page}, task=${titles.task}, expected=${expected}`);
  }
}

async function assertImmediateSurfaces(page: Page, expected: string) {
  await page.getByRole("button", { name: "오늘 플래너로 돌아가기" }).click();
  const card = page.getByTestId("v3-task-alpha");
  await card.waitFor({ state: "visible" });
  if (!(await card.textContent())?.includes(expected)) throw new Error("업무 카드 제목이 즉시 갱신되지 않았습니다.");
  const starred = page.getByTestId("v3-starred-tasks");
  if (!(await starred.textContent())?.includes(expected)) throw new Error("별표 내비 제목이 즉시 갱신되지 않았습니다.");
  await openPrimaryTask(page, expected);
}

async function capture(page: Page, theme: string, name: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: path.join(directory, `${name}.png`),
    animations: "disabled",
    fullPage: true,
  });
}
